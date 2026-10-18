// Authoritative 1v1 match simulation. Each player defends their own board;
// natural rounds hit both boards equally, sends hit the opponent's board.
const GD = require('../../shared/data');
const { Bot } = require('./bot');

const R = GD.RULES;
const DT = 1 / R.tickRate;
const EI = Object.fromEntries(GD.ENEMY_ORDER.map((k, i) => [k, i]));
const TI = Object.fromEntries(GD.TOWER_ORDER.map((k, i) => [k, i]));
const MI = Object.fromEntries(GD.TARGET_MODES.map((k, i) => [k, i]));
const r2 = (v) => Math.round(v * 100) / 100;

let nextMatchId = 1;

class Match {
  /**
   * players: [{ uid?, name, level, unlocked:[], skin, banner, isBot?, difficulty? }] x2
   * onSnapshot(idx, snap), onEnd({ winner: idx|-1, reason })
   */
  constructor({ players, mapId, mode, onSnapshot, onEnd }) {
    this.id = 'm' + nextMatchId++;
    this.mode = mode;
    this.mapId = mapId || (GD.MAPS[process.env.FORCE_MAP] ? process.env.FORCE_MAP : pick(Object.keys(GD.MAPS)));
    this.map = GD.MAPS[this.mapId];
    this.players = players;
    this.onSnapshot = onSnapshot || (() => {});
    this.onEnd = onEnd || (() => {});
    this.time = -R.countdown;
    this.ticks = 0;
    this.state = 'countdown';
    this.round = 0;
    this.nextRoundAt = R.prepTime;
    this.nextIncomeAt = R.incomeInterval;
    this.boards = players.map((p, idx) => ({
      idx, lives: R.startLives, gold: R.startGold, income: R.startIncome,
      towers: [], enemies: [], queue: [], pending: [], events: [],
      nextId: 1, sendCursor: 0, occupied: new Set(), sendReady: {},
      connected: !!p.isBot, disconnectedAt: p.isBot ? null : 0,
      stats: { kills: 0, leaked: 0, sentGold: 0, towersBuilt: 0 },
    }));
    this.bots = players.map((p, i) => (p.isBot ? new Bot(this, i, p.difficulty) : null));
    this.result = null;
  }

  opp(idx) { return this.boards[1 - idx]; }

  // ---------------- main loop ----------------
  tick() {
    if (this.state === 'ended') return;
    this.time += DT;
    this.ticks++;
    if (this.time >= 0) {
      if (this.state === 'countdown') this.state = 'running';
      if (this.time >= this.nextRoundAt) {
        this.round++;
        this.spawnRound(this.round);
        this.nextRoundAt += R.roundTime;
      }
      if (this.time >= this.nextIncomeAt) {
        this.payIncome();
        this.nextIncomeAt += R.incomeInterval;
      }
      for (const b of this.boards) this.updateBoard(b);
      this.checkEnd();
    }
    if (this.state !== 'ended') {
      for (const bot of this.bots) if (bot) bot.update(DT);
      this.checkDisconnects();
    }
    if (this.ticks % R.snapEvery === 0 || this.state === 'ended') this.emitSnapshots();
  }

  spawnRound(r) {
    const groups = GD.roundWave(r);
    const hpMul = GD.hpMulForRound(r);
    for (const b of this.boards) {
      groups.forEach(([type, count], gi) => {
        const gap = Math.min(0.7, (R.spawnWindow - gi * 0.8) / Math.max(1, count));
        for (let i = 0; i < count; i++) {
          b.queue.push({ t: this.time + gi * 0.8 + i * gap, type, hpMul });
        }
      });
      b.queue.sort((a, c) => a.t - c.t);
    }
  }

  payIncome() {
    for (const b of this.boards) {
      let mineGold = 0;
      for (const t of b.towers) {
        if (t.stats.kind === 'mine') {
          mineGold += t.stats.gold;
          b.events.push(['m', t.id, t.stats.gold]);
        }
      }
      b.gold += b.income + mineGold;
    }
  }

  spawnEnemy(b, type, d, hpMul, sent) {
    const E = GD.ENEMIES[type];
    const hp = Math.max(1, Math.round(E.hp * hpMul));
    const p = GD.posAt(this.map, d);
    const e = { id: b.nextId++, type, d, hp, maxHp: hp, hpMul, sent: !!sent, slowUntil: 0, slowAmt: 0, x: p.x, y: p.y, dead: false };
    b.enemies.push(e);
    return e;
  }

  updateBoard(b) {
    while (b.queue.length && b.queue[0].t <= this.time) {
      const q = b.queue.shift();
      this.spawnEnemy(b, q.type, 0, q.hpMul, q.sent);
    }
    const len = this.map.length;
    for (let i = b.enemies.length - 1; i >= 0; i--) {
      const e = b.enemies[i];
      const E = GD.ENEMIES[e.type];
      let sp = E.speed;
      if (e.slowUntil > this.time) sp *= 1 - e.slowAmt;
      e.d += sp * DT;
      if (e.d >= len) {
        b.lives -= E.leakTotal;
        b.stats.leaked += E.leakTotal;
        b.enemies.splice(i, 1);
        continue;
      }
      const p = GD.posAt(this.map, e.d);
      e.x = p.x; e.y = p.y;
    }
    for (const t of b.towers) this.updateTower(b, t);
    if (b.enemies.some((e) => e.dead)) b.enemies = b.enemies.filter((e) => !e.dead);
    for (const s of b.pending) this.spawnEnemy(b, s.type, Math.max(0, s.d), s.hpMul, s.sent);
    b.pending.length = 0;
  }

  candidates(b, t, range) {
    const out = [];
    const r2r = range * range;
    for (const e of b.enemies) {
      if (e.dead) continue;
      if (e.x < 0 || e.x > GD.COLS || e.y < 0 || e.y > GD.ROWS) continue;
      if (GD.ENEMIES[e.type].ghost && !t.stats.detect) continue;
      const dx = e.x - t.x, dy = e.y - t.y;
      if (dx * dx + dy * dy <= r2r) out.push(e);
    }
    return out;
  }

  sortTargets(list, mode, t) {
    switch (mode) {
      case 'last': return list.sort((a, c) => a.d - c.d);
      case 'strong': return list.sort((a, c) => c.hp - a.hp || c.d - a.d);
      case 'close': return list.sort((a, c) => dist2(a, t) - dist2(c, t));
      default: return list.sort((a, c) => c.d - a.d);
    }
  }

  updateTower(b, t) {
    const s = t.stats;
    if (s.kind === 'mine') return;
    if (t.cd > 0) t.cd -= DT;
    if (t.cd > 0) return;
    const c = this.candidates(b, t, s.range);
    if (!c.length) return;
    t.cd += 1 / s.rate;
    if (t.cd < 0) t.cd = 0;
    switch (s.kind) {
      case 'arrow':
      case 'shot': {
        const list = this.sortTargets(c, t.target, t).slice(0, s.targets || 1);
        for (const e of list) {
          b.events.push([s.kind === 'arrow' ? 'a' : 's', t.id, r2(e.x), r2(e.y)]);
          this.damage(b, e, s.dmg, s.pierceArmor);
        }
        break;
      }
      case 'bomb': {
        const e = this.sortTargets(c, t.target, t)[0];
        const x = e.x, y = e.y, rr = s.splash * s.splash;
        b.events.push(['b', t.id, r2(x), r2(y), s.splash]);
        for (const o of b.enemies) {
          if (o.dead) continue;
          const dx = o.x - x, dy = o.y - y;
          if (dx * dx + dy * dy <= rr) this.damage(b, o, s.dmg, true);
        }
        break;
      }
      case 'pulse': {
        b.events.push(['p', t.id]);
        for (const e of c) {
          const E = GD.ENEMIES[e.type];
          const amt = s.slow * (1 - (E.slowResist || 0));
          if (amt >= e.slowAmt || e.slowUntil < this.time) e.slowAmt = amt;
          e.slowUntil = this.time + s.slowDur;
          if (s.dmg) this.damage(b, e, s.dmg, s.pierceArmor);
        }
        break;
      }
      case 'chain': {
        let cur = this.sortTargets(c, t.target, t)[0];
        const hit = new Set();
        const pts = [r2(cur.x), r2(cur.y)];
        for (let i = 0; i < s.chains && cur; i++) {
          hit.add(cur);
          this.damage(b, cur, s.dmg, s.pierceArmor);
          let best = null, bd = 1.6 * 1.6;
          for (const o of b.enemies) {
            if (o.dead || hit.has(o)) continue;
            if (GD.ENEMIES[o.type].ghost && !s.detect) continue;
            const dd = dist2(o, cur);
            if (dd <= bd) { bd = dd; best = o; }
          }
          if (best) pts.push(r2(best.x), r2(best.y));
          cur = best;
        }
        b.events.push(['c', t.id].concat(pts));
        break;
      }
    }
  }

  damage(b, e, dmg, pierce) {
    if (e.dead || dmg <= 0) return;
    const E = GD.ENEMIES[e.type];
    const d = pierce ? dmg : dmg - (E.armor || 0);
    if (d <= 0) return;
    e.hp -= d;
    if (e.hp <= 0) {
      e.dead = true;
      if (!e.sent) b.gold += E.bounty; // sent slimes pay no bounty, so sending is never a gift
      b.stats.kills++;
      (E.children || []).forEach((type, i) => b.pending.push({ type, d: e.d - 0.15 * i, hpMul: e.hpMul, sent: e.sent }));
    }
  }

  // ---------------- player actions ----------------
  handleAction(idx, a) {
    if (this.state === 'ended' || !a || typeof a !== 'object') return { ok: false, error: 'Match is over' };
    const b = this.boards[idx];
    switch (a.type) {
      case 'place': return this.place(idx, b, String(a.tower), a.col | 0, a.row | 0);
      case 'upgrade': return this.upgrade(b, a.id | 0);
      case 'sell': return this.sell(b, a.id | 0);
      case 'target': return this.setTarget(b, a.id | 0, String(a.mode));
      case 'send': return this.send(idx, b, String(a.pack));
      case 'power': return this.power(idx, b, a);
      default: return { ok: false, error: 'Unknown action' };
    }
  }

  place(idx, b, type, col, row) {
    const T = GD.TOWERS[type];
    if (!T) return { ok: false, error: 'Unknown tower' };
    if (!this.players[idx].unlocked.includes(type)) return { ok: false, error: 'Tower not unlocked' };
    if (col < 0 || col >= GD.COLS || row < 0 || row >= GD.ROWS) return { ok: false, error: 'Out of bounds' };
    const key = col + ',' + row;
    if (this.map.pathTiles.has(key)) return { ok: false, error: "Can't build on the path" };
    if (b.occupied.has(key)) return { ok: false, error: 'Tile taken' };
    if (b.towers.length >= R.maxTowers) return { ok: false, error: 'Tower limit reached' };
    if (T.limit && b.towers.filter((x) => x.type === type).length >= T.limit) return { ok: false, error: `Max ${T.limit} ${T.name}s` };
    if (b.gold < T.cost) return { ok: false, error: 'Not enough gold' };
    b.gold -= T.cost;
    const t = { id: b.nextId++, type, col, row, x: col + 0.5, y: row + 0.5, level: 0, cd: 0, target: 'first', stats: GD.towerStats(type, 0) };
    b.towers.push(t);
    b.occupied.add(key);
    b.stats.towersBuilt++;
    return { ok: true, id: t.id };
  }

  upgrade(b, id) {
    const t = b.towers.find((x) => x.id === id);
    if (!t) return { ok: false, error: 'No such tower' };
    const u = GD.TOWERS[t.type].upgrades[t.level];
    if (!u) return { ok: false, error: 'Fully upgraded' };
    if (b.gold < u.cost) return { ok: false, error: 'Not enough gold' };
    b.gold -= u.cost;
    t.level++;
    t.stats = GD.towerStats(t.type, t.level);
    return { ok: true };
  }

  sell(b, id) {
    const i = b.towers.findIndex((x) => x.id === id);
    if (i < 0) return { ok: false, error: 'No such tower' };
    const t = b.towers[i];
    b.gold += GD.sellValue(t.type, t.level);
    b.towers.splice(i, 1);
    b.occupied.delete(t.col + ',' + t.row);
    return { ok: true };
  }

  setTarget(b, id, mode) {
    const t = b.towers.find((x) => x.id === id);
    if (!t || !GD.TARGET_MODES.includes(mode)) return { ok: false, error: 'Invalid' };
    t.target = mode;
    return { ok: true };
  }

  send(idx, b, packId) {
    const pi = GD.SENDS.findIndex((s) => s.id === packId);
    const pack = GD.SENDS[pi];
    if (!pack) return { ok: false, error: 'Unknown send' };
    if (this.round < pack.round) return { ok: false, error: `Unlocks in round ${pack.round}` };
    if ((b.sendReady[pack.id] || 0) > this.time) return { ok: false, error: 'Send on cooldown' };
    if (b.gold < pack.cost) return { ok: false, error: 'Not enough gold' };
    b.sendReady[pack.id] = this.time + pack.cd;
    b.gold -= pack.cost;
    b.income += pack.eco;
    b.stats.sentGold += pack.cost;
    const o = this.opp(idx);
    const hpMul = GD.hpMulForRound(Math.max(1, this.round));
    o.sendCursor = Math.max(o.sendCursor, Math.max(0, this.time) + 0.5);
    for (let i = 0; i < pack.count; i++) {
      o.queue.push({ t: o.sendCursor, type: pack.enemy, hpMul, sent: true });
      o.sendCursor += pack.gap;
    }
    o.queue.sort((a, c) => a.t - c.t);
    o.events.push(['i', pi]);
    return { ok: true };
  }

  // ---------------- admin powers (only for players with cheats enabled) ----------------
  power(idx, b, a) {
    if (!this.players[idx].cheats) return { ok: false, error: 'You do not have powers' };
    const n = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Number(v) || 0)));
    const o = this.opp(idx);
    let done = true;
    switch (a.power) {
      case 'gold': b.gold = n(b.gold + n(a.amount, -1e7, 1e7), 0, 1e8); break;
      case 'lives': b.lives = n(b.lives + n(a.amount, -9999, 9999), 1, 99999); break;
      case 'income': b.income = n(b.income + n(a.amount, -1e5, 1e5), 0, 1e6); break;
      case 'spawn': {
        const type = String(a.enemy);
        if (!GD.ENEMIES[type]) return { ok: false, error: 'Unknown slime' };
        const count = n(a.count, 1, 300);
        const target = a.target === 'self' ? b : o;
        const hpMul = GD.hpMulForRound(Math.max(1, this.round));
        target.sendCursor = Math.max(target.sendCursor, Math.max(0, this.time) + 0.3);
        const gap = Math.max(0.08, Math.min(0.6, 0.8 / Math.sqrt(GD.ENEMIES[type].speed * 2)));
        for (let i = 0; i < count; i++) { target.queue.push({ t: target.sendCursor, type, hpMul, sent: true }); target.sendCursor += gap; }
        target.queue.sort((x, y) => x.t - y.t);
        break;
      }
      case 'round':
        if (this.time < 0) this.time = 0;
        this.nextRoundAt = this.time;
        break;
      case 'maxTower': {
        const t = b.towers.find((x) => x.id === (a.id | 0));
        if (!t) return { ok: false, error: 'Select one of your towers first' };
        t.level = GD.TOWERS[t.type].upgrades.length;
        t.stats = GD.towerStats(t.type, t.level);
        break;
      }
      case 'clear': { // remove every slime on your own board
        b.enemies = []; b.queue = b.queue.filter((q) => !q.sent);
        break;
      }
      default: done = false;
    }
    if (!done) return { ok: false, error: 'Unknown power' };
    if (!this.cheated) this.cheated = true;
    if (!this.cheatNotified) { this.cheatNotified = true; o.events.push(['x']); }
    return { ok: true };
  }

  // ---------------- connection / ending ----------------
  setConnected(idx, on) {
    const b = this.boards[idx];
    b.connected = on;
    b.disconnectedAt = on ? null : Date.now();
  }

  checkDisconnects() {
    for (const b of this.boards) {
      if (!b.connected && b.disconnectedAt && Date.now() - b.disconnectedAt > R.disconnectGrace * 1000) {
        return this.end(1 - b.idx, 'disconnect');
      }
    }
  }

  forfeit(idx) { if (this.state !== 'ended') this.end(1 - idx, 'forfeit'); }

  checkEnd() {
    const [a, c] = this.boards;
    if (a.lives > 0 && c.lives > 0) return;
    if (a.lives <= 0 && c.lives <= 0) {
      if (a.lives === c.lives) return this.end(-1, 'draw');
      return this.end(a.lives > c.lives ? 0 : 1, 'lives');
    }
    this.end(a.lives > 0 ? 0 : 1, 'lives');
  }

  end(winner, reason) {
    if (this.state === 'ended') return;
    this.state = 'ended';
    this.result = { winner, reason, round: this.round };
    this.emitSnapshots();
    this.onEnd(this.result);
  }

  // ---------------- networking ----------------
  boardSnap(b) {
    let mineGold = 0;
    for (const t of b.towers) if (t.stats.kind === 'mine') mineGold += t.stats.gold;
    return {
      lives: Math.max(0, b.lives),
      gold: b.gold,
      income: b.income,
      mine: mineGold,
      cds: GD.SENDS.map((p) => r2(Math.max(0, (b.sendReady[p.id] || 0) - this.time))),
      towers: b.towers.map((t) => [t.id, TI[t.type], t.col, t.row, t.level, MI[t.target]]),
      enemies: b.enemies.map((e) => [e.id, EI[e.type], Math.round(e.d * 100), Math.round((e.hp / e.maxHp) * 100), e.slowUntil > this.time ? 1 : 0]),
      ev: b.events,
    };
  }

  emitSnapshots() {
    const boards = this.boards.map((b) => this.boardSnap(b));
    for (const b of this.boards) b.events = [];
    const base = {
      t: r2(this.time), state: this.state, round: this.round,
      nextRound: r2(this.nextRoundAt - Math.max(0, this.time)),
      nextIncome: r2(this.nextIncomeAt - Math.max(0, this.time)),
    };
    for (let i = 0; i < 2; i++) {
      if (this.players[i].isBot) continue;
      const own = boards[i], other = Object.assign({}, boards[1 - i], { gold: null, cds: null });
      const snapBoards = i === 0 ? [own, other] : [other, own];
      this.onSnapshot(i, Object.assign({ boards: snapBoards }, base));
    }
  }
}

function dist2(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

module.exports = { Match, DT };
