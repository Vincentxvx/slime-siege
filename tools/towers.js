// Headless tower test: every tower at every level (and on both upgrade paths) against real slimes, plus the
// special rules of the newer towers (ghost light, roots, petrify, piercing, cones, gold per shot, charges, growth,
// hatchery sends) and of the path B upgrades (armor-piercing arrows, slowing blasts, brittle, two-target shots).
// Usage: node tools/towers.js   (exits with code 1 if anything fails)
const GD = require('../shared/data');
const { Match, DT } = require('../server/game/match');

let failed = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failed++; };

// A running match on Meadow; player 0 brings `towers`, both players have endless gold and lives
function match(towers) {
  const players = [0, 1].map((i) => ({ uid: 'p' + i, name: 'P' + i, level: 50, unlocked: i ? ['archer'] : towers, skin: 'skin_classic', banner: 'banner_slate', cheats: true }));
  const m = new Match({ players, mapId: 'meadow', mode: 'test' });
  for (let i = 0; i < 400 && m.state !== 'running'; i++) m.tick();
  for (const b of m.boards) { b.gold = 1e6; b.lives = 1e6; }
  m.nextRoundAt = 1e9; // no natural waves unless a test asks for them
  return m;
}
const act = (m, a) => m.handleAction(0, a);
const place = (m, tower, col, row, level = 0, path = 'a') => {
  const r = act(m, { type: 'place', tower, col, row });
  if (!r.ok) throw new Error(`place ${tower}: ${r.error}`);
  for (let i = 0; i < level; i++) act(m, { type: 'upgrade', id: r.id, path });
  return m.boards[0].towers.find((t) => t.id === r.id);
};
// spawn slimes on player 0's board, spread along the path in front of the towers
const spawn = (m, type, n, from = 2, step = 0.6) => {
  const b = m.boards[0];
  const out = [];
  for (let i = 0; i < n; i++) out.push(m.spawnEnemy(b, type, from + i * step, 1, false));
  return out;
};
const run = (m, seconds) => { for (let i = 0; i < seconds / DT; i++) { m.tick(); m.boards[0].lives = 1e6; } };
const hpLeft = (m) => m.boards[0].enemies.reduce((s, e) => s + e.hp, 0);

// 1. Every tower at every level (both paths where it has two) fights a mixed group without crashing,
//    and attacking towers deal damage
for (const type of GD.TOWER_ORDER) {
  for (const path of GD.TOWERS[type].branch ? ['a', 'b'] : ['a']) for (let level = 0; level <= GD.TOWERS[type].upgrades.length; level++) {
    if (path === 'b' && level <= GD.FORK) continue; // same as path a until the fork
    const name = `${type} level ${level + 1}${path === 'b' ? ' (path B)' : ''}`;
    try {
      const m = match([type]);
      const t = place(m, type, 5, 4, level, path);
      ok(t.level === level && (level <= GD.FORK || (t.path || 'a') === path), `${name} built`);
      t.charge = t.stats.charges || 0;
      spawn(m, 'green', 4); spawn(m, 'blue', 3, 5); spawn(m, 'purple', 2, 7); spawn(m, 'armored', 1, 9); spawn(m, 'ghost', 2, 10);
      const before = hpLeft(m);
      run(m, 6);
      const attacks = !!t.stats.rate && !t.stats.ghostOnly && (t.stats.dmg > 0 || !!t.stats.pct); // early Frost only slows
      if (attacks) ok(m.boards[0].stats.kills > 0 || hpLeft(m) < before, `${name} deals damage`);
      else ok(true, `${name} runs (does not attack)`);
      m.emitSnapshots();
    } catch (e) { ok(false, `${name} crashed: ${e.stack}`); }
  }
}

// 2. Glow Lantern: an Archer can't hit ghosts, but can inside the light
{
  const m = match(['archer']); place(m, 'archer', 5, 4); spawn(m, 'ghost', 3, 4, 0.8); run(m, 4);
  ok(m.boards[0].stats.kills === 0, 'archer alone cannot hit ghosts');
  const m2 = match(['archer', 'lantern']); place(m2, 'archer', 5, 4); place(m2, 'lantern', 3, 4); spawn(m2, 'ghost', 3, 4, 0.8).forEach((e) => { e.hp = e.maxHp = 100; }); run(m2, 4);
  ok(m2.boards[0].enemies.some((e) => e.hp < 100), 'archer hits ghosts inside a lantern\'s light');
  const m3 = match(['lantern']); place(m3, 'lantern', 5, 4, 2); spawn(m3, 'green', 3, 5); spawn(m3, 'ghost', 2, 4); run(m3, 6);
  const left = m3.boards[0].enemies.map((e) => e.type);
  ok(!left.includes('ghost') && left.filter((x) => x === 'green').length === 3, 'Flare hits ghosts only');
  const m4 = match(['lantern']); place(m4, 'lantern', 5, 4, 3); spawn(m4, 'green', 3, 5); run(m4, 4);
  ok(m4.boards[0].stats.kills > 0, 'Lighthouse flares hit every slime');
}

// 3. Hex Idol: a share of max HP, ignoring armor, capped per hit; targets the strongest by default
{
  const m = match(['hex']); const t = place(m, 'hex', 5, 4);
  ok(t.target === 'strong', 'Hex Idol targets Strong by default');
  const [k] = spawn(m, 'king', 1, 5); k.hp = k.maxHp = 1000; k.slowResist = 0; run(m, 1.6);
  ok(k.hp === 1000 - 40 || k.hp === 1000 - 80, `hex takes 4% of max HP per hit (King hp ${k.hp})`);
  const m2 = match(['hex']); place(m2, 'hex', 5, 4); const [k2] = spawn(m2, 'king', 1, 5); k2.hp = k2.maxHp = 5000; run(m2, 1.6);
  ok(5000 - k2.hp <= 120 && 5000 - k2.hp >= 60, `hex hits are capped at 60 (took ${5000 - k2.hp})`);
}

// 4. Bramble Snare: roots, Zippy slimes take extra thorns, roots can't chain forever
{
  const m = match(['bramble']); place(m, 'bramble', 5, 4); const [y] = spawn(m, 'yellow', 1, 4); y.hp = y.maxHp = 3; run(m, 1.2);
  ok(y.dead || y.hp <= 0 || !m.boards[0].enemies.includes(y), 'one vine (1 + 2 thorns) pops a Zippy slime');
  const m2 = match(['bramble']); place(m2, 'bramble', 5, 4); const [k] = spawn(m2, 'armored', 1, 7); k.hp = k.maxHp = 1e6; // d 7 = next to the tower
  m2.tick(); const d0 = k.d; run(m2, 0.3);
  ok(k.rootUntil > 0 && (k.d - d0) < 0.05, 'a rooted slime stops even when armor blocks the damage');
  const snap = m2.boardSnap(m2.boards[0]).enemies.find((e) => e[0] === k.id);
  ok(snap && snap[4] === 2, 'rooted slimes show as 2 in the snapshot');
  ok(k.rootImmune - k.rootUntil === GD.TOWERS.bramble.base.rootGap, 'root immunity follows each root');
  // Strangler Thicket hits 3 slimes even when only one of them can be rooted right now
  const m3 = match(['bramble']); place(m3, 'bramble', 5, 4, 3);
  const list = spawn(m3, 'blue', 4, 6.5, 0.3); list.forEach((e, i) => { e.hp = e.maxHp = 100; e.rootImmune = i ? 1e9 : 0; });
  m3.tick();
  ok(list.filter((e) => e.hp < 100).length === 3 && list.filter((e) => e.rootUntil > 0).length === 1, 'vines hit 3 slimes and root only the one that is not immune');
}

// 5. Slime Hatchery: extra slimes, shorter cooldowns, tougher and faster sent slimes
{
  const m = match(['hatchery']); m.round = 5; place(m, 'hatchery', 5, 4, 3);
  const o = m.boards[1]; o.queue = [];
  act(m, { type: 'send', pack: 'g16' });
  ok(o.queue.length === 19, `g16 with a hatchery sends 19 slimes (sent ${o.queue.length})`);
  ok(m.boards[0].sendReady.g16 - m.time === GD.SENDS[1].cd * 0.75, 'Warm Nest cuts the cooldown by 25%');
  ok(o.queue[0].spd === 1.1 && Math.abs(o.queue[0].hpMul - GD.hpMulForRound(5) * 1.4) < 1e-9, 'Royal Brood: +40% HP, 10% faster');
  ok(!act(m, { type: 'place', tower: 'hatchery', col: 6, row: 5 }).ok, 'only one hatchery');
  // small packs: the 20% carries over between sends (Knight x2 gets +1 every few sends, the King every 5th)
  const mc = match(['hatchery']); mc.round = 20; place(mc, 'hatchery', 5, 4); const oc = mc.boards[1];
  let knights = 0, kings = 0;
  for (let i = 0; i < 5; i++) { oc.queue = []; mc.boards[0].sendReady = {}; act(mc, { type: 'send', pack: 'a2' }); knights += oc.queue.length; oc.queue = []; act(mc, { type: 'send', pack: 'k1' }); kings += oc.queue.length; }
  ok(knights === 12 && kings === 6, `5 Knight x2 sends give 12 Knights, 5 King sends give 6 Kings (${knights}, ${kings})`);
  m.round = 10; act(m, { type: 'send', pack: 'a2' }); run(m, 7);
  const knight = o.enemies.find((e) => e.type === 'armored');
  ok(knight && knight.spd === 1.1, 'sent Knights keep the speed bonus');
}

// 6. Basilisk Eye: a weakened Big Slime shatters without splitting; others still split
{
  const m = match(['basilisk']); place(m, 'basilisk', 5, 4); const [p] = spawn(m, 'purple', 1, 4); p.hp = 1; run(m, 2);
  ok(!m.boards[0].enemies.some((e) => e.type === 'blue') && m.boards[0].stats.kills === 1, 'a petrified Big Slime drops no blue slimes');
  const m2 = match(['archer']); place(m2, 'archer', 5, 4); const [p2] = spawn(m2, 'purple', 1, 4); p2.hp = 1; run(m2, 1);
  ok(m2.boards[0].enemies.some((e) => e.type === 'blue'), 'a Big Slime popped by an Archer still splits');
  const m3 = match(['basilisk']); place(m3, 'basilisk', 5, 4); const [k] = spawn(m3, 'king', 1, 4); k.hp = Math.floor(k.maxHp * 0.1); run(m3, 2);
  ok(!k.dead, 'the King cannot be petrified before Medusa Crown');
  const m4 = match(['basilisk']); place(m4, 'basilisk', 5, 4, 3); const [k4] = spawn(m4, 'king', 1, 4); k4.hp = Math.floor(k4.maxHp * 0.1); run(m4, 2);
  ok(k4.dead && !m4.boards[0].enemies.some((e) => e.type === 'armored'), 'Medusa Crown petrifies a weak King without Knights');
}

// 7. Storm Jar: stores charges while quiet and fires them in a burst
{
  const m = match(['stormjar']); const t = place(m, 'stormjar', 5, 4); run(m, 12);
  ok(t.charge === GD.TOWERS.stormjar.base.charges, `the jar fills up to ${GD.TOWERS.stormjar.base.charges} charges`);
  spawn(m, 'armored', 1, 5).forEach((e) => { e.hp = e.maxHp = 1e6; }); spawn(m, 'blue', 6, 4, 0.2).forEach((e) => { e.hp = 1e6; });
  run(m, 1.2);
  ok(t.charge < 2, `a full jar empties in about a second (charge ${t.charge.toFixed(2)})`);
  ok(m.boardSnap(m.boards[0]).towers[0][6] === Math.floor(t.charge), 'stored charges are in the snapshot');
}

// 8. Ballista: one bolt hits several slimes in a line
{
  const m = match(['ballista']); place(m, 'ballista', 3, 6); // next to Meadow's long column 4 (rows 1-8)
  const list = spawn(m, 'blue', 5, 5, 0.5); list.forEach((e) => { e.hp = e.maxHp = 100; });
  for (let i = 0; i < 4; i++) m.tick(); // first shot only
  ok(list.filter((e) => e.hp < 100).length >= 2, `one bolt hits several slimes in a line (${list.filter((e) => e.hp < 100).length})`);
}

// 9. Ember Drake: one breath burns several slimes in its cone
{
  const m = match(['drake']); place(m, 'drake', 5, 4); const list = spawn(m, 'blue', 4, 7.5, 0.4); list.forEach((e) => { e.hp = e.maxHp = 100; }); // column 4, rows 4-5
  for (let i = 0; i < 2; i++) m.tick();
  ok(list.filter((e) => e.hp < 100).length >= 2, `one breath burns several slimes (${list.filter((e) => e.hp < 100).length})`);
}

// 10. Goldspitter: every shot costs gold, and it stops when you're broke
{
  const m = match(['goldspitter']); place(m, 'goldspitter', 5, 4); spawn(m, 'blue', 3, 4).forEach((e) => { e.hp = e.maxHp = 1e6; });
  m.boards[0].gold = 10; run(m, 5);
  ok(m.boards[0].gold < 3 && m.boards[0].gold >= 0, `shots spend gold until it runs out (gold left ${m.boards[0].gold})`);
  m.round = 16; ok(GD.shotCost(GD.towerStats('goldspitter', 0), m.round) === 5, 'shots cost +1 gold every 8 rounds');
}

// 11. Elder Sapling: grows +1 damage every 2 rounds, up to its cap
{
  const m = match(['sapling']); m.round = 2; const t = place(m, 'sapling', 5, 4);
  m.round = 12; ok(GD.growth(t.stats, t.born, m.round) === 2, 'growth stops at the level 1 cap (+2)');
  ok(m.boardSnap(m.boards[0]).towers[0][6] === 5, 'the snapshot has the growth before the cap, so the panel can preview the next cap');
  act(m, { type: 'upgrade', id: t.id }); ok(GD.growth(t.stats, t.born, m.round) === 5, 'Deep Roots raises the cap to +5');
  ok(m.boardSnap(m.boards[0]).towers[0][6] === 5, 'growth is in the snapshot');
  const [k] = spawn(m, 'blue', 1, 4); k.hp = k.maxHp = 100; for (let i = 0; i < 25; i++) m.tick();
  ok(k.hp === 100 - 6 || k.hp === 100 - 12, `a grown seed hits for 1 + 5 (hp ${k.hp})`);
}

// 12. Upgrade paths (Archer, Cannon, Frost, Sniper): the fork, costs, sell value, snapshot, and each path B rule
{
  const m = match(['archer']);
  const t = place(m, 'archer', 5, 4, 1);
  const b = m.boards[0], gold = b.gold;
  ok(act(m, { type: 'upgrade', id: t.id, path: 'b' }).ok && t.path === 'b' && gold - b.gold === GD.TOWERS.archer.branch[0].cost, 'the fork takes path B at its price');
  act(m, { type: 'upgrade', id: t.id, path: 'a' });
  ok(t.level === 3 && t.path === 'b' && t.stats.dmg === GD.towerStats('archer', 3, 'b').dmg, 'later upgrades stay on the chosen path');
  ok(m.boardSnap(b).towers[0][7] === 1, 'path B is in the snapshot');
  const g2 = b.gold; act(m, { type: 'sell', id: t.id });
  ok(b.gold - g2 === GD.sellValue('archer', 3, 'b'), 'selling refunds what path B cost');
  const t2 = place(m, 'archer', 6, 4, 1);
  act(m, { type: 'upgrade', id: t2.id }); // bots and old clients send no path
  ok(t2.path === 'a' && t2.stats.rate === GD.towerStats('archer', 2).rate, 'no path given means path A');
  const t3 = place(m, 'archer', 7, 4, 1);
  ok(m.handleAction(0, { type: 'upgrade', id: t3.id, path: { toString: 1 } }).ok && t3.path === 'a', 'a strange path value means path A');
  ok(GD.upgradeList('mine', 'b') === GD.TOWERS.mine.upgrades, 'towers without a branch ignore path B');
}
{ // Archer path B pierces armor: Bodkin Points hurts a Knight, Quick Draw (2 damage vs armor 2) does not
  const hit = (path) => { const m = match(['archer']); place(m, 'archer', 5, 4, 2, path); const [k] = spawn(m, 'armored', 1, 4); k.hp = k.maxHp = 100; run(m, 2); return 100 - k.hp; };
  ok(hit('a') === 0 && hit('b') > 0, `Bodkin Points pierces armor (A ${hit('a')}, B ${hit('b')})`);
}
{ // Cannon path B: blasts slow
  const m = match(['cannon']); place(m, 'cannon', 5, 4, 2, 'b');
  const [s1] = spawn(m, 'purple', 1, 4); s1.hp = s1.maxHp = 500; run(m, 2);
  ok(s1.slowUntil > m.time && Math.abs(s1.slowAmt - 0.3) < 1e-9, 'Concussion Shells slow 30%');
  const m2 = match(['cannon']); place(m2, 'cannon', 5, 4, 2, 'a');
  const [s2] = spawn(m2, 'purple', 1, 4); s2.hp = s2.maxHp = 500; run(m2, 2);
  ok(!(s2.slowUntil > m2.time), 'Rapid Reload does not slow');
}
{ // Frost path B: slimes it pulses take +30% from every tower (after armor)
  const shot = (frostPath) => {
    const m = match(['frost', 'sniper']);
    if (frostPath) place(m, 'frost', 5, 4, 2, frostPath);
    const [s] = spawn(m, 'blue', 1, 4); s.hp = s.maxHp = 1000;
    for (let i = 0; i < 30; i++) m.tick(); // let the frost pulse
    const before = s.hp; // (Frostbite deals damage of its own)
    m.damage(m.boards[0], s, 10, false);
    return before - s.hp;
  };
  ok(shot(null) === 10 && shot('a') === 10 && Math.abs(shot('b') - 13) < 1e-9, `Brittle Ice: +30% damage taken (${shot('b')})`);
}
{ // a weaker slow (Cannon B 30%) doesn't keep a stronger one (Deep Freeze 60%) running
  const m = match(['cannon']); const [e] = spawn(m, 'purple', 1, 4);
  m.applySlow(e, 0.6, 1.5); const until = e.slowUntil;
  for (let i = 0; i < 10; i++) { m.tick(); m.applySlow(e, 0.3, 1.5); }
  ok(e.slowUntil === until && e.slowAmt === 0.6, 'a weaker slow does not extend a stronger one');
  for (let i = 0; i < 40; i++) m.tick();
  m.applySlow(e, 0.3, 1.5);
  ok(e.slowAmt === 0.3, 'once the strong slow ends, the weaker one applies');
}
{ // brittle hits are fractional, but nothing survives on float crumbs: 13 HP, five 2-damage hits at +30%
  const m = match(['frost']); const [e] = spawn(m, 'blue', 1, 4); e.hp = e.maxHp = 13;
  e.brittle = 0.3; e.brittleUntil = 1e9;
  for (let i = 0; i < 5; i++) m.damage(m.boards[0], e, 2, false);
  ok(e.dead, 'five brittle 2.6 hits kill a 13 HP slime');
}
{ // Sniper path B: Twin Scopes hits two slimes per shot
  const m = match(['sniper']); const t = place(m, 'sniper', 5, 4, 3, 'b');
  const two = spawn(m, 'blue', 2, 4, 1); two.forEach((e) => { e.hp = e.maxHp = 1000; });
  t.cd = 0; for (let i = 0; i < 2; i++) m.tick();
  ok(two.every((e) => e.hp < 1000), 'Twin Scopes hits 2 slimes with one shot');
}

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
