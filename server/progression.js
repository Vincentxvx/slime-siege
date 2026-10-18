// Player documents, rewards, shop.
const crypto = require('crypto');
const GD = require('../shared/data');

function newUser(username, passHash) {
  return {
    id: crypto.randomUUID(),
    username,
    passHash,
    createdAt: Date.now(),
    xp: 0,
    coins: 100,
    wins: 0,
    losses: 0,
    botWins: 0,
    games: 0,
    bestRound: 0,
    unlocked: GD.DEFAULT_TOWERS.slice(),
    owned: GD.DEFAULT_COSMETICS.slice(),
    skin: 'skin_classic',
    banner: 'banner_slate',
    history: [],
    lastDailyWin: null,
    rating: 1000,
  };
}

function publicProfile(u) {
  const li = GD.levelInfo(u.xp);
  return {
    id: u.id, username: u.username, xp: u.xp, level: li.level, xpInto: li.into, xpNeed: li.need,
    title: GD.titleFor(li.level), coins: u.coins, wins: u.wins, losses: u.losses, botWins: u.botWins,
    games: u.games, bestRound: u.bestRound, unlocked: u.unlocked, owned: u.owned, skin: u.skin, banner: u.banner,
    history: u.history || [], dailyAvailable: u.lastDailyWin !== today(), rating: u.rating || 1000,
    isAdmin: isAdminName(u.username),
    ideas: isAdminName(u.username) || !!u.ideasAccess,
    powers: isAdminName(u.username) || !!u.cheatAccess,
  };
}

function leaderboardEntry(u) {
  return { username: u.username, level: GD.levelInfo(u.xp).level, wins: u.wins, losses: u.losses, banner: u.banner, rating: u.rating || 1000 };
}

// Elo: rating change for player A given A's score (1 win, 0.5 draw, 0 loss)
function eloDelta(ra, rb, scoreA, k = 32) {
  const expected = 1 / (1 + Math.pow(10, (rb - ra) / 400));
  return Math.round(k * (scoreA - expected));
}

const isAdminName = (name) => (process.env.ADMIN_USERS || '').split(',').map((x) => x.trim().toLowerCase()).includes(String(name).toLowerCase());

function today() { return new Date().toISOString().slice(0, 10); }

const BOT_REWARDS = { easy: [40, 15], normal: [70, 30], hard: [110, 50] };

/**
 * Apply a finished match to a user document (mutates it).
 * ctx: { mode: 'pvp'|'bot', won, draw, round, difficulty, early (ended by forfeit before earlyEndRound), quitter }
 */
function applyResult(u, ctx) {
  const round = ctx.round || 0;
  let xp = 0, coins = 0;
  if (ctx.quitter) {
    xp = 5; coins = 0;
  } else if (ctx.mode === 'pvp') {
    if (ctx.won) { xp = 120 + 4 * round; coins = 60 + 2 * round; }
    else { xp = 50 + 3 * round; coins = 20 + round; }
  } else {
    const [bx, bc] = BOT_REWARDS[ctx.difficulty] || BOT_REWARDS.normal;
    if (ctx.won) { xp = bx + 2 * round; coins = bc + round; }
    else { xp = 15 + 2 * round; coins = 5 + Math.floor(round / 2); }
  }
  if (ctx.early) { xp = Math.floor(xp * 0.2); coins = Math.floor(coins * 0.2); }
  let daily = 0;
  if (ctx.won && !ctx.early && u.lastDailyWin !== today()) {
    daily = GD.DAILY_WIN_BONUS;
    u.lastDailyWin = today();
  }

  const before = GD.levelInfo(u.xp).level;
  u.xp += xp;
  const after = GD.levelInfo(u.xp).level;
  const levelUps = after - before;
  const levelBonus = levelUps * 50;
  u.coins += coins + levelBonus + daily;
  u.games++;
  u.bestRound = Math.max(u.bestRound, round);
  if (!ctx.early && !ctx.draw) {
    if (ctx.mode === 'pvp') { if (ctx.won) u.wins++; else u.losses++; }
    else if (ctx.won) u.botWins++;
  }
  u.history = [{ opp: ctx.opponent, mode: ctx.mode, won: !!ctx.won, draw: !!ctx.draw, round, at: Date.now() }]
    .concat(u.history || []).slice(0, 10);
  return { xp, coins, levelUps, levelBonus, daily, level: after };
}

function findItem(id) {
  if (GD.TOWERS[id]) return { kind: 'tower', item: GD.TOWERS[id], cost: GD.TOWERS[id].unlock.coins, level: GD.TOWERS[id].unlock.level };
  if (GD.SKINS[id]) return { kind: 'skin', item: GD.SKINS[id], cost: GD.SKINS[id].cost, level: GD.SKINS[id].level };
  if (GD.BANNERS[id]) return { kind: 'banner', item: GD.BANNERS[id], cost: GD.BANNERS[id].cost, level: GD.BANNERS[id].level };
  return null;
}

function buy(u, id) {
  const f = findItem(id);
  if (!f) return 'Unknown item';
  const owned = f.kind === 'tower' ? u.unlocked : u.owned;
  if (owned.includes(id)) return 'Already owned';
  if (GD.levelInfo(u.xp).level < f.level) return `Requires level ${f.level}`;
  if (u.coins < f.cost) return 'Not enough coins';
  u.coins -= f.cost;
  owned.push(id);
  return null;
}

function equip(u, id) {
  const f = findItem(id);
  if (!f || f.kind === 'tower') return 'Cannot equip that';
  if (!u.owned.includes(id)) return 'Not owned';
  if (f.kind === 'skin') u.skin = id; else u.banner = id;
  return null;
}

module.exports = { eloDelta, newUser, publicProfile, leaderboardEntry, applyResult, buy, equip };
