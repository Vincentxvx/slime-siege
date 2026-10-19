// Shared game data — loaded by the server (require) and the browser (<script>, exposes window.GD).
// Balance tweaks go here: towers, slimes, sends, rounds, progression, cosmetics.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GD = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const COLS = 16, ROWS = 11;

  const RULES = {
    tickRate: 20,          // simulation ticks per second
    snapEvery: 2,          // send a snapshot every N ticks (10/s)
    countdown: 3,          // seconds before the match clock starts
    pickTime: 20,          // seconds to choose your towers at the start of a match
    loadoutSize: 4,        // towers you can bring into a match
    startLives: 100,
    startGold: 650,
    startIncome: 75,       // gold paid every incomeInterval
    incomeInterval: 6,
    prepTime: 8,           // seconds until round 1
    roundTime: 20,
    spawnWindow: 12,       // natural waves spawn within this many seconds
    sellRefund: 0.7,
    maxTowers: 60,
    hpRampRound: 18,       // after this round slimes get tougher every round
    hpRampPerRound: 0.12,
    disconnectGrace: 25,   // seconds a player may be disconnected before forfeiting
    earlyEndRound: 5,      // matches ending by forfeit before this round don't count
  };

  // ---------- Maps (tile coordinates; path starts and ends off-board) ----------
  const MAP_DEFS = {
    meadow: {
      name: 'Meadow',
      path: [[-1, 1], [4, 1], [4, 8], [8, 8], [8, 2], [12, 2], [12, 9], [16, 9]],
      theme: { ground: ['#6aa84f', '#64a04a'], path: '#e3c48a', edge: '#b9945c', deco: 'grass' },
    },
    canyon: {
      name: 'Canyon',
      path: [[-1, 9], [3, 9], [3, 2], [7, 2], [7, 6], [10, 6], [10, 1], [14, 1], [14, 8], [16, 8]],
      theme: { ground: ['#d39a63', '#cc935c'], path: '#8c5d3f', edge: '#6b432c', deco: 'rocks' },
    },
    glacier: {
      name: 'Glacier',
      path: [[-1, 3], [2, 3], [2, 8], [6, 8], [6, 4], [9, 4], [9, 9], [13, 9], [13, 2], [16, 2]],
      theme: { ground: ['#e3edf5', '#d9e5f0'], path: '#93b7d3', edge: '#6a8fae', deco: 'snow' },
    },
  };

  function buildMap(id, def) {
    const pts = def.path.map(([c, r]) => [c + 0.5, r + 0.5]);
    const segs = [];
    let total = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
      const len = Math.hypot(x2 - x1, y2 - y1);
      segs.push({ x1, y1, x2, y2, len, start: total, dx: (x2 - x1) / len, dy: (y2 - y1) / len });
      total += len;
    }
    const tiles = new Set();
    for (let i = 0; i < def.path.length - 1; i++) {
      const [c1, r1] = def.path[i], [c2, r2] = def.path[i + 1];
      const sc = Math.sign(c2 - c1), sr = Math.sign(r2 - r1);
      let c = c1, r = r1;
      for (;;) {
        if (c >= 0 && c < COLS && r >= 0 && r < ROWS) tiles.add(c + ',' + r);
        if (c === c2 && r === r2) break;
        c += sc; r += sr;
      }
    }
    return Object.assign({ id, segs, length: total, pathTiles: tiles }, def);
  }

  const MAPS = {};
  for (const id in MAP_DEFS) MAPS[id] = buildMap(id, MAP_DEFS[id]);
  const BUILTIN_MAPS = Object.keys(MAP_DEFS);
  const THEMES = { meadow: MAP_DEFS.meadow.theme, canyon: MAP_DEFS.canyon.theme, glacier: MAP_DEFS.glacier.theme };

  // Custom maps (map editor): path is a list of tile corners, starting at column -1 and ending at column COLS.
  function validatePath(path) {
    if (!Array.isArray(path) || path.length < 3 || path.length > 42) return 'A path needs 1 to 40 corner points';
    for (const p of path) if (!Array.isArray(p) || p.length !== 2 || !Number.isInteger(p[0]) || !Number.isInteger(p[1])) return 'Invalid point';
    const first = path[0], second = path[1], last = path[path.length - 1], beforeLast = path[path.length - 2];
    if (first[0] !== -1 || second[0] < 0 || first[1] !== second[1]) return 'The path must start on the left edge';
    if (last[0] !== COLS || beforeLast[0] >= COLS || last[1] !== beforeLast[1]) return 'The path must end on the right edge';
    for (let i = 1; i < path.length - 1; i++) {
      const [c, r] = path[i];
      if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return 'Points must be on the board';
    }
    const seen = new Set();
    let len = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const [c1, r1] = path[i], [c2, r2] = path[i + 1];
      if ((c1 !== c2 && r1 !== r2) || (c1 === c2 && r1 === r2)) return 'Each step must go straight across or straight down';
      const sc = Math.sign(c2 - c1), sr = Math.sign(r2 - r1);
      let c = c1 + sc, r = r1 + sr;
      for (;;) {
        if (c >= 0 && c < COLS) {
          const k = c + ',' + r;
          if (seen.has(k)) return 'The path crosses or touches itself';
          seen.add(k);
        }
        len++;
        if (c === c2 && r === r2) break;
        c += sc; r += sr;
      }
    }
    if (len < 22) return 'The path is too short (at least 22 tiles)';
    return null;
  }
  function registerMap(id, def) { MAPS[id] = buildMap(id, def); return MAPS[id]; }

  function posAt(map, d) {
    const segs = map.segs;
    if (d <= 0) { const s = segs[0]; return { x: s.x1, y: s.y1, dx: s.dx, dy: s.dy }; }
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (d <= s.start + s.len) {
        const f = d - s.start;
        return { x: s.x1 + s.dx * f, y: s.y1 + s.dy * f, dx: s.dx, dy: s.dy };
      }
    }
    const s = segs[segs.length - 1];
    return { x: s.x2, y: s.y2, dx: s.dx, dy: s.dy };
  }

  // ---------- Slimes ----------
  // speed in tiles/second, r = draw radius in tiles, children spawn on death
  const ENEMIES = {
    green:   { name: 'Green Slime',  hp: 1,   speed: 2.3, bounty: 1,  leak: 1,  r: 0.24, color: '#7bd94f' },
    blue:    { name: 'Blue Slime',   hp: 2,   speed: 2.9, bounty: 2,  leak: 2,  r: 0.26, color: '#3fa9f5' },
    yellow:  { name: 'Zippy Slime',  hp: 2,   speed: 4.4, bounty: 2,  leak: 2,  r: 0.22, color: '#ffd23f' },
    purple:  { name: 'Big Slime',    hp: 8,   speed: 1.9, bounty: 3,  leak: 3,  r: 0.33, color: '#a368f0', children: ['blue', 'blue'] },
    ghost:   { name: 'Ghost Slime',  hp: 4,   speed: 2.6, bounty: 3,  leak: 3,  r: 0.27, color: '#e6ebff', ghost: true },
    armored: { name: 'Knight Slime', hp: 14,  speed: 1.6, bounty: 4,  leak: 4,  r: 0.34, color: '#8f99a8', armor: 2, children: ['purple'] },
    king:    { name: 'Slime King',   hp: 400, speed: 0.8, bounty: 50, leak: 30, r: 0.55, color: '#e0457b', armor: 3, slowResist: 0.5, children: ['armored', 'armored', 'armored'] },
  };
  const ENEMY_ORDER = Object.keys(ENEMIES);

  function leakValue(type) {
    const e = ENEMIES[type];
    let v = e.leak;
    for (const c of e.children || []) v += leakValue(c);
    return v;
  }
  function hpValue(type) {
    const e = ENEMIES[type];
    let v = e.hp;
    for (const c of e.children || []) v += hpValue(c);
    return v;
  }
  for (const k of ENEMY_ORDER) { ENEMIES[k].leakTotal = leakValue(k); ENEMIES[k].hpTotal = hpValue(k); }

  // ---------- Towers ----------
  // kinds: arrow (multi single-target), bomb (splash), pulse (slow aura), shot (sniper), chain (lightning), mine (gold)
  const TOWERS = {
    archer: {
      name: 'Archer', cost: 170, desc: 'Cheap, quick single-target shots.',
      base: { kind: 'arrow', range: 3.0, rate: 1.6, dmg: 1, targets: 1 },
      unlock: { coins: 0, level: 1 },
      upgrades: [
        { name: 'Sharp Arrows', cost: 120, desc: '+1 damage', add: { dmg: 1 } },
        { name: 'Quick Draw', cost: 220, desc: '+50% attack speed', mul: { rate: 1.5 } },
        { name: 'Eagle Eye', cost: 450, desc: '3 targets, +range, sees ghosts', set: { targets: 3, detect: true }, add: { range: 0.8 } },
      ],
    },
    cannon: {
      name: 'Cannon', cost: 380, desc: 'Splash damage. Ignores armor.',
      base: { kind: 'bomb', range: 2.6, rate: 0.7, dmg: 2, splash: 1.0, pierceArmor: true },
      unlock: { coins: 0, level: 1 },
      upgrades: [
        { name: 'Bigger Bombs', cost: 200, desc: '+1 damage, bigger blast', add: { dmg: 1, splash: 0.4 } },
        { name: 'Rapid Reload', cost: 350, desc: '+60% attack speed', mul: { rate: 1.6 } },
        { name: 'Heavy Shells', cost: 700, desc: '+4 damage', add: { dmg: 4 } },
      ],
    },
    frost: {
      name: 'Frost', cost: 260, desc: 'Pulses that slow every slime in range.',
      base: { kind: 'pulse', range: 2.2, rate: 0.8, dmg: 0, slow: 0.4, slowDur: 1.5 },
      unlock: { coins: 0, level: 1 },
      upgrades: [
        { name: 'Deep Freeze', cost: 180, desc: 'Slow 40% → 60%', set: { slow: 0.6 } },
        { name: 'Frostbite', cost: 300, desc: 'Pulses deal 1 damage', add: { dmg: 1 } },
        { name: 'Glacier', cost: 500, desc: '+range, +1 damage, sees ghosts', add: { range: 0.8, dmg: 1 }, set: { detect: true } },
      ],
    },
    sniper: {
      name: 'Sniper', cost: 320, desc: 'Hits anywhere on the map. Sees ghosts.',
      base: { kind: 'shot', range: 99, rate: 0.6, dmg: 5, detect: true },
      unlock: { coins: 250, level: 2 },
      upgrades: [
        { name: 'Hollow Points', cost: 250, desc: '+5 damage', add: { dmg: 5 } },
        { name: 'Bolt Action', cost: 400, desc: '+80% attack speed', mul: { rate: 1.8 } },
        { name: 'Armor Breaker', cost: 800, desc: '+10 damage, ignores armor', add: { dmg: 10 }, set: { pierceArmor: true } },
      ],
    },
    mine: {
      name: 'Gold Mine', cost: 600, desc: 'Pays extra gold every income tick. Max 3.', limit: 3,
      base: { kind: 'mine', range: 0, gold: 30 },
      unlock: { coins: 400, level: 3 },
      upgrades: [
        { name: 'Deeper Shafts', cost: 500, desc: '+25 gold per tick', add: { gold: 25 } },
        { name: 'Gold Veins', cost: 900, desc: '+40 gold per tick', add: { gold: 40 } },
        { name: 'Mother Lode', cost: 1600, desc: '+70 gold per tick', add: { gold: 70 } },
      ],
    },
    tesla: {
      name: 'Tesla Coil', cost: 520, desc: 'Lightning chains between slimes. Ignores armor.',
      base: { kind: 'chain', range: 2.5, rate: 1.0, dmg: 2, chains: 4, detect: true, pierceArmor: true },
      unlock: { coins: 600, level: 4 },
      upgrades: [
        { name: 'Arc Coil', cost: 300, desc: '+3 chain jumps', add: { chains: 3 } },
        { name: 'Overcharge', cost: 550, desc: '+2 damage', add: { dmg: 2 } },
        { name: 'Storm Core', cost: 1000, desc: '+80% speed, +3 jumps', mul: { rate: 1.8 }, add: { chains: 3 } },
      ],
    },
    // ----- added later: keep new towers at the end so tower numbers in snapshots stay the same -----
    lantern: {
      name: 'Glow Lantern', cost: 200, desc: 'Lights up ghosts so all your towers can hit them.',
      base: { kind: 'light', range: 2.4 }, // range = light radius; it only attacks after Flare
      unlock: { coins: 200, level: 2 },
      upgrades: [
        { name: 'Bright Wick', cost: 120, desc: 'Bigger light', add: { range: 0.8 } },
        { name: 'Flare', cost: 280, desc: 'Flares hit ghosts in the light for 2', set: { rate: 0.67, dmg: 2, ghostOnly: true } },
        { name: 'Lighthouse', cost: 600, desc: '+light, flares hit every slime and ignore armor', add: { range: 1.0 }, set: { ghostOnly: false, pierceArmor: true } },
      ],
    },
    hex: {
      name: 'Hex Idol', cost: 450, desc: 'Curses the strongest slime for a share of its max HP. Ignores armor.',
      base: { kind: 'shot', range: 3.2, rate: 0.7, dmg: 1, pct: 0.04, maxHit: 60, pierceArmor: true },
      defaultTarget: 'strong',
      unlock: { coins: 800, level: 5 },
      upgrades: [
        { name: 'Deeper Hex', cost: 300, desc: '6% of max HP per hex (up to 60)', set: { pct: 0.06 } },
        { name: 'Quick Chant', cost: 450, desc: '+60% hex speed, +range', mul: { rate: 1.6 }, add: { range: 0.5 } },
        { name: 'Twin Hex', cost: 900, desc: 'Hexes the 2 strongest slimes', set: { targets: 2 } },
      ],
    },
    bramble: {
      name: 'Bramble Snare', cost: 220, desc: 'Roots slimes in place for a moment. Extra thorns for Zippy slimes.',
      base: { kind: 'snare', range: 2.6, rate: 0.9, dmg: 1, fastBonus: 2, root: 0.5, rootGap: 1.5, targets: 1 },
      unlock: { coins: 300, level: 2 },
      upgrades: [
        { name: 'Hooked Thorns', cost: 150, desc: '+1 damage, longer root', add: { dmg: 1 }, set: { root: 0.8 } },
        { name: 'Twin Vines', cost: 260, desc: 'Roots 2 slimes per shot', set: { targets: 2 } },
        { name: 'Strangler Thicket', cost: 550, desc: '3 slimes, +40% speed, sees ghosts', set: { targets: 3, detect: true }, mul: { rate: 1.4 } },
      ],
    },
    hatchery: {
      name: 'Slime Hatchery', cost: 350, desc: 'Does not attack. Your sends get 20% more slimes. Max 1.', limit: 1,
      base: { kind: 'nest', range: 0, extra: 0.2 },
      unlock: { coins: 500, level: 3 },
      upgrades: [
        { name: 'Warm Nest', cost: 300, desc: 'Send cooldowns 25% shorter', set: { cdMul: 0.75 } },
        { name: 'Thick Shells', cost: 500, desc: 'Sent slimes +25% HP (rounded)', set: { hpBonus: 0.25 } },
        { name: 'Royal Brood', cost: 900, desc: 'Sent slimes +40% HP (rounded) and 10% faster', set: { hpBonus: 0.4, spd: 1.1 } },
      ],
    },
    basilisk: {
      name: 'Basilisk Eye', cost: 340, desc: 'Turns weakened Big Slimes and Knights to stone, so they shatter without splitting.',
      base: { kind: 'gaze', range: 2.6, rate: 0.8, dmg: 1, execute: 0.25 },
      unlock: { coins: 500, level: 3 },
      upgrades: [
        { name: 'Cold Stare', cost: 200, desc: 'Petrifies below 40% HP', set: { execute: 0.4 } },
        { name: 'Wide Gaze', cost: 320, desc: '+range, +50% gaze speed', add: { range: 0.8 }, mul: { rate: 1.5 } },
        { name: 'Medusa Crown', cost: 700, desc: 'Petrifies the King below 12% HP, shatters hit nearby slimes', set: { executeKing: 0.12, shards: 3 } },
      ],
    },
    stormjar: {
      name: 'Storm Jar', cost: 400, desc: 'Stores lightning while the lane is quiet, then fires it all at once.',
      base: { kind: 'jar', range: 2.8, rate: 6, dmg: 3, charges: 6, chargeTime: 1.5 }, // rate = how fast stored bolts fire
      unlock: { coins: 600, level: 4 },
      upgrades: [
        { name: 'Bigger Jar', cost: 220, desc: 'Holds 10 charges', set: { charges: 10 } },
        { name: 'Quick Charge', cost: 380, desc: '1 charge every second', set: { chargeTime: 1.0 } },
        { name: 'Thunderhead', cost: 850, desc: 'Bolts do 6, ignore armor, see ghosts', set: { dmg: 6, pierceArmor: true, detect: true } },
      ],
    },
    ballista: {
      name: 'Ballista', cost: 300, desc: 'Its bolt flies straight through several slimes in a row.',
      base: { kind: 'lance', range: 3.6, rate: 0.55, dmg: 2, pierce: 4 },
      unlock: { coins: 300, level: 2 },
      upgrades: [
        { name: 'Longer Bolts', cost: 180, desc: 'Pierces 7 slimes, +range', set: { pierce: 7 }, add: { range: 0.6 } },
        { name: 'Iron Tips', cost: 320, desc: '+2 damage per slime', add: { dmg: 2 } },
        { name: 'Siege Winch', cost: 650, desc: '+70% fire rate, pierces every slime on the line', mul: { rate: 1.7 }, set: { pierce: 99 } },
      ],
    },
    drake: {
      name: 'Ember Drake', cost: 340, desc: 'Breathes a short cone of fire that burns every slime in front of it.',
      base: { kind: 'flame', range: 1.8, rate: 2, dmg: 1, cone: 70 },
      unlock: { coins: 450, level: 3 },
      upgrades: [
        { name: 'Big Lungs', cost: 220, desc: '+range, wider cone', add: { range: 0.5 }, set: { cone: 100 } },
        { name: 'Blue Flame', cost: 400, desc: '+1 damage, ignores armor', add: { dmg: 1 }, set: { pierceArmor: true } },
        { name: 'Wyrm Heart', cost: 750, desc: '+80% breath speed, sees ghosts', mul: { rate: 1.8 }, set: { detect: true } },
      ],
    },
    goldspitter: {
      name: 'Goldspitter', cost: 220, desc: 'Hits hard, but every shot costs gold (more in later rounds). Stops when you are broke.',
      base: { kind: 'coin', range: 2.8, rate: 1, dmg: 5, shotCost: 3 },
      unlock: { coins: 400, level: 3 },
      upgrades: [
        { name: 'Heavy Coins', cost: 220, desc: '+4 damage', add: { dmg: 4 } },
        { name: 'Ricochet', cost: 380, desc: 'Coins bounce to a 2nd slime, sees ghosts', set: { bounce: 1, detect: true } },
        { name: 'Golden Hoard', cost: 750, desc: '+70% fire rate, 1 gold less per shot', mul: { rate: 1.7 }, add: { shotCost: -1 } },
      ],
    },
    sapling: {
      name: 'Elder Sapling', cost: 160, desc: 'Grows stronger every 2 rounds it stays alive. Plant it early.',
      base: { kind: 'arrow', range: 2.5, rate: 0.9, dmg: 1, growCap: 2, growEvery: 2 },
      unlock: { coins: 450, level: 3 },
      upgrades: [
        { name: 'Deep Roots', cost: 200, desc: 'Can grow to +5, +range', set: { growCap: 5 }, add: { range: 0.4 } },
        { name: 'Ironbark', cost: 400, desc: 'Can grow to +8, seeds ignore armor', set: { growCap: 8, pierceArmor: true } },
        { name: 'Ancient Oak', cost: 900, desc: 'Can grow to +12, +50% attack speed', set: { growCap: 12 }, mul: { rate: 1.5 } },
      ],
    },
  };
  const TOWER_ORDER = Object.keys(TOWERS);
  const DEFAULT_TOWERS = TOWER_ORDER.filter((t) => TOWERS[t].unlock.coins === 0);
  const TARGET_MODES = ['first', 'last', 'strong', 'close'];

  function towerStats(type, level) {
    const T = TOWERS[type];
    const s = Object.assign({}, T.base);
    for (let i = 0; i < level; i++) {
      const u = T.upgrades[i];
      if (u.add) for (const k in u.add) s[k] = (s[k] || 0) + u.add[k];
      if (u.mul) for (const k in u.mul) s[k] = (s[k] || 0) * u.mul[k];
      if (u.set) Object.assign(s, u.set);
    }
    return s;
  }
  function towerValue(type, level) {
    const T = TOWERS[type];
    let v = T.cost;
    for (let i = 0; i < level; i++) v += T.upgrades[i].cost;
    return v;
  }
  function sellValue(type, level) { return Math.floor(towerValue(type, level) * RULES.sellRefund); }
  // Goldspitter: gold per shot, +1 every 8 rounds (server charges it, the tower panel shows it)
  function shotCost(stats, round) { return Math.max(1, stats.shotCost + Math.floor(Math.max(0, round) / 8)); }
  // Elder Sapling: +1 damage every growEvery rounds since it was planted, up to growCap
  function growth(stats, born, round) { return Math.min(stats.growCap, Math.floor(Math.max(0, round - born) / stats.growEvery)); }

  // ---------- Sends (attack your opponent, raise your income) ----------
  const SENDS = [
    { id: 'g8',  enemy: 'green',   count: 8,  gap: 0.35, cost: 20,   eco: 1, round: 1,  cd: 1.5 },
    { id: 'g16', enemy: 'green',   count: 16, gap: 0.15, cost: 45,   eco: 2, round: 3,  cd: 3 },
    { id: 'b6',  enemy: 'blue',    count: 6,  gap: 0.4,  cost: 40,   eco: 2, round: 3,  cd: 2.5 },
    { id: 'y6',  enemy: 'yellow',  count: 6,  gap: 0.3,  cost: 50,   eco: 2, round: 4,  cd: 3 },
    { id: 'p3',  enemy: 'purple',  count: 3,  gap: 0.7,  cost: 85,   eco: 3, round: 6,  cd: 4 },
    { id: 'h5',  enemy: 'ghost',   count: 5,  gap: 0.5,  cost: 100,  eco: 4, round: 8,  cd: 4 },
    { id: 'a2',  enemy: 'armored', count: 2,  gap: 0.9,  cost: 150,  eco: 5, round: 10, cd: 5 },
    { id: 'a5',  enemy: 'armored', count: 5,  gap: 0.6,  cost: 350,  eco: 8, round: 14, cd: 8 },
    { id: 'k1',  enemy: 'king',    count: 1,  gap: 1,    cost: 1800, eco: 0, round: 18, cd: 20 },
  ];

  // ---------- Natural rounds (identical for both players) ----------
  const FIXED_ROUNDS = {
    1: [['green', 12]],
    2: [['green', 18]],
    3: [['green', 10], ['blue', 8]],
    4: [['blue', 14], ['green', 10]],
    5: [['yellow', 8], ['blue', 12]],
    6: [['purple', 3], ['blue', 14]],
    7: [['ghost', 4], ['yellow', 10], ['blue', 8]],
    8: [['purple', 6], ['green', 20]],
    9: [['armored', 1], ['purple', 4], ['yellow', 12]],
    10: [['armored', 3], ['ghost', 6], ['blue', 10]],
  };
  // After round 10 waves are generated from an HP budget that grows ~11% per round.
  const WAVE_MIX = [['blue', 0.15], ['yellow', 0.1], ['purple', 0.25], ['ghost', 0.1], ['armored', 0.4]];
  function roundWave(r) {
    if (FIXED_ROUNDS[r]) return FIXED_ROUNDS[r];
    const budget = 110 * Math.pow(1.11, r - 10);
    const g = WAVE_MIX.map(([type, f]) => [type, Math.max(1, Math.round((budget * f) / ENEMIES[type].hpTotal))]);
    if (r >= 20 && r % 5 === 0) g.push(['king', Math.floor((r - 15) / 5)]);
    return g;
  }
  function hpMulForRound(r) {
    let m = 1;
    if (r > RULES.hpRampRound) m += (r - RULES.hpRampRound) * RULES.hpRampPerRound;
    if (r > 30) m += (r - 30) * 0.3;
    return m;
  }

  // ---------- Progression ----------
  function xpForNext(level) { return 100 + 40 * (level - 1); }
  function levelInfo(xp) {
    let level = 1, need = xpForNext(1);
    while (xp >= need) { xp -= need; level++; need = xpForNext(level); }
    return { level, into: xp, need };
  }
  const TITLES = [[1, 'Rookie'], [3, 'Defender'], [6, 'Warden'], [10, 'Slime Slayer'], [15, 'Siege Master'], [25, 'Legend']];
  function titleFor(level) { let t = TITLES[0][1]; for (const [l, n] of TITLES) if (level >= l) t = n; return t; }

  // ---------- Cosmetics ----------
  // Tower skins recolor the base plate of all your towers (your opponent sees them too).
  const SKINS = {
    skin_classic: { name: 'Classic', cost: 0,   level: 1, base: '#efe3c8', trim: '#8a7656' },
    skin_crimson: { name: 'Crimson', cost: 200, level: 1, base: '#e0525a', trim: '#7a1e27' },
    skin_glacier: { name: 'Glacier', cost: 200, level: 1, base: '#c7ecff', trim: '#3c7fa8' },
    skin_royal:   { name: 'Royal',   cost: 350, level: 2, base: '#f4cd55', trim: '#8a6410' },
    skin_shadow:  { name: 'Shadow',  cost: 500, level: 4, base: '#464062', trim: '#15121e' },
    skin_neon:    { name: 'Neon',    cost: 800, level: 6, base: '#1d1f33', trim: '#3df2c4', glow: true },
  };
  // Banners are your name plate in the lobby, HUD and leaderboard.
  const BANNERS = {
    banner_slate:  { name: 'Slate',  cost: 0,   level: 1, css: 'linear-gradient(135deg,#566078,#323a4d)' },
    banner_forest: { name: 'Forest', cost: 100, level: 1, css: 'linear-gradient(135deg,#3aa35c,#1d5c37)' },
    banner_ocean:  { name: 'Ocean',  cost: 150, level: 2, css: 'linear-gradient(135deg,#3b8fe0,#17408a)' },
    banner_ember:  { name: 'Ember',  cost: 200, level: 3, css: 'linear-gradient(135deg,#ff8a3d,#b8262f)' },
    banner_aurora: { name: 'Aurora', cost: 400, level: 5, css: 'linear-gradient(120deg,#22c9a0,#6a5cff 55%,#ff5ca8)' },
    banner_void:   { name: 'Void',   cost: 700, level: 8, css: 'radial-gradient(circle at 25% 20%,#7a3bb0,#1a0d2b 60%,#07040c)' },
  };
  const DEFAULT_COSMETICS = ['skin_classic', 'banner_slate'];

  // Quick chat in matches (preset only, so nothing needs moderating)
  const EMOTES = ['Good luck!', 'Nice!', 'Oops…', 'Incoming!', 'So close!', 'Well played'];
  const DAILY_WIN_BONUS = 50;

  return {
    COLS, ROWS, RULES, MAPS, posAt, ENEMIES, ENEMY_ORDER, TOWERS, TOWER_ORDER, DEFAULT_TOWERS,
    TARGET_MODES, towerStats, towerValue, sellValue, shotCost, growth, SENDS, roundWave, hpMulForRound,
    xpForNext, levelInfo, titleFor, SKINS, BANNERS, DEFAULT_COSMETICS, EMOTES, DAILY_WIN_BONUS,
    BUILTIN_MAPS, THEMES, validatePath, registerMap,
  };
});
