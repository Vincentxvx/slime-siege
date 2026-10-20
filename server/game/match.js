// Authoritative 1v1 match simulation. Each player defends their own board;
// natural rounds hit both boards equally, sends hit the opponent's board.
const GD = require('../../shared/data');
const { Bot } = require('./bot');

const R = GD.RULES;
const SANDBOX_GOLD = 1e6; // the test field's gold is topped up to this every tick
const DT = 1 / R.tickRate;
const EI = Object.fromEntries(GD.ENEMY_ORDER.map((k, i) => [k, i]));
const TI = Object.fromEntries(GD.TOWER_ORDER.map((k, i) => [k, i]));
const MI = Object.fromEntries(GD.TARGET_MODES.map((k, i) => [k, i]));
const r2 = (v) => Math.round(v * 100) / 100;

let nextMatchId = 1;

class Match {
  /**
   * players: [{ uid?, name, level, unlocked:[], skin, banner, isBot?, difficulty?, idle? }] x2
   * onSnapshot(idx, snap), onEnd({ winner: idx|-1, reason })
   * sandbox: { cols, rows } makes a test field: player 0 alone (player 1 is an idle placeholder),
   *   no rounds, endless gold, every tower, slimes placed by hand that stand still
   */
  constructor({ players, mapId, mode, onSnapshot, onEnd, sandbox }) {
    this.id = 'm' + nextMatchId++;
    this.mode = mode;
    if (sandbox) {
      this.map = GD.sandboxMap(sandbox.cols, sandbox.rows);
      this.mapId = this.map.id;
      this.sandbox = { respawn: true, respawns: [] }; // dead placed slimes come back after a second
    } else {
      this.mapId = mapId || (GD.MAPS[process.env.FORCE_MAP] ? process.env.FORCE_MAP : pick(Object.keys(GD.MAPS)));
      this.map = GD.MAPS[this.mapId];
      // a custom map can be deleted between choosing it and the match starting: play a built-in map instead
      if (!Object.hasOwn(GD.MAPS, this.mapId)) { this.mapId = pick(GD.BUILTIN_MAPS); this.map = GD.MAPS[this.mapId]; }
    }
    this.players = players;
    this.onSnapshot = onSnapshot || (() => {});
    this.onEnd = onEnd || (() => {});
    this.time = -R.countdown;
    this.ticks = 0;
    this.state = 'picking';
    this.pickLeft = R.pickTime;
    // Tower selection: each player brings up to loadoutSize of their unlocked towers
    for (const p of players) {
      p.allTowers = p.unlocked.slice();
      p.loadout = [];
      p.ready = false;
      if (p.idle) { p.ready = true; }
      else if (p.isBot) { p.loadout = botLoadout(p.difficulty).filter((t) => p.allTowers.includes(t)); p.ready = true; }
      else if (sandbox || p.allTowers.length <= R.loadoutSize) { p.loadout = p.allTowers.slice(); p.ready = true; }
    }
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
    this.bots = players.map((p, i) => (p.isBot && !p.idle ? new Bot(this, i, p.difficulty) : null));
    this.result = null;
    if (sandbox) { // straight into play: no picking, no countdown; the round only sets slime strength
      for (const p of players) p.unlocked = p.loadout.slice();
      this.state = 'running';
      this.time = 0;
      this.round = 1;
      this.boards[0].gold = SANDBOX_GOLD; // endless from the start (topped up every tick)
    }
  }

  opp(idx) { return this.boards[1 - idx]; }

  // ---------------- main loop ----------------
  tick() {
    if (this.state === 'ended') return;
    if (this.sandbox) return this.sandboxTick();
    this.ticks++;
    if (this.state === 'picking') {
      this.pickLeft -= DT;
      if (this.pickLeft <= 0 || this.players.every((p) => p.ready)) this.finishPicking();
      else {
        this.checkDisconnects();
        if (this.ticks % R.snapEvery === 0) this.emitSnapshots();
        return;
      }
    }
    this.time += DT;
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

  // Test field: towers fire at the standing slimes; gold never runs out; placed slimes respawn
  sandboxTick() {
    this.ticks++;
    this.time += DT;
    const b = this.boards[0], sb = this.sandbox;
    b.gold = SANDBOX_GOLD;
    this.updateBoard(b);
    if (sb.respawns.some((r) => r.t <= this.time)) {
      const due = sb.respawns.filter((r) => r.t <= this.time);
      sb.respawns = sb.respawns.filter((r) => r.t > this.time);
      for (const r of due) {
        // not if a tower or another slime took the tile meanwhile
        if (b.occupied.has(r.tile) || b.enemies.some((e) => e.tile === r.tile)) continue;
        // a slime that split comes back only once its children are gone, so the field can't fill up
        if (b.enemies.some((e) => e.origin === r.tile)) { sb.respawns.push(Object.assign({}, r, { t: this.time + 0.25 })); continue; }
        this.spawnStill(b, r.type, r.x, r.y, r.tile);
      }
    }
    this.checkDisconnects();
    if (this.ticks % R.snapEvery === 0 || this.state === 'ended') this.emitSnapshots();
  }

  // a slime that stands still at x, y (tile: set for slimes placed by hand, which can respawn;
  // origin: the placed slime a split child came from). d = x, so First aims right and Last left, as on a map.
  spawnStill(b, type, x, y, tile, origin) {
    const hpMul = GD.hpMulForRound(this.round);
    const hp = Math.max(1, Math.round(GD.ENEMIES[type].hp * hpMul));
    const e = { id: b.nextId++, type, d: x + y * 0.001, hp, maxHp: hp, hpMul, sent: false, own: false, spd: 1, slowUntil: 0, slowAmt: 0, brittle: 0, brittleUntil: 0, rootUntil: 0, rootImmune: 0, lit: 0, x, y, dead: false, still: true, tile: tile || null, origin: origin || null };
    b.enemies.push(e);
    return e;
  }

  // place a standing slime on a tile, or remove the one placed there
  placeSlime(b, type, col, row) {
    if (!Object.hasOwn(GD.ENEMIES, type)) return { ok: false, error: 'Unknown slime' }; // own keys only
    if (col < 0 || col >= this.map.cols || row < 0 || row >= this.map.rows) return { ok: false, error: 'Out of bounds' };
    const tile = col + ',' + row;
    const sb = this.sandbox;
    const there = b.enemies.find((e) => e.tile === tile && !e.dead);
    if (there || sb.respawns.some((r) => r.tile === tile)) {
      if (there) b.enemies.splice(b.enemies.indexOf(there), 1);
      sb.respawns = sb.respawns.filter((r) => r.tile !== tile);
      return { ok: true, removed: true };
    }
    if (b.occupied.has(tile)) return { ok: false, error: 'A tower is on that tile' };
    if (b.enemies.length + sb.respawns.length >= GD.SANDBOX.maxSlimes) return { ok: false, error: `At most ${GD.SANDBOX.maxSlimes} slimes` };
    this.spawnStill(b, type, col + 0.5, row + 0.5, tile);
    return { ok: true };
  }

  // test field options: respawn on/off, slime strength (as in round N), clear slimes, reset damage counters
  sandboxAction(b, a) {
    const sb = this.sandbox;
    if (typeof a.respawn === 'boolean') { sb.respawn = a.respawn; if (!a.respawn) sb.respawns = []; }
    if (a.round !== undefined) {
      this.round = Math.max(1, Math.min(GD.SANDBOX.maxRound, Math.floor(Number(a.round) || 1)));
      for (const e of b.enemies) { // standing slimes take the new strength at full health
        e.hpMul = GD.hpMulForRound(this.round);
        e.maxHp = e.hp = Math.max(1, Math.round(GD.ENEMIES[e.type].hp * e.hpMul));
      }
    }
    if (a.clear) { b.enemies = []; b.pending = []; sb.respawns = []; }
    if (a.resetDamage) for (const t of b.towers) { t.dealt = 0; t.since = this.time; }
    return { ok: true };
  }

  finishPicking() {
    for (const p of this.players) {
      // fill empty slots with the player's other towers
      for (const t of p.allTowers) if (p.loadout.length < R.loadoutSize && !p.loadout.includes(t)) p.loadout.push(t);
      p.unlocked = p.loadout.slice();
      p.ready = true;
    }
    this.state = 'countdown';
    this.time = -R.countdown;
  }

  setLoadout(idx, a) {
    const p = this.players[idx];
    if (p.ready) return { ok: false, error: 'Your towers are locked in' };
    const list = Array.isArray(a.towers) ? [...new Set(a.towers.map(String))] : [];
    if (list.length > R.loadoutSize) return { ok: false, error: `Pick at most ${R.loadoutSize} towers` };
    if (list.some((t) => !p.allTowers.includes(t))) return { ok: false, error: "You haven't unlocked that tower" };
    const need = Math.min(R.loadoutSize, p.allTowers.length);
    if (a.ready && list.length < need) return { ok: false, error: `Pick ${need} towers first` };
    p.loadout = list;
    if (a.ready) p.ready = true;
    return { ok: true };
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

  // spd: speed multiplier for slimes sent with a Royal Brood hatchery (children keep it)
  // own: an admin spawned it into their own lane, so it counts as sent but wears no headband
  spawnEnemy(b, type, d, hpMul, sent, spd, own) {
    const E = GD.ENEMIES[type];
    const hp = Math.max(1, Math.round(E.hp * hpMul));
    const p = GD.posAt(this.map, d);
    const e = { id: b.nextId++, type, d, hp, maxHp: hp, hpMul, sent: !!sent, own: !!own, spd: spd || 1, slowUntil: 0, slowAmt: 0, brittle: 0, brittleUntil: 0, rootUntil: 0, rootImmune: 0, lit: 0, x: p.x, y: p.y, dead: false };
    b.enemies.push(e);
    return e;
  }

  updateBoard(b) {
    while (b.queue.length && b.queue[0].t <= this.time) {
      const q = b.queue.shift();
      this.spawnEnemy(b, q.type, 0, q.hpMul, q.sent, q.spd, q.own);
    }
    const len = this.map.length;
    for (let i = b.enemies.length - 1; i >= 0; i--) {
      const e = b.enemies[i];
      if (e.still) continue; // test field slimes stand where they were placed
      const E = GD.ENEMIES[e.type];
      let sp = E.speed * e.spd;
      if (e.slowUntil > this.time) sp *= 1 - e.slowAmt;
      if (e.rootUntil > this.time) sp *= E.slowResist || 0; // Bramble Snare: rooted (the King only half)
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
    // Glow Lanterns: ghosts inside the light can be targeted by every tower this tick
    for (const t of b.towers) {
      if (t.stats.kind !== 'light') continue;
      const rr = t.stats.range * t.stats.range;
      for (const e of b.enemies) if (dist2(e, t) <= rr) e.lit = this.ticks;
    }
    // curTower: whose shot is landing, for the test field's damage counters
    for (const t of b.towers) { this.curTower = t; this.updateTower(b, t); }
    this.curTower = null;
    if (b.enemies.some((e) => e.dead)) b.enemies = b.enemies.filter((e) => !e.dead);
    for (const s of b.pending) {
      if (s.still) this.spawnStill(b, s.type, s.x, s.y, null, s.origin);
      else this.spawnEnemy(b, s.type, Math.max(0, s.d), s.hpMul, s.sent, s.spd, s.own);
    }
    b.pending.length = 0;
  }

  // can a tower with these stats target this slime? (ghosts need detection or a Glow Lantern's light)
  visible(e, s) { return !GD.ENEMIES[e.type].ghost || !!s.detect || e.lit === this.ticks; }
  onBoard(e) { return e.x >= 0 && e.x <= this.map.cols && e.y >= 0 && e.y <= this.map.rows; }

  candidates(b, t, range) {
    const out = [];
    const r2r = range * range;
    for (const e of b.enemies) {
      if (e.dead || !this.onBoard(e) || !this.visible(e, t.stats)) continue;
      const dx = e.x - t.x, dy = e.y - t.y;
      if (dx * dx + dy * dy <= r2r) out.push(e);
    }
    return out;
  }

  // nearest other visible slime within 1.6 tiles (Tesla jumps, Goldspitter ricochets)
  nearestOther(b, from, s, skip) {
    let best = null, bd = 1.6 * 1.6;
    for (const o of b.enemies) {
      if (o.dead || skip.has(o) || !this.onBoard(o) || !this.visible(o, s)) continue;
      const dd = dist2(o, from);
      if (dd <= bd) { bd = dd; best = o; }
    }
    return best;
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
    if (s.kind === 'jar') t.charge = Math.min(s.charges, (t.charge || 0) + DT / s.chargeTime);
    if (!s.rate) return; // Gold Mines, Hatcheries and Lanterns before Flare don't attack
    if (t.cd > 0) t.cd -= DT;
    if (t.cd > 0) return;
    let c = this.candidates(b, t, s.range);
    if (s.ghostOnly) c = c.filter((e) => GD.ENEMIES[e.type].ghost);
    if (!c.length) return;
    if (s.kind === 'jar') { if (t.charge < 1) return; t.charge -= 1; } // one stored bolt per shot
    if (s.kind === 'coin') { // every Goldspitter shot is paid for; when broke it waits
      const cost = GD.shotCost(s, this.round);
      if (b.gold < cost) return;
      b.gold -= cost;
    }
    t.cd += 1 / s.rate;
    if (t.cd < 0) t.cd = 0;
    switch (s.kind) {
      case 'arrow':
      case 'shot': {
        const list = this.sortTargets(c, t.target, t).slice(0, s.targets || 1);
        const grow = s.growCap ? GD.growth(s, t.born, this.round) : 0; // Elder Sapling
        for (const e of list) {
          b.events.push([s.kind === 'arrow' ? 'a' : 's', t.id, r2(e.x), r2(e.y)]);
          // Hex Idol: a share of the slime's max HP, capped per hit
          const dmg = s.pct ? Math.min(s.maxHit, Math.max(s.dmg, Math.round(e.maxHp * s.pct))) : s.dmg + grow;
          this.damage(b, e, dmg, s.pierceArmor);
        }
        break;
      }
      case 'snare': { // Bramble Snare: roots slimes that aren't immune yet, extra thorns for fast ones
        // slimes that can be rooted first, then the rest (they still take thorn damage)
        const fresh = c.filter((e) => e.rootImmune <= this.time), immune = c.filter((e) => e.rootImmune > this.time);
        const list = this.sortTargets(fresh, t.target, t).concat(this.sortTargets(immune, t.target, t)).slice(0, s.targets || 1);
        for (const e of list) {
          b.events.push(['a', t.id, r2(e.x), r2(e.y)]);
          if (e.rootImmune <= this.time) { e.rootUntil = this.time + s.root; e.rootImmune = e.rootUntil + s.rootGap; }
          this.damage(b, e, s.dmg + (GD.ENEMIES[e.type].speed >= 4 ? s.fastBonus : 0), s.pierceArmor);
        }
        break;
      }
      case 'gaze': { // Basilisk Eye: petrifies weakened slimes that would split, otherwise a weak gaze
        const petrifiable = (e) => {
          if (!GD.ENEMIES[e.type].children) return false;
          const lim = e.type === 'king' ? s.executeKing : s.execute;
          return !!lim && e.hp <= e.maxHp * lim;
        };
        const sorted = this.sortTargets(c, t.target, t);
        const e = sorted.find(petrifiable) || sorted[0];
        b.events.push(['s', t.id, r2(e.x), r2(e.y)]);
        if (petrifiable(e)) {
          const at = { x: e.x, y: e.y };
          b.events.push(['b', t.id, r2(at.x), r2(at.y), 0.35]);
          this.damage(b, e, e.hp, true, true);
          if (s.shards) for (const o of b.enemies) if (!o.dead && dist2(o, at) <= 1) this.damage(b, o, s.shards, true);
        } else this.damage(b, e, s.dmg, s.pierceArmor);
        break;
      }
      case 'lance': { // Ballista: the bolt flies through the slimes on its line, up to `pierce`
        const aim = this.sortTargets(c, t.target, t)[0];
        const len = Math.hypot(aim.x - t.x, aim.y - t.y) || 1;
        const dx = (aim.x - t.x) / len, dy = (aim.y - t.y) / len;
        const hits = [];
        for (const e of b.enemies) {
          if (e.dead || !this.onBoard(e) || !this.visible(e, s)) continue;
          const px = e.x - t.x, py = e.y - t.y, along = px * dx + py * dy;
          if (along >= 0 && along <= s.range && Math.abs(px * dy - py * dx) <= 0.4) hits.push([along, e]);
        }
        hits.sort((p, q) => p[0] - q[0]);
        for (const [, e] of hits.slice(0, s.pierce)) this.damage(b, e, s.dmg, s.pierceArmor);
        b.events.push(['s', t.id, r2(t.x + dx * s.range), r2(t.y + dy * s.range)]);
        break;
      }
      case 'flame': { // Ember Drake: every slime in a cone towards the first target
        const aim = this.sortTargets(c, t.target, t)[0];
        const a0 = Math.atan2(aim.y - t.y, aim.x - t.x), half = (s.cone * Math.PI) / 360;
        b.events.push(['a', t.id, r2(aim.x), r2(aim.y)]);
        for (const e of c) {
          const da = Math.atan2(e.y - t.y, e.x - t.x) - a0;
          if (Math.abs(Math.atan2(Math.sin(da), Math.cos(da))) <= half) this.damage(b, e, s.dmg, s.pierceArmor);
        }
        break;
      }
      case 'coin': { // Goldspitter: one paid coin, Ricochet bounces it to a second slime
        const e = this.sortTargets(c, t.target, t)[0];
        const pts = [r2(e.x), r2(e.y)];
        const next = s.bounce ? this.nearestOther(b, e, s, new Set([e])) : null;
        this.damage(b, e, s.dmg, s.pierceArmor);
        if (next) { pts.push(r2(next.x), r2(next.y)); this.damage(b, next, s.dmg, s.pierceArmor); }
        b.events.push(['c', t.id].concat(pts));
        break;
      }
      case 'jar': { // Storm Jar: one stored bolt (taken above)
        const e = this.sortTargets(c, t.target, t)[0];
        b.events.push(['c', t.id, r2(e.x), r2(e.y)]);
        this.damage(b, e, s.dmg, s.pierceArmor);
        break;
      }
      case 'light': { // Glow Lantern flare: slimes in the light (ghosts only before Lighthouse)
        b.events.push(['p', t.id]);
        for (const e of c) this.damage(b, e, s.dmg, s.pierceArmor);
        break;
      }
      case 'bomb': {
        const e = this.sortTargets(c, t.target, t)[0];
        const x = e.x, y = e.y, rr = s.splash * s.splash;
        b.events.push(['b', t.id, r2(x), r2(y), s.splash]);
        for (const o of b.enemies) {
          if (o.dead) continue;
          const dx = o.x - x, dy = o.y - y;
          if (dx * dx + dy * dy > rr) continue;
          this.damage(b, o, s.dmg, true);
          if (s.slow && !o.dead) this.applySlow(o, s.slow, s.slowDur); // Cannon path B: concussion
        }
        break;
      }
      case 'pulse': {
        b.events.push(['p', t.id]);
        for (const e of c) {
          this.applySlow(e, s.slow, s.slowDur);
          // Frost path B: slimes it slows take more damage from every tower (the strongest Frost counts)
          if (s.brittle && (e.brittleUntil <= this.time || s.brittle >= e.brittle)) { // a weaker one doesn't extend a stronger
            e.brittle = s.brittle;
            e.brittleUntil = this.time + s.slowDur;
          }
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
          const best = this.nearestOther(b, cur, s, hit);
          if (best) pts.push(r2(best.x), r2(best.y));
          cur = best;
        }
        b.events.push(['c', t.id].concat(pts));
        break;
      }
    }
  }

  // slow a slime by `amount` for `dur` s (the King resists part of it). A weaker slow neither replaces nor
  // extends a stronger one that is still running (so Cannon B's 30% can't keep a Frost's 60% going).
  applySlow(e, amount, dur) {
    const amt = amount * (1 - (GD.ENEMIES[e.type].slowResist || 0));
    if (e.slowUntil <= this.time || amt >= e.slowAmt) { e.slowAmt = amt; e.slowUntil = this.time + dur; }
  }

  // petrify (Basilisk Eye): the slime dies without splitting into its children
  damage(b, e, dmg, pierce, petrify) {
    if (e.dead || dmg <= 0) return;
    const E = GD.ENEMIES[e.type];
    let d = pierce ? dmg : dmg - (E.armor || 0);
    if (d <= 0) return;
    if (e.brittleUntil > this.time) d = Math.round(d * (1 + e.brittle) * 100) / 100; // Frost path B: brittle (after armor)
    if (this.sandbox && this.curTower) this.curTower.dealt = (this.curTower.dealt || 0) + Math.min(d, e.hp); // no overkill
    e.hp -= d;
    e.hit = true; // took real damage since the last snapshot (the client flashes it)
    if (e.hp <= 1e-6) { // (brittle hits are fractional: no float crumbs left alive)
      e.dead = true;
      if (!e.sent) b.gold += E.bounty; // sent slimes pay no bounty, so sending is never a gift
      b.stats.kills++;
      const kids = petrify ? [] : E.children || [];
      if (e.still) { // test field: children stand around their parent; a placed slime comes back after a second
        const room = b.enemies.length + b.pending.length < 2 * GD.SANDBOX.maxSlimes; // hard ceiling
        if (room) kids.forEach((type, i) => b.pending.push({ type, still: true, x: e.x + (i - (kids.length - 1) / 2) * 0.3, y: e.y + 0.1, origin: e.tile || e.origin }));
        if (e.tile && this.sandbox.respawn) this.sandbox.respawns.push({ t: this.time + 1, type: e.type, x: e.x, y: e.y, tile: e.tile });
      } else kids.forEach((type, i) => b.pending.push({ type, d: e.d - 0.15 * i, hpMul: e.hpMul, sent: e.sent, spd: e.spd, own: e.own }));
    }
  }

  // ---------------- player actions ----------------
  handleAction(idx, a) {
    if (this.state === 'ended' || !a || typeof a !== 'object') return { ok: false, error: 'Match is over' };
    if (this.state === 'picking') {
      if (a.type === 'loadout') return this.setLoadout(idx, a);
      return { ok: false, error: 'Choose your towers first' };
    }
    if (a.type === 'loadout') return { ok: false, error: 'Towers are already chosen' };
    const b = this.boards[idx];
    if (this.sandbox) {
      if (idx !== 0) return { ok: false, error: 'Not your test field' };
      if (a.type === 'slime') return this.placeSlime(b, String(a.enemy), a.col | 0, a.row | 0);
      if (a.type === 'sandbox') return this.sandboxAction(b, a);
      if (a.type === 'send' || a.type === 'power') return { ok: false, error: 'Not in the test field' };
    } else if (a.type === 'slime' || a.type === 'sandbox') return { ok: false, error: 'Only in the test field' };
    switch (a.type) {
      case 'place': return this.place(idx, b, String(a.tower), a.col | 0, a.row | 0);
      case 'upgrade': return this.upgrade(b, a.id | 0, a.path === 'b' ? 'b' : 'a');
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
    if (col < 0 || col >= this.map.cols || row < 0 || row >= this.map.rows) return { ok: false, error: 'Out of bounds' };
    const key = col + ',' + row;
    if (this.map.pathTiles.has(key)) return { ok: false, error: "Can't build on the path" };
    if (b.occupied.has(key)) return { ok: false, error: 'Tile taken' };
    if (this.sandbox && b.enemies.some((e) => e.tile === key)) return { ok: false, error: 'A slime is on that tile' };
    // the test field has no placing limits (its board size is the only cap)
    if (!this.sandbox && b.towers.length >= R.maxTowers) return { ok: false, error: 'Tower limit reached' };
    if (!this.sandbox && T.limit && b.towers.filter((x) => x.type === type).length >= T.limit) return { ok: false, error: T.limit === 1 ? `Only 1 ${T.name} allowed` : `Max ${T.limit} ${T.name}s` };
    if (b.gold < T.cost) return { ok: false, error: 'Not enough gold' };
    b.gold -= T.cost;
    // dealt/since: damage counter for the test field. There an Elder Sapling grows as if planted at the
    // start (born 0), so its growth follows the round setting whether that was set before or after building.
    const t = { id: b.nextId++, type, col, row, x: col + 0.5, y: row + 0.5, level: 0, cd: 0, target: T.defaultTarget || 'first', born: this.sandbox ? 0 : this.round, stats: GD.towerStats(type, 0), dealt: 0, since: this.time };
    b.towers.push(t);
    b.occupied.add(key);
    b.stats.towersBuilt++;
    return { ok: true, id: t.id };
  }

  // path: which upgrade path to take at the fork (towers with a branch, see GD.upgradeList); ignored elsewhere
  upgrade(b, id, path) {
    const t = b.towers.find((x) => x.id === id);
    if (!t) return { ok: false, error: 'No such tower' };
    const p = GD.TOWERS[t.type].branch && t.level === GD.FORK ? path : t.path;
    const u = GD.upgradeList(t.type, p)[t.level];
    if (!u) return { ok: false, error: 'Fully upgraded' };
    if (b.gold < u.cost) return { ok: false, error: 'Not enough gold' };
    b.gold -= u.cost;
    t.path = p;
    t.level++;
    t.stats = GD.towerStats(t.type, t.level, t.path);
    return { ok: true };
  }

  sell(b, id) {
    const i = b.towers.findIndex((x) => x.id === id);
    if (i < 0) return { ok: false, error: 'No such tower' };
    const t = b.towers[i];
    b.gold += GD.sellValue(t.type, t.level, t.path);
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
    // Slime Hatchery: more slimes per pack, shorter cooldowns, tougher and faster slimes (cost and income unchanged)
    const nest = b.towers.find((x) => x.stats.kind === 'nest');
    const ns = nest ? nest.stats : {};
    // +20% per pack on average: the leftover fraction carries over to the next send of that pack
    let bonus = 0;
    if (nest) {
      b.sendCarry = b.sendCarry || {};
      const carry = (b.sendCarry[pack.id] || 0) + pack.count * ns.extra;
      bonus = Math.floor(carry + 1e-9);
      b.sendCarry[pack.id] = carry - bonus;
    }
    const count = pack.count + bonus;
    b.sendReady[pack.id] = this.time + pack.cd * (ns.cdMul || 1);
    b.gold -= pack.cost;
    b.income += pack.eco;
    b.stats.sentGold += pack.cost;
    const o = this.opp(idx);
    const hpMul = GD.hpMulForRound(Math.max(1, this.round)) * (1 + (ns.hpBonus || 0));
    o.sendCursor = Math.max(o.sendCursor, Math.max(0, this.time) + 0.5);
    for (let i = 0; i < count; i++) {
      o.queue.push({ t: o.sendCursor, type: pack.enemy, hpMul, sent: true, spd: ns.spd });
      o.sendCursor += pack.gap;
    }
    o.queue.sort((a, c) => a.t - c.t);
    o.events.push(['i', pi, count]);
    if (nest) b.events.push(['p', nest.id, bonus]);
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
        if (!Object.hasOwn(GD.ENEMIES, type)) return { ok: false, error: 'Unknown slime' }; // own keys only
        const count = n(a.count, 1, 300);
        const target = a.target === 'self' ? b : o;
        const hpMul = GD.hpMulForRound(Math.max(1, this.round));
        target.sendCursor = Math.max(target.sendCursor, Math.max(0, this.time) + 0.3);
        const gap = Math.max(0.08, Math.min(0.6, 0.8 / Math.sqrt(GD.ENEMIES[type].speed * 2)));
        for (let i = 0; i < count; i++) { target.queue.push({ t: target.sendCursor, type, hpMul, sent: true, own: target === b }); target.sendCursor += gap; }
        target.queue.sort((x, y) => x.t - y.t);
        break;
      }
      case 'round':
        if (this.state === 'picking') return { ok: false, error: 'Wait until towers are chosen' };
        if (this.time < 0) this.time = 0;
        this.nextRoundAt = this.time;
        break;
      case 'maxTower': {
        const t = b.towers.find((x) => x.id === (a.id | 0));
        if (!t) return { ok: false, error: 'Select one of your towers first' };
        t.level = GD.upgradeList(t.type, t.path).length; // keeps a path already chosen, else path A
        t.stats = GD.towerStats(t.type, t.level, t.path);
        break;
      }
      case 'clear': { // remove every slime on your own board
        b.enemies = []; b.queue = b.queue.filter((q) => !q.sent);
        b.sendCursor = 0; // no sent slimes are queued any more, so the opponent's next send arrives on time
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
      // 7th tower field: Storm Jar stored charges, Elder Sapling growth before its cap (the client caps it per level)
      // test field towers then add [damage dealt, seconds counted] for their damage per second
      towers: b.towers.map((t) => {
        const tw = [t.id, TI[t.type], t.col, t.row, t.level, MI[t.target],
          t.stats.kind === 'jar' ? Math.floor(t.charge || 0) : t.stats.growCap ? Math.floor(Math.max(0, this.round - t.born) / t.stats.growEvery) : 0,
          t.path === 'b' ? 1 : 0]; // 8th field: upgrade path B
        if (this.sandbox) tw.push(Math.round(t.dealt), r2(this.time - t.since));
        return tw;
      }),
      // 5th slime field: 1 slowed by Frost, 2 rooted by a Bramble Snare; 6th: sent by a player (headband)
      // standing test field slimes add [x*100, y*100, hp] (they have no place on a path)
      enemies: b.enemies.map((e) => {
        const en = [e.id, EI[e.type], Math.round(e.d * 100), Math.round((e.hp / e.maxHp) * 100), e.rootUntil > this.time ? 2 : e.slowUntil > this.time ? 1 : 0, e.sent && !e.own ? 1 : 0, e.hit ? 1 : 0];
        if (e.still) en.push(Math.round(e.x * 100), Math.round(e.y * 100), Math.max(0, Math.ceil(e.hp)));
        return en;
      }),
      ev: b.events,
    };
  }

  emitSnapshots() {
    const boards = this.boards.map((b) => this.boardSnap(b));
    for (const b of this.boards) { b.events = []; for (const e of b.enemies) e.hit = false; }
    const base = {
      t: r2(this.time), state: this.state, round: this.round,
      nextRound: r2(this.nextRoundAt - Math.max(0, this.time)),
      nextIncome: r2(this.nextIncomeAt - Math.max(0, this.time)),
    };
    if (this.state === 'picking') base.pickLeft = r2(Math.max(0, this.pickLeft));
    else base.loadouts = this.players.map((p) => p.loadout);
    if (this.sandbox) base.sandbox = { respawn: this.sandbox.respawn };
    for (let i = 0; i < 2; i++) {
      if (this.players[i].isBot) continue;
      const own = boards[i], other = Object.assign({}, boards[1 - i], { gold: null, cds: null });
      const snapBoards = i === 0 ? [own, other] : [other, own];
      const extra = { boards: snapBoards };
      if (this.state === 'picking') {
        const me = this.players[i], op = this.players[1 - i];
        extra.pick = { mine: me.loadout, ready: me.ready, oppReady: op.ready, choices: me.allTowers };
      }
      this.onSnapshot(i, Object.assign(extra, base));
    }
  }
}

// Towers bots bring (they need an armor answer and a ghost answer)
function botLoadout(difficulty) {
  if (difficulty === 'hard') return ['cannon', 'sniper', 'tesla', 'mine'];
  if (difficulty === 'easy') return ['archer', 'cannon', 'frost', 'sniper'];
  return ['archer', 'cannon', 'sniper', 'mine'];
}

function dist2(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

module.exports = { Match, DT };
