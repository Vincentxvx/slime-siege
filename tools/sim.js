// Headless bot-vs-bot simulation for balance testing: node tools/sim.js [games] [diffA] [diffB]
const GD = require('../shared/data');
const { Match } = require('../server/game/match');
const games = Number(process.argv[2] || 10), dA = process.argv[3] || 'normal', dB = process.argv[4] || 'normal';
const all = GD.TOWER_ORDER;
const res = { wins: [0, 0], draws: 0, rounds: [] };
for (let g = 0; g < games; g++) {
  let done = null;
  const m = new Match({
    mode: 'sim',
    players: [
      { name: 'A', isBot: true, difficulty: dA, unlocked: all },
      { name: 'B', isBot: true, difficulty: dB, unlocked: all },
    ],
    onEnd: (r) => (done = r),
  });
  let guard = 0;
  while (!done && guard++ < 20 * 60 * 60) m.tick();
  if (!done) { console.log('no end after 60 min'); continue; }
  if (done.winner < 0) res.draws++; else res.wins[done.winner]++;
  res.rounds.push(done.round);
  if (g === 0) console.log('sample:', done, m.boards.map((b) => ({ lives: b.lives, towers: b.towers.length, income: b.income, gold: b.gold, ...b.stats })));
}
const avg = res.rounds.reduce((a, b) => a + b, 0) / res.rounds.length;
console.log(`${dA} vs ${dB}:`, res.wins, 'draws', res.draws, 'avg end round', avg.toFixed(1), 'min', Math.min(...res.rounds), 'max', Math.max(...res.rounds));
