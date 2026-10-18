// Simple AI opponent. Uses the same validated actions as a human player.
const GD = require('../../shared/data');

const CONFIG = {
  easy:   { think: 1.6,  defMul: 0.75, sendChance: 0.2,  mines: 0, random: 0.5, reserve: 0.4,  sendGrowth: 0.6, safety: 1.0 },
  normal: { think: 0.9,  defMul: 1.0,  sendChance: 0.35, mines: 2, random: 0.2, reserve: 0.3,  sendGrowth: 0.9, safety: 1.15 },
  hard:   { think: 0.45, defMul: 1.3,  sendChance: 0.45, mines: 3, random: 0,   reserve: 0.25, sendGrowth: 1.2, safety: 1.3 },
  turtle: { think: 0.45, defMul: 1.1,  sendChance: 0,    mines: 3, random: 0,   reserve: 0.1,  sendGrowth: 1.2, safety: 1.3 }, // test only: never sends
  turtle0: { think: 0.45, defMul: 1.1, sendChance: 0,    mines: 0, random: 0,   reserve: 0.1,  sendGrowth: 1.2, safety: 1.3 }, // test only: no sends, no mines
};

class Bot {
  constructor(match, idx, difficulty) {
    this.m = match;
    this.idx = idx;
    this.cfg = CONFIG[difficulty] || CONFIG.normal;
    this.timer = 1 + Math.random();
    this.lastLives = GD.RULES.startLives;
    this.panic = 0;
    this.spots = rankSpots(match.map);
  }

  get b() { return this.m.boards[this.idx]; }

  update(dt) {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = this.cfg.think * (0.8 + Math.random() * 0.4);
    try { this.think(); } catch (e) { console.error('bot error', e); }
  }

  act(a) { return this.m.handleAction(this.idx, a).ok; }

  // Damage power, multiplied by up to two frost towers (slow = more time in range)
  power(extraFrost = 0) {
    let p = 0, frosts = extraFrost;
    for (const t of this.b.towers) { p += towerPower(t.stats); if (t.type === 'frost') frosts++; }
    return p * (1 + 0.35 * Math.min(2, frosts));
  }

  // Hit points currently on (or queued for) our board
  threat() {
    let hp = 0;
    for (const e of this.b.enemies) hp += e.hp + (GD.ENEMIES[e.type].hpTotal - GD.ENEMIES[e.type].hp) * e.hpMul;
    for (const q of this.b.queue) hp += GD.ENEMIES[q.type].hpTotal * q.hpMul;
    return hp;
  }

  need(round) {
    const base = 1.2 + 0.45 * Math.pow(round, 1.45);
    return Math.max(base, this.threat() / 11) * this.cfg.defMul * (1 + this.panic);
  }

  think() {
    const b = this.b;
    const round = Math.max(1, this.m.round);
    if (b.lives < this.lastLives) this.panic = Math.min(1.5, this.panic + 0.2);
    else this.panic = Math.max(0, this.panic - 0.01);
    this.lastLives = b.lives;

    const has = (fn) => b.towers.some(fn);
    // Hard requirements: armor and ghost answers
    if (round >= 8 && !has((t) => t.stats.pierceArmor)) { this.buy('cannon'); return; }
    if (round >= 6 && !has((t) => t.stats.detect)) { this.buy(this.has('sniper') ? 'sniper' : 'archerDetect'); return; }

    const power = this.power();
    if (power < this.need(round)) { this.improveDefense(); return; }

    // Economy: mines, then sends
    const mines = b.towers.filter((t) => t.type === 'mine');
    if (this.has('mine') && mines.length < Math.min(this.cfg.mines, 1 + Math.floor(round / 5)) && round >= 4) {
      if (this.buy('mine')) return;
    }
    if (power >= this.need(round) * this.cfg.safety && Math.random() < this.cfg.sendChance) {
      const packs = GD.SENDS.filter((s) => s.round <= round && s.cost <= b.gold * (1 - this.cfg.reserve));
      if (packs.length) {
        // Prefer good eco, occasionally a big pressure send
        const pick = Math.random() < 0.25 ? packs[packs.length - 1] : packs.reduce((x, y) => (y.eco / y.cost > x.eco / x.cost ? y : x));
        if (pick.eco > 0 || Math.random() < 0.3) { this.act({ type: 'send', pack: pick.id }); return; }
      }
    }
    // Spare gold: keep strengthening, a bit ahead of the curve
    if (b.gold > 1500 || (b.gold > 600 && power < this.need(round + 3 * this.cfg.sendGrowth))) this.improveDefense();
    for (const t of mines) {
      const u = GD.TOWERS.mine.upgrades[t.level];
      if (u && b.gold > u.cost + 300 && this.cfg.mines > 0) { this.act({ type: 'upgrade', id: t.id }); return; }
    }
  }

  has(type) { return this.m.players[this.idx].unlocked.includes(type); }

  improveDefense() {
    const b = this.b;
    const opts = [];
    const frosts = b.towers.filter((t) => t.type === 'frost').length;
    for (const type of ['archer', 'cannon', 'frost', 'sniper', 'tesla']) {
      if (!this.has(type)) continue;
      if (type === 'frost' && frosts >= 2) continue;
      if (type === 'sniper' && b.towers.filter((t) => t.type === 'sniper').length >= 3) continue;
      const cost = GD.TOWERS[type].cost;
      const gain = type === 'frost'
        ? (b.towers.length >= 3 ? this.power(1) - this.power() : 0)
        : towerPower(GD.towerStats(type, 0));
      if (gain > 0) opts.push({ kind: 'place', type, cost, gain });
    }
    for (const t of b.towers) {
      const u = GD.TOWERS[t.type].upgrades[t.level];
      if (!u || t.type === 'mine') continue;
      const gain = towerPower(GD.towerStats(t.type, t.level + 1)) - towerPower(t.stats);
      opts.push({ kind: 'upgrade', id: t.id, cost: u.cost, gain: gain * 1.1 });
    }
    if (!opts.length) return;
    opts.forEach((o) => { o.score = (o.gain / o.cost) * (1 + (Math.random() - 0.5) * this.cfg.random); });
    opts.sort((x, y) => y.score - x.score);
    const affordable = opts.filter((o) => o.cost <= b.gold);
    if (!affordable.length) return; // save up
    let best = affordable[0];
    // Save for a clearly better option only when not under pressure
    const urgent = this.panic > 0.1 || this.power() < 0.75 * this.need(Math.max(1, this.m.round));
    if (!urgent && opts[0] !== best && opts[0].score > best.score * 1.5) return;
    if (best.kind === 'place') this.buy(best.type);
    else this.act({ type: 'upgrade', id: best.id });
  }

  buy(type) {
    const b = this.b;
    if (type === 'archerDetect') {
      // No sniper: upgrade an archer to Eagle Eye, or place one
      const a = b.towers.find((t) => t.type === 'archer' && t.level < 3);
      if (a) return this.act({ type: 'upgrade', id: a.id });
      type = 'archer';
    }
    if (!this.has(type) || b.gold < GD.TOWERS[type].cost) return false;
    const range = GD.towerStats(type, 0).range;
    const list = type === 'mine' ? [...this.spots].reverse() : this.spots;
    const randomize = this.cfg.random > 0 ? Math.floor(Math.random() * 6 * this.cfg.random) : 0;
    let skipped = 0;
    for (const s of list) {
      if (b.occupied.has(s.col + ',' + s.row)) continue;
      if (type !== 'mine' && type !== 'sniper' && coverage(this.m.map, s.col + 0.5, s.row + 0.5, range) < 3) continue;
      if (skipped++ < randomize) continue;
      return this.act({ type: 'place', tower: type, col: s.col, row: s.row });
    }
    return false;
  }
}

function towerPower(s) {
  switch (s.kind) {
    case 'arrow': return s.dmg * s.rate * (s.targets || 1);
    case 'shot': return s.dmg * s.rate * 0.9;
    case 'bomb': return s.dmg * s.rate * 2.6 * s.splash;
    case 'chain': return s.dmg * s.rate * s.chains * 0.55;
    case 'pulse': return s.dmg * s.rate * 3;
    default: return 0;
  }
}

function coverage(map, x, y, range) {
  let n = 0;
  for (let d = 0; d < map.length; d += 0.25) {
    const p = GD.posAt(map, d);
    if (p.x < 0 || p.x > GD.COLS) continue;
    if ((p.x - x) ** 2 + (p.y - y) ** 2 <= range * range) n++;
  }
  return n;
}

function rankSpots(map) {
  const spots = [];
  for (let c = 0; c < GD.COLS; c++) {
    for (let r = 0; r < GD.ROWS; r++) {
      if (map.pathTiles.has(c + ',' + r)) continue;
      spots.push({ col: c, row: r, score: coverage(map, c + 0.5, r + 0.5, 2.6) });
    }
  }
  return spots.sort((a, b) => b.score - a.score);
}

module.exports = { Bot, towerPower };
