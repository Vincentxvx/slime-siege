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
    unlocked: u.unlocked, owned: u.owned, skin: u.skin, banner: u.banner, ideasAccess: !!u.ideasAccess, cheatAccess: !!u.cheatAccess, mapAccess: !!u.mapAccess,
    ranks: prog.ranksOf(u),
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
    if (typeof b.ideasAccess === 'boolean' && b.ideasAccess !== !!u.ideasAccess) {
      u.ideasAccess = b.ideasAccess;
      changes.push(b.ideasAccess ? 'ideas access on' : 'ideas access off');
    }
    if (typeof b.mapAccess === 'boolean' && b.mapAccess !== !!u.mapAccess) {
      u.mapAccess = b.mapAccess;
      changes.push(b.mapAccess ? 'map editor on' : 'map editor off');
    }
    if (typeof b.cheatAccess === 'boolean' && b.cheatAccess !== !!u.cheatAccess) {
      u.cheatAccess = b.cheatAccess;
      changes.push(b.cheatAccess ? 'powers on' : 'powers off');
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

  // Custom ranks: the whole new list [{ text, color }], first = main rank; [] removes them all
  app.post('/api/admin/user/:id/ranks', authed, adminOnly, wrap(async (req, res) => {
    const u = await load(req, res);
    if (!u) return;
    const { ranks, error } = prog.cleanRanks((req.body || {}).ranks);
    if (error) return res.status(400).json({ error });
    u.ranks = ranks;
    delete u.rank; // the single rank of the first version
    await store.save(u);
    log(req, ranks.length ? `set ranks of ${u.username}: ${ranks.map((r) => `"${r.text}" (${r.color})`).join(', ')}` : `removed all ranks of ${u.username}`);
    lobby.refreshUser(u.id);
    lobby.emitTo(u.friends || [], 'friendsChanged', {});
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

// ---------- Ideas box: visible to admins and players the admin enabled ----------
const IDEA_STATUSES = ['new', 'planned', 'done', 'rejected'];
const canSeeIdeas = (u) => isAdmin(u) || !!(u && u.ideasAccess);

function mountIdeas(app, { store, authed, wrap }) {
  let ideas = null; // cached list
  const load = async () => { if (!ideas) ideas = (await store.getMeta('ideas')) || []; return ideas; };
  const save = () => store.setMeta('ideas', ideas);
  const gate = (req, res, next) => (canSeeIdeas(req.user) ? next() : res.status(403).json({ error: "You don't have access to the ideas box" }));
  const view = (i, me) => ({
    id: i.id, text: i.text, author: i.author, at: i.at, status: i.status,
    votes: i.votes.length, voted: i.votes.includes(me.id), mine: i.authorId === me.id,
  });
  const list = (me) => ideas.slice().sort((a, b) => b.votes.length - a.votes.length || b.at - a.at).map((i) => view(i, me));

  app.get('/api/ideas', authed, gate, wrap(async (req, res) => {
    await load();
    res.json({ ideas: list(req.user), admin: isAdmin(req.user), statuses: IDEA_STATUSES });
  }));

  app.post('/api/ideas', authed, gate, wrap(async (req, res) => {
    await load();
    const text = String((req.body || {}).text || '').trim().replace(/\s+/g, ' ');
    if (text.length < 3) return res.status(400).json({ error: 'Write a bit more' });
    if (text.length > 500) return res.status(400).json({ error: 'Keep it under 500 characters' });
    const today = ideas.filter((i) => i.authorId === req.user.id && Date.now() - i.at < 864e5).length;
    if (today >= 20 && !isAdmin(req.user)) return res.status(429).json({ error: 'That is enough ideas for today' });
    ideas.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text, author: req.user.username, authorId: req.user.id, at: Date.now(), status: 'new', votes: [req.user.id] });
    await save();
    res.json({ ideas: list(req.user) });
  }));

  const find = async (req, res) => {
    await load();
    const i = ideas.find((x) => x.id === String(req.params.id));
    if (!i) res.status(404).json({ error: 'Idea not found' });
    return i;
  };

  app.post('/api/ideas/:id/vote', authed, gate, wrap(async (req, res) => {
    const i = await find(req, res);
    if (!i) return;
    const k = i.votes.indexOf(req.user.id);
    if (k >= 0) i.votes.splice(k, 1); else i.votes.push(req.user.id);
    await save();
    res.json({ ideas: list(req.user) });
  }));

  app.post('/api/ideas/:id/status', authed, gate, wrap(async (req, res) => {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admins only' });
    const i = await find(req, res);
    if (!i) return;
    const st = String((req.body || {}).status);
    if (!IDEA_STATUSES.includes(st)) return res.status(400).json({ error: 'Invalid status' });
    i.status = st;
    await save();
    res.json({ ideas: list(req.user) });
  }));

  app.post('/api/ideas/:id/delete', authed, gate, wrap(async (req, res) => {
    const i = await find(req, res);
    if (!i) return;
    if (!isAdmin(req.user) && i.authorId !== req.user.id) return res.status(403).json({ error: 'You can only delete your own ideas' });
    ideas = ideas.filter((x) => x !== i);
    await save();
    res.json({ ideas: list(req.user) });
  }));
}

module.exports = { mount, mountIdeas, isAdmin, canSeeIdeas, summary };
