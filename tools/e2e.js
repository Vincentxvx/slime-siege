// End-to-end test against a running server: two clients play a full PvP match to the end.
// Usage: node tools/e2e.js [baseUrl]   (start the server with GAME_SPEED=10 to make it quick)
const { io } = require('socket.io-client');
const base = process.argv[2] || 'http://localhost:3999';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function account(name) {
  const body = JSON.stringify({ username: name, password: 'secret123' });
  let r = await fetch(base + '/api/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  if (r.status === 409) r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  return (await r.json()).token;
}

(async () => {
  const names = ['e2e_a' + (Date.now() % 1e4), 'e2e_b' + (Date.now() % 1e4)];
  const tokens = await Promise.all(names.map(account));
  const ends = [];
  const clients = tokens.map((token, i) => {
    const s = io(base, { auth: { token }, transports: ['websocket'] });
    s.on('matchStart', (m) => { s.idx = m.you; console.log(names[i], 'match start, map', m.map); });
    s.on('snap', (snap) => { s.last = snap; });
    s.on('matchEnd', (e) => { ends[i] = e; });
    return s;
  });
  await sleep(500);
  clients.forEach((c) => c.emit('queue'));
  await sleep(800);
  const act = (c, a) => new Promise((r) => c.emit('action', a, r));
  // Player A builds a defense and sends; player B only builds one archer
  console.log('place A:', await act(clients[0], { type: 'place', tower: 'archer', col: 3, row: 2 }));
  console.log('bad place on path:', await act(clients[0], { type: 'place', tower: 'archer', col: 0, row: 1 }));
  console.log('locked tower:', await act(clients[1], { type: 'place', tower: 'tesla', col: 5, row: 5 }));
  await act(clients[1], { type: 'place', tower: 'archer', col: 5, row: 4 });
  const t0 = Date.now();
  while (ends.filter(Boolean).length < 2 && Date.now() - t0 < 180000) {
    const s = clients[0].last;
    if (s) {
      const me = s.boards[clients[0].idx];
      for (const pack of ['b6', 'y6', 'g16', 'g8', 'p3']) if (me.gold > 200) await act(clients[0], { type: 'send', pack });
      if (me.gold > 400) await act(clients[0], { type: 'place', tower: 'cannon', col: 2 + Math.floor(Math.random() * 12), row: Math.floor(Math.random() * 11) });
    }
    await sleep(150);
    if (s && Date.now() % 5000 < 160) console.log('round', s.round, 'lives', s.boards.map((b) => b.lives), 't', s.t);
  }
  ends.forEach((e, i) => console.log(names[i], e && { won: e.won, reason: e.reason, round: e.round, rewards: e.rewards, wins: e.profile.wins, losses: e.profile.losses }));
  const ok = ends[0] && ends[1] && ends[0].won && !ends[1].won && ends[0].profile.wins === 1 && ends[1].profile.losses === 1;
  console.log(ok ? 'E2E PASS' : 'E2E FAIL');
  clients.forEach((c) => c.close());
  process.exit(ok ? 0 : 1);
})();
