// Slime Siege server: static client, REST API for accounts/shop, Socket.IO for matches.
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { createStore } = require('./db');
const auth = require('./auth');
const prog = require('./progression');
const { Lobby } = require('./lobby');
const admin = require('./admin');

const PORT = Number(process.env.PORT) || 3000;
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

// Tiny in-memory rate limiter for login/register (per IP — generous, since a whole school shares one IP)
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const now = Date.now();
    const h = hits.get(key) || { n: 0, start: now };
    if (now - h.start > windowMs) { h.n = 0; h.start = now; }
    h.n++;
    hits.set(key, h);
    if (h.n > max) return res.status(429).json({ error: 'Too many attempts, try again in a minute' });
    next();
  };
}

(async () => {
  const store = await createStore();
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));

  const authed = async (req, res, next) => {
    const uid = auth.readToken((req.headers.authorization || '').replace(/^Bearer /, ''));
    const user = uid && (await store.getById(uid));
    if (!user) return res.status(401).json({ error: 'Please log in again' });
    if (user.banned) return res.status(403).json({ error: 'This account is banned' });
    req.user = user;
    next();
  };
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: 'Server error' }); });

  app.post('/api/register', rateLimit(30, 60e3), wrap(async (req, res) => {
    const { username, password } = req.body || {};
    if (!NAME_RE.test(username || '')) return res.status(400).json({ error: 'Username: 3–16 letters, numbers or _' });
    if (typeof password !== 'string' || password.length < 6 || password.length > 100) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (await store.getByName(username)) return res.status(409).json({ error: 'Username is taken' });
    let user;
    try { user = await store.create(prog.newUser(username, await auth.hashPassword(password))); } catch (e) {
      if (e.message === 'taken') return res.status(409).json({ error: 'Username is taken' });
      throw e;
    }
    res.json({ token: auth.makeToken(user.id), profile: prog.publicProfile(user) });
  }));

  app.post('/api/login', rateLimit(60, 60e3), wrap(async (req, res) => {
    const { username, password } = req.body || {};
    const user = await store.getByName(username || '');
    if (!user || !(await auth.verifyPassword(String(password || ''), user.passHash))) return res.status(401).json({ error: 'Wrong username or password' });
    if (user.banned) return res.status(403).json({ error: 'This account is banned' });
    res.json({ token: auth.makeToken(user.id), profile: prog.publicProfile(user) });
  }));

  app.get('/api/me', authed, (req, res) => res.json({ profile: prog.publicProfile(req.user) }));

  app.post('/api/shop/buy', authed, wrap(async (req, res) => {
    const err = prog.buy(req.user, String((req.body || {}).id));
    if (err) return res.status(400).json({ error: err });
    await store.save(req.user);
    res.json({ profile: prog.publicProfile(req.user) });
  }));

  app.post('/api/shop/equip', authed, wrap(async (req, res) => {
    const err = prog.equip(req.user, String((req.body || {}).id));
    if (err) return res.status(400).json({ error: err });
    await store.save(req.user);
    res.json({ profile: prog.publicProfile(req.user) });
  }));

  app.get('/api/leaderboard', wrap(async (req, res) => {
    res.json({ players: (await store.top(25)).map(prog.leaderboardEntry) });
  }));

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  const server = http.createServer(app);
  const io = new Server(server, { pingInterval: 10000, pingTimeout: 9000 });
  io.use(async (socket, next) => {
    try {
      const uid = auth.readToken(socket.handshake.auth && socket.handshake.auth.token);
      const u = uid && (await store.getById(uid));
      if (!u || u.banned) return next(new Error('unauthorized'));
      socket.data.uid = uid;
      next();
    } catch (e) { next(new Error('server error')); }
  });
  const lobby = new Lobby(io, store);
  io.on('connection', (s) => lobby.onConnection(s).catch((e) => console.error(e)));
  admin.mount(app, { store, lobby, authed, wrap });
  admin.mountIdeas(app, { store, authed, wrap });

  server.listen(PORT, () => console.log(`Slime Siege running on http://localhost:${PORT}`));

  const shutdown = async () => {
    console.log('Shutting down…');
    try { await store.close(); } catch (e) { console.error(e); }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})();
