# Slime Siege

A 1v1 online tower defense in the browser. Each player defends their own lane while sending slimes into the opponent's lane. Sends cost gold but permanently raise your income, so every send is a trade between attacking and defending. Player accounts, levels, coins, unlocks and cosmetics are saved on the server.

- **Modes:** quick match against anyone online, a private 4-letter room code for playing a friend, or practice bots (Easy, Normal, Hard). Rematch with one click.
- **6 towers:** Archer, Cannon, Frost, Sniper, Gold Mine, Tesla Coil. Each has 3 upgrades and a targeting mode.
- **7 slimes:** including armored Knights, invisible Ghosts, Big slimes that split, and the Slime King boss.
- **3 maps:** Meadow, Canyon, Glacier, picked at random.
- **Progression:** XP and levels, coins, tower unlocks, tower skins, banners, a rating (Elo) leaderboard, match history and a first-win-of-the-day bonus.
- **Friends:** add friends by username, see who is online or in a match, and invite them straight into a 1v1.
- **Extras:** quick chat, sound effects (mute button), hotkeys, a preview of the next wave, and reconnecting after a page reload.

**Controls:** `1`–`6` pick a tower, click to build (hold Shift to build several), `U` upgrade, `Del` sell, `Esc` cancel. Sends are on `Q W E / A S D / Z X C`.

No game engine and no image files: the art is drawn in code on a canvas. The server runs the whole simulation, so a player can't cheat by editing the page.

## Run it on your own PC

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000. To test multiplayer alone, open a second browser (or a private window), make a second account, and click **Find a match** in both.

Other devices on the same Wi‑Fi can join at `http://<your-PC's-IP>:3000`. School networks often block this, so hosting it online (below) is the reliable way to play at school.

Without a database configured, players are saved to `data/users.json`.

## Host it online for free (Render + Neon)

This gives you a public link like `https://slime-siege.onrender.com` that works on school PCs.

1. **Put the code on GitHub.** Create a new repository and push this folder to it.
2. **Create the database on [Neon](https://neon.com).** Sign up, create a project, and copy the connection string (`postgresql://…`). The table is created automatically on first start.
3. **Create the server on [Render](https://render.com).**
   - Choose **New → Blueprint** and pick your repository. Render reads `render.yaml` and sets everything up.
   - When asked for `DATABASE_URL`, paste the Neon connection string. `SESSION_SECRET` is generated for you.
   - (Without the Blueprint: New → Web Service, build command `npm install --omit=dev`, start command `npm start`, then add the two environment variables yourself.)
4. Open the URL Render gives you and share it.

Things to know about the free tier:

- The server goes to sleep after 15 minutes without visitors. The first person to open the page then waits about a minute while it wakes up. Open the page a minute before you want to play.
- Use Neon (or another external Postgres) for player data. A free Render server has no permanent disk, so `data/users.json` would be wiped on every restart, and Render's own free Postgres database expires after 30 days.

## Environment variables

| Variable | What it does |
|---|---|
| `PORT` | Port to listen on (hosts set this for you) |
| `DATABASE_URL` | Postgres connection string. If empty, uses `data/users.json` |
| `ADMIN_USERS` | Usernames that get the **Admin** tab, comma separated (e.g. `vince,mio`) |
| `SESSION_SECRET` | Secret used to sign logins. If empty, one is generated into `data/secret.key` |
| `GAME_SPEED` | Testing only: run matches 2×, 5×… faster |
| `FORCE_MAP` | Testing only: always use `meadow`, `canyon` or `glacier` |

## Admin panel

Set `ADMIN_USERS` to your username (on Render: **Environment → Add → `ADMIN_USERS`**). After the server restarts, your lobby shows an **Admin** tab where you can:

- see every player, how many are online and how many matches are running
- change coins, level/XP, rating, wins, losses and other stats
- unlock towers and cosmetics for a player
- ban or unban an account (banned players are kicked immediately and can't log in)
- set a new password for someone who forgot theirs
- delete an account
- give every player bonus coins at once
- choose which players can see the **Ideas** box

### Ideas box

An **Ideas** tab where people post and upvote suggestions for the game. Only admins and players with "Can see the Ideas box" ticked in the Admin tab can see it. Admins set a status on each idea (New, Planned, Done, Not doing) and can delete any idea; players can delete their own.

Changes reach players who are online right away. Every admin action is written to the server log as `[admin] …`.

## Project layout

```
shared/data.js        all balance numbers: towers, slimes, sends, rounds, levels, cosmetics
server/index.js       web server, login/register, shop and leaderboard API
server/lobby.js       sockets, matchmaking, rooms, rematches, rewards after a match
server/game/match.js  the authoritative match simulation (20 ticks/s)
server/game/bot.js    the AI opponent
server/progression.js player documents, XP/coins, shop
server/db.js          storage: Postgres or JSON file
public/               the browser client (lobby, canvas renderer, sounds)
tools/sim.js          bot-vs-bot balance simulator
tools/e2e.js          end-to-end test: two socket clients play a full match
```

## Changing the game

Almost everything about balance lives in `shared/data.js`, which both the server and the browser load.

- **Tower stats and upgrades:** `TOWERS`. Upgrades can `add`, `mul` (multiply) or `set` any stat.
- **Slimes:** `ENEMIES`. `children` are spawned when a slime dies.
- **Sends:** `SENDS`, with cost, income gain (`eco`), the round it unlocks and its cooldown.
- **Waves:** `FIXED_ROUNDS` for rounds 1–10, then `roundWave()` builds waves from an HP budget.
- **New map:** add an entry to `MAP_DEFS`. Paths are lists of tile corners on a 16×11 grid and must start and end just off the board.
- **Cosmetics:** `SKINS` and `BANNERS`.

After balance changes, check them with the simulator:

```bash
npm run sim -- 20 normal hard   # 20 bot games, normal vs hard
```

To run the end-to-end test, start the server with `GAME_SPEED=10 npm start`, then run `npm run test:e2e -- http://localhost:3000` in a second terminal.

## How the netcode works

Players only send intentions ("place an archer at 3,2", "send 8 greens"). The server checks each one: is it your tower, can you afford it, is the tile free? Then it runs the simulation and sends both players a compact snapshot 10 times a second. The browser smooths slime movement between snapshots and draws shots and explosions from the events in each snapshot. If a player drops out, they have 25 seconds to reconnect before the match counts as a forfeit. Matches that end by forfeit before round 5 give reduced rewards and don't count toward wins, losses or rating, so friends can't farm wins off each other. Slimes that were sent pay no bounty to the defender, so a send is never free gold for your opponent.
