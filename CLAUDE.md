# CLAUDE.md — Slime Siege

Context for Claude Code. Read this before changing anything. The player-facing overview is in `README.md`.

## What this is

A 1v1 online tower defense in the browser (Bloons TD Battles style, original slime theme — do not copy Bloons art or names). Each player defends their own lane; natural waves hit both lanes equally; players **send** slimes into the opponent's lane, which costs gold and permanently raises their income. Built for Vincent (owner/admin) and his classmates to play at school.

- Live: https://slime-siege.onrender.com (Render free tier, region Frankfurt, auto-deploys every push to `main`)
- Database: Neon Postgres (free), connection string in Render env `DATABASE_URL`
- Repo: `Vincentxvx/slime-siege` (public)

## Stack and layout

Plain Node.js (>=18, Render uses 22) + Express 4 + Socket.IO 4 + `pg`. No build step, no frontend framework, no image assets: all art is drawn procedurally on canvas, sounds are synthesized with Web Audio.

```
shared/data.js        ALL balance + content: rules, maps, slimes, towers, upgrades, sends, waves,
                      levels, cosmetics, emotes, path validation. UMD: require()'d by the server,
                      loaded as window.GD in the browser. Change balance here.
server/index.js       Express app, REST routes (register/login/me/shop/leaderboard/health), Socket.IO auth,
                      mounts admin, ideas, friends, maps modules
server/lobby.js       Sockets, quick-match queue, rooms (4-letter codes, optional map), bot games, rematch,
                      emotes, spectating, the fixed-step match loop, match end → rewards + Elo
server/game/match.js  Authoritative simulation (20 ticks/s): picking phase, rounds, income, towers, damage,
                      sends, admin powers, snapshots (10/s), win/lose
server/game/bot.js    AI opponent (easy/normal/hard; "turtle"/"turtle0" are test-only configs)
server/progression.js User documents, publicProfile, XP/levels, rewards, daily-win bonus, Elo, shop
server/admin.js       Admin API (+ ideas box API in mountIdeas)
server/friends.js     Friend requests/list/status, match invites (socket)
server/maps.js        Custom maps from the map editor (stored in meta table)
server/db.js          Storage: PgStore when DATABASE_URL is set, else FileStore (data/users.json + .meta.json)
server/auth.js        async scrypt password hashes, HMAC-signed tokens (30 days)
public/index.html     Single page: auth, lobby, game screens
public/app.js         Lobby, shop, leaderboard, friends, ideas, admin panel, map editor, socket wiring
public/game.js        In-match client: snapshot interpolation, HUD, tower bar/panel, sends, powers,
                      pick screen, keyboard play, effects, spectating
public/render.js      Canvas drawing: ground per map theme, towers (level tiers), slimes, icons
public/sfx.js         Synthesized sound effects + mute toggle
public/style.css      All styles
tools/sim.js          Headless bot-vs-bot balance simulator
tools/e2e.js          Two socket clients play a full PvP match against a running server
tools/trace.js        Per-round trace of a bot match (debug balance)
render.yaml           Render Blueprint (free plan, Frankfurt, NODE_VERSION 22, SESSION_SECRET generated)
```

## Run, test, deploy

```bash
npm install
npm start                                  # http://localhost:3000, file storage in ./data
ADMIN_USERS=vince npm start                # make "vince" an admin locally
GAME_SPEED=10 FORCE_MAP=glacier npm start  # testing: faster matches, fixed map

npm run sim -- 20 normal hard              # bot balance check (also: easy, hard, turtle, turtle0)
node tools/trace.js hard easy              # round-by-round trace
GAME_SPEED=10 npm start  &&  npm run test:e2e -- http://localhost:3000
```

- No unit test framework. Verification so far = bot sims + `tools/e2e.js` + Playwright browser scripts (Chromium is available in the cloud env; screenshots were checked by eye). After UI changes, test in a browser at ~1366×640 (school laptops) and 1920×1080.
- Run `node -c` on every changed JS file before pushing.
- Deploy = push to `main`; Render rebuilds (~3–5 min). Every deploy restarts the server and **ends running matches**, so avoid deploying during school breaks. Accounts/data are safe in Neon.
- Free tier sleeps after 15 min idle; first visitor waits ~1 min.

### Environment variables (Render → Environment)
| Var | Purpose |
|---|---|
| `DATABASE_URL` | Neon connection string. Parsing tolerates quotes/backticks/spaces (a pasted value with leading spaces once broke deploys). |
| `SESSION_SECRET` | signs login tokens (Render generates it) |
| `ADMIN_USERS` | comma-separated admin usernames, case-insensitive (Vincent's account) |
| `GAME_SPEED`, `FORCE_MAP` | testing only |

## Data model

Postgres tables (auto-created): `users(id, name_lower unique, doc jsonb, updated_at)` and `meta(key, value jsonb)`.
User `doc` fields: `id, username, passHash, createdAt, xp, coins, wins, losses, botWins, games, bestRound, unlocked[], owned[] (cosmetics), skin, banner, history[] (last 10), lastDailyWin, rating, banned, ideasAccess, cheatAccess, mapAccess, friends[], friendIn[], friendOut[]`.
Old docs may lack newer fields — always default (`u.rating || 1000`, `u.friends || []`, …).
`meta` keys: `ideas` (ideas box list), `maps` (custom maps).
Both stores cache user docs in memory; the single server process is the only writer. Mutate the cached object, then `store.save(u)`.

## Game rules worth knowing (see `shared/data.js` RULES)

- 100 lives, 650 start gold, income 75 every 6 s, round every 20 s (round 1 after 8 s prep). Slime HP ramps after round 18 (+12%/round, steeper after 30) so matches end around rounds 22–35.
- **Tower selection**: every match starts with a 20 s picking phase; each player brings 4 of their unlocked towers (`loadoutSize`). Players with ≤4 unlocked skip it. Empty slots auto-fill when time runs out. Server enforces (place() checks `players[i].unlocked`, which becomes the loadout). Bots bring fixed loadouts (`botLoadout()` in match.js; hard = cannon, sniper, tesla, mine).
- Towers: archer, cannon, frost, sniper, mine (Gold Mine, **max 3**), tesla; 3 upgrades each, sell 70%. Slimes: green, blue, yellow, purple (splits), ghost (needs detection), armored (armor 2, needs pierce), king (boss rounds 20/25/30…).
- Sends: 9 packs unlocked by round, each with a cooldown. **Sent slimes pay no bounty** to the defender.

### Balance decisions (keep unless asked)
- Mines were dominant (pure-defense bots with 4 mines beat everyone) → capped at 3 and nerfed; send eco buffed. After that, sending is worth it and hard > normal > easy in sims.
- Bot difficulty ordering must hold in `npm run sim` (hard should beat easy ~10–12 of 12). Re-run sims after any balance or bot change.
- Matches ended by forfeit/disconnect before round 5, or where **admin powers** were used, don't count toward wins/losses/rating and give 20% rewards (anti-farming).

## Features (all live)

Accounts; quick match; private rooms with map choice; bots with map choice; rematch; 4-tower pick phase; 3 built-in maps + map editor (custom maps); XP/levels/coins; shop (tower unlocks, tower skins, banners); Elo leaderboard; match history; daily first-win bonus; emotes/quick chat; sounds; reconnect after reload (25 s grace); spectating friends; friends list with online/in-match status and direct invites; next-wave preview; quick sends (R strongest, F best income, V all affordable); full keyboard play (arrows + Enter, U upgrade, T targeting, Del sell, 1–4 towers, QWE/ASD/ZXC sends); tower level badges + visual tiers (plain → bronze → silver battlements → gold MAX); upgrade box at a fixed position (requested in ideas box).

Admin (only `ADMIN_USERS`): Admin tab (edit coins/XP/level/rating/stats, unlock items, ban/unban with live kick, reset password, delete account, give coins to all, grant per-user access to: Ideas box, in-game Powers, Map editor); in-match Powers menu (gold, lives, income, spawn any slime for either side, next round, max tower, clear lane); Ideas box (players with access post/upvote; admin sets New/Planned/Done/Not doing). Every admin action is logged as `[admin] …`.

## Conventions

- Server is authoritative: clients only send intentions; validate everything in `match.handleAction` / route handlers. Never trust client gold, tower lists, or permissions.
- Permissions: `isAdmin` from env only; per-user flags in the user doc; exposed to the client via `publicProfile` (`isAdmin`, `ideas`, `powers`, `mapEditor`).
- Snapshots are compact arrays (see `boardSnap`); opponent gold and cooldowns are hidden.
- UI copy: plain English, sentence case, no emoji. Visual style: deep plum background, chunky 3px dark outlines with hard offset shadows, lime (#9be15d) primary, pink for opponent/warnings, gold for currency; fonts Bowlby One (display) + Lexend.
- Keep the game layout fitting a 1366×640 viewport without scrolling (vertical tower bar | canvas | side column).
- Commit messages: short imperative summary + bullet details; push to `main`.

## Communicating with Vincent

Student in Hungary (speaks Hungarian, German, English; chats in English). Hobby game dev with his friend Mio. Prefers short, direct answers with a clear recommendation, step-by-step instructions for setup tasks (he's on Windows 11 / PowerShell, also uses Arch Linux), and confirmation before risky actions. When using a technical term, give it in English plus German and Hungarian in parentheses, e.g. database (Datenbank, adatbázis). Ideas from players arrive via the in-game Ideas box (often in Hungarian).
