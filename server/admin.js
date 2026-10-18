// Admin panel API. Admins are the usernames listed in the ADMIN_USERS environment variable
// (comma separated, case-insensitive), e.g. ADMIN_USERS=vince,mio
const GD = require('../shared/data');
const auth = require('./auth');
const prog = require('./progression');

const admins = () => (process.env.ADMIN_USERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const isAdmin = (u) => !!u && admins().includes(u.username.toLowerCase());

const NUM_FIELDS = ['coins', 'xp', 'wins', 'losses', 'botWins', 'rating', 'bestRound', 'games'];
const ALL_COSMETICS = Object.keys(GD.SKINS).concat(Object.keys(GD.BANNERS));

function summary(u) {
  return {
    id: u.id, username: u.username, level: GD.levelInfo(u.xp).level, xp: u.xp, coins: u.coins,
    wins: u.wins, losses: u.losses, botWins: u.botWins, rating: u.rating || 1000, games: u.games,
    bestRound: u.bestRound, createdAt: u.createdAt, banned: !!u.banned, admin: isAdmin(u),
    unlocked: u.unlocked, owned: u.owned, skin: u.skin, banner: u.banner,
  };
}

function mount(app, { store, lobby, authed, wrap }) {
  const adminOnly = (req, res, next) => (isAdmin(req.user) ? next() : res.status(403).json({ error: 'Admins only' }));
  const load = async (req, res) => {
    const u = await store.getById(String(req.params.id));
    if (!u) res.status(404).json({ error: 'Player not found' });
    return u;
  };
  const log = (req, msg) => console.log(`[admin] ${req.user.username}: ${msg}`);

  app.get('/api/admin/overview', authed, adminOnly, wrap(async (req, res) => {
    const users = await store.all();
    res.json({
      online: lobby.online(), matches: lobby.matches.size, players: users.length,
      users: users.map(summary).sort((a, b) => b.createdAt - a.createdAt),
    });
  }));

  app.post('/api/admin/user/:id', authed, adminOnly, wrap(async (req, res) => {
    const u = await load(req, res);
    if (!u) return;
    const b = req.body || {};
    const changes = [];
    for (const k of NUM_FIELDS) {
      if (b[k] === undefined || b[k] === '') continue;
      const v = Math.floor(Number(b[k]));
      if (!Number.isFinite(v) || v < 0 || v > 1e9) return res.status(400).json({ error: `Invalid value for ${k}` });
      if (u[k] !== v) { changes.push(`${k} ${u[k]}→${v}`); u[k] = v; }
    }
    if (Array.isArray(b.unlocked)) {
      const list = GD.TOWER_ORDER.filter((t) => b.unlocked.includes(t) || GD.DEFAULT_TOWERS.includes(t));
      u.unlocked = list;
    }
    if (Array.isArray(b.owned)) {
      u.owned = ALL_COSMETICS.filter((c) => b.owned.includes(c) || GD.DEFAULT_COSMETICS.includes(c));
      if (!u.owned.includes(u.skin)) u.skin = 'skin_classic';
      if (!u.owned.includes(u.banner)) u.banner = 'banner_slate';
    }
    if (typeof b.banned === 'boolean' && b.banned !== !!u.banned) {
      if (u.id === req.user.id) return res.status(400).json({ error: "You can't ban yourself" });
      u.banned = b.banned;
      changes.push(b.banned ? 'BANNED' : 'unbanned');
    }
    await store.save(u);
    log(req, `edited ${u.username}: ${changes.join(', ') || 'items'}`);
    lobby.refreshUser(u.id, u.banned ? 'Your account was banned' : null);
    res.json({ user: summary(u) });
  }));

  app.post('/api/admin/user/:id/password', authed, adminOnly, wrap(async (req, res) => {
    const u = await load(req, res);
    if (!u) return;
    const pw = String((req.body || {}).password || '');
    if (pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    u.passHash = await auth.hashPassword(pw);
    await store.save(u);
    log(req, `reset password of ${u.username}`);
    res.json({ ok: true });
  }));

  app.post('/api/admin/user/:id/delete', authed, adminOnly, wrap(async (req, res) => {
    const u = await load(req, res);
    if (!u) return;
    if (u.id === req.user.id) return res.status(400).json({ error: "You can't delete your own account here" });
    lobby.refreshUser(u.id, 'Your account was deleted');
    await store.delete(u.id);
    log(req, `deleted ${u.username}`);
    res.json({ ok: true });
  }));

  app.post('/api/admin/grant-all', authed, adminOnly, wrap(async (req, res) => {
    const coins = Math.floor(Number((req.body || {}).coins));
    if (!Number.isFinite(coins) || coins < 1 || coins > 1e6) return res.status(400).json({ error: 'Enter 1 to 1,000,000 coins' });
    const users = await store.all();
    for (const u of users) { u.coins += coins; await store.save(u); lobby.refreshUser(u.id); }
    log(req, `gave ${coins} coins to all ${users.length} players`);
    res.json({ ok: true, players: users.length });
  }));
}

module.exports = { mount, isAdmin, summary };
