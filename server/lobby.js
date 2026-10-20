// Sockets, matchmaking (quick match, private rooms, bots) and the match loop.
const GD = require('../shared/data');
const { Match } = require('./game/match');
const prog = require('./progression');
const friends = require('./friends');
const maps = require('./maps');

const BOT_NAMES = { easy: 'Gloop (Easy Bot)', normal: 'Ooze (Normal Bot)', hard: 'Jellyking (Hard Bot)' };
const BOT_LOOKS = { easy: ['skin_glacier', 'banner_forest'], normal: ['skin_crimson', 'banner_ember'], hard: ['skin_shadow', 'banner_void'] };
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TICK_MS = 1000 / GD.RULES.tickRate;

class Lobby {
  constructor(io, store) {
    this.io = io;
    this.store = store;
    this.sockets = new Map();   // uid -> socket
    this.queue = [];            // uids waiting for quick match
    this.rooms = new Map();     // code -> host uid
    this.roomMap = new Map();   // code -> chosen map id (undefined = random)
    this.hostRoom = new Map();  // uid -> code
    this.matches = new Map();   // matchId -> { match, uids }
    this.userMatch = new Map(); // uid -> matchId
    this.rematch = new Map();   // uid -> { opp uid, at, wants }
    this.invites = new Map();   // "target:from" -> time
    this.spectating = new Map(); // spectator uid -> matchId
    this.speed = Math.max(1, Number(process.env.GAME_SPEED) || 1); // >1 only for testing
    this.last = Date.now();
    this.acc = 0;
    setInterval(() => this.loop(), TICK_MS);
  }

  loop() {
    const now = Date.now();
    this.acc += Math.min(1000, now - this.last);
    this.last = now;
    let steps = 0;
    while (this.acc >= TICK_MS && steps < 10) {
      this.acc -= TICK_MS;
      steps++;
      for (const [id, entry] of this.matches) {
        try {
          // a test field nobody owns any more (its player is in another match) is closed quietly
          if (entry.match.sandbox && this.userMatch.get(entry.uids[0]) !== id) { entry.match.forfeit(0); continue; }
          for (let i = 0; i < this.speed; i++) entry.match.tick();
        } catch (e) {
          this.crashed(id, entry, e);
        }
      }
    }
  }

  // A bug in one match must not take the whole server (and every other match) down: end just that match.
  // It counts like an early end: no rating, no win or loss, reduced rewards.
  crashed(id, entry, err) {
    console.error(`[match] ${id} crashed, ending it`, err);
    if (this.matches.get(id) !== entry) return; // finish() already ran
    const { match } = entry;
    match.state = 'ended';
    match.result = { winner: -1, reason: 'error', round: match.round };
    // finish() frees the match and its players before its first await, so a later failure only needs logging
    this.finish(match, entry.uids, match.result).catch((e) => console.error('finish failed', e));
  }

  online() { return this.sockets.size; }
  broadcastOnline() { this.io.emit('online', { count: this.online(), matches: this.matches.size }); }

  async onConnection(socket) {
    const uid = socket.data.uid;
    const old = this.sockets.get(uid);
    if (old && old.id !== socket.id) { old.emit('kicked', { reason: 'Logged in somewhere else' }); old.disconnect(true); }
    this.sockets.set(uid, socket);

    // A malformed payload (e.g. an object whose toString isn't a function, which String() and |0 throw on)
    // must fail just that request, not crash the server: every handler on this socket runs inside try/catch.
    const on = socket.on.bind(socket);
    socket.on = (ev, fn) => on(ev, (...args) => {
      const fail = (e) => {
        console.error(`[socket] ${ev} from ${uid} failed:`, e && e.message);
        const ack = args[args.length - 1];
        if (typeof ack === 'function') ack({ ok: false, error: 'Invalid request' });
      };
      try {
        const r = fn(...args);
        if (r && typeof r.catch === 'function') r.catch(fail);
      } catch (e) { fail(e); }
    });

    let actions = 0, windowStart = Date.now();
    const limited = () => {
      const now = Date.now();
      if (now - windowStart > 1000) { windowStart = now; actions = 0; }
      return ++actions > 25;
    };

    socket.on('queue', () => this.joinQueue(uid));
    socket.on('leaveQueue', () => { this.clearPending(uid); this.emitStatus(uid); });
    socket.on('createRoom', (mapId) => this.createRoom(uid, mapId));
    socket.on('joinRoom', (code) => this.joinRoom(uid, code));
    socket.on('playBot', (diff, mapId) => this.playBot(uid, diff, mapId));
    socket.on('playSandbox', (size) => this.playSandbox(uid, size).catch((e) => console.error(e)));
    socket.on('action', (a, ack) => {
      if (limited()) { if (typeof ack === 'function') ack({ ok: false, error: 'Slow down' }); return; }
      const res = this.withMatch(uid, (match, idx) => match.handleAction(idx, a)) || { ok: false, error: 'Not in a match' };
      if (typeof ack === 'function') ack(res);
    });
    socket.on('forfeit', () => this.withMatch(uid, (match, idx) => match.forfeit(idx)));
    let lastEmote = 0;
    socket.on('emote', (i) => {
      i = i | 0;
      if (!GD.EMOTES[i] || Date.now() - lastEmote < 1500) return;
      lastEmote = Date.now();
      const entry = this.matches.get(this.userMatch.get(uid));
      if (!entry) return;
      const idx = entry.uids.indexOf(uid);
      this.emitTo(entry.uids, 'emote', { from: idx, id: i });
      const bot = entry.match.bots[1 - idx];
      if (bot && Math.random() < 0.6) {
        const reply = [1, 4, 5, 2][Math.floor(Math.random() * 4)];
        setTimeout(() => this.emitTo(entry.uids, 'emote', { from: 1 - idx, id: reply }), 900 + Math.random() * 1200);
      }
    });
    socket.on('rematch', () => this.requestRematch(uid));
    friends.attachSocket(this, socket, uid);
    socket.on('spectate', (id) => this.spectate(uid, String(id || '')).catch((e) => console.error(e)));
    socket.on('stopSpectate', () => this.stopSpectate(uid));
    socket.on('disconnect', () => {
      if (this.sockets.get(uid) !== socket) return;
      const r = this.rematch.get(uid);
      if (r) this.emitTo([r.opp], 'rematchStatus', { state: 'left' });
      this.rematch.delete(uid);
      this.stopSpectate(uid);
      this.sockets.delete(uid);
      this.clearPending(uid);
      this.withMatch(uid, (match, idx) => match.setConnected(idx, false));
      this.broadcastOnline();
      friends.announce(this, uid).catch(() => {});
    });

    // Rejoin a running match after a reconnect / page reload
    const entry = this.matches.get(this.userMatch.get(uid));
    if (entry) {
      const idx = entry.uids.indexOf(uid);
      entry.match.setConnected(idx, true);
      socket.emit('matchStart', this.startInfo(entry.match, idx));
    }
    this.broadcastOnline();
    this.emitStatus(uid);
    friends.announce(this, uid).catch(() => {});
  }

  // After an admin edit: push the new profile to the player's lobby, or kick them (ban/delete)
  async refreshUser(uid, kickReason) {
    const s = this.sockets.get(uid);
    if (!s) return;
    if (kickReason) {
      this.withMatch(uid, (match, idx) => match.forfeit(idx));
      s.emit('kicked', { reason: kickReason });
      s.disconnect(true);
      return;
    }
    const u = await this.store.getById(uid);
    if (u) s.emit('profile', prog.publicProfile(u));
  }

  // ---------- spectating (friends, or admins) ----------
  async spectate(uid, targetId) {
    const s = this.sockets.get(uid);
    const err = (m) => s && s.emit('errorMsg', m);
    const me = await this.store.getById(uid);
    if (!me) return;
    const isFriend = (me.friends || []).includes(targetId);
    if (!isFriend && !prog.publicProfile(me).isAdmin) return err('You can only watch friends');
    if (this.busy(uid)) return err('Finish your own match first');
    const entry = this.matches.get(this.userMatch.get(targetId));
    if (!entry) return err('Your friend is not in a match right now');
    if (entry.match.sandbox) return err('Your friend is in the test field');
    this.stopSpectate(uid);
    this.clearPending(uid);
    const idx = entry.uids.indexOf(targetId);
    entry.spectators.set(uid, idx);
    this.spectating.set(uid, entry.match.id);
    const info = this.startInfo(entry.match, idx);
    info.players.forEach((p) => { p.cheats = false; });
    info.spectator = true;
    info.watching = entry.match.players[idx].name;
    s.emit('spectateStart', info);
    this.emitStatus(uid);
    this.emitTo(entry.uids, 'spectators', { count: entry.spectators.size });
  }

  stopSpectate(uid) {
    const mid = this.spectating.get(uid);
    if (!mid) return;
    this.spectating.delete(uid);
    const entry = this.matches.get(mid);
    if (entry && entry.spectators) {
      entry.spectators.delete(uid);
      this.emitTo(entry.uids, 'spectators', { count: entry.spectators.size });
    }
  }

  emitTo(uids, ev, data) {
    for (const u of uids) { const s = u && this.sockets.get(u); if (s) s.emit(ev, data); }
  }

  requestRematch(uid) {
    const r = this.rematch.get(uid);
    if (!r || Date.now() - r.at > 60000 || this.busy(uid)) {
      const s = this.sockets.get(uid);
      return s && s.emit('rematchStatus', { state: 'expired' });
    }
    r.wants = true;
    const o = this.rematch.get(r.opp);
    if (o && o.opp === uid && o.wants && this.sockets.has(r.opp) && !this.busy(r.opp)) {
      this.rematch.delete(uid); this.rematch.delete(r.opp);
      this.clearPending(uid); this.clearPending(r.opp);
      this.startMatch([{ uid: r.opp }, { uid }], 'pvp', maps.validMap(r.mapId)).catch((e) => console.error(e));
      return;
    }
    this.emitTo([uid], 'rematchStatus', { state: 'waiting' });
    this.emitTo([r.opp], 'rematchStatus', { state: 'offered' });
  }

  withMatch(uid, fn) {
    const entry = this.matches.get(this.userMatch.get(uid));
    if (!entry) return undefined;
    return fn(entry.match, entry.uids.indexOf(uid));
  }

  emitStatus(uid) {
    const s = this.sockets.get(uid);
    if (!s) return;
    s.emit('status', { queued: this.queue.includes(uid), room: this.hostRoom.get(uid) || null, inMatch: this.userMatch.has(uid) });
  }

  clearPending(uid) {
    this.queue = this.queue.filter((u) => u !== uid);
    const code = this.hostRoom.get(uid);
    if (code) { this.rooms.delete(code); this.roomMap.delete(code); this.hostRoom.delete(uid); }
  }

  busy(uid) { return this.userMatch.has(uid); }

  joinQueue(uid) {
    if (this.busy(uid)) return;
    this.clearPending(uid);
    this.queue.push(uid);
    this.emitStatus(uid);
    while (this.queue.length >= 2) {
      const a = this.queue.shift(), b = this.queue.shift();
      this.startMatch([{ uid: a }, { uid: b }], 'pvp').catch((e) => console.error(e));
    }
  }

  createRoom(uid, mapId) {
    if (this.busy(uid)) return;
    this.clearPending(uid);
    let code;
    do { code = Array.from({ length: 4 }, () => ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)]).join(''); } while (this.rooms.has(code));
    this.rooms.set(code, uid);
    this.roomMap.set(code, maps.validMap(String(mapId || '')));
    this.hostRoom.set(uid, code);
    this.emitStatus(uid);
  }

  joinRoom(uid, code) {
    const s = this.sockets.get(uid);
    code = String(code || '').trim().toUpperCase();
    const host = this.rooms.get(code);
    if (!host) return s && s.emit('errorMsg', 'Room not found');
    if (host === uid) return s && s.emit('errorMsg', "That's your own room");
    if (this.busy(uid)) return;
    const mapId = maps.validMap(this.roomMap.get(code)); // the room's custom map may have been deleted since
    this.clearPending(host);
    this.clearPending(uid);
    this.startMatch([{ uid: host }, { uid }], 'pvp', mapId).catch((e) => console.error(e));
  }

  playBot(uid, diff, mapId) {
    if (this.busy(uid)) return;
    if (!BOT_NAMES[diff]) diff = 'normal';
    this.clearPending(uid);
    this.startMatch([{ uid }, { bot: diff }], 'bot', maps.validMap(String(mapId || ''))).catch((e) => console.error(e));
  }

  // Test field for admins and players with powers: any board size, every tower, standing slimes, nothing counts
  async playSandbox(uid, size) {
    if (this.busy(uid)) return;
    this.userMatch.set(uid, 'pending'); // claimed before the await, so a double Open can't start two fields
    const s = this.sockets.get(uid);
    const u = await this.store.getById(uid);
    if (!u || !prog.publicProfile(u).powers) {
      if (this.userMatch.get(uid) === 'pending') this.userMatch.delete(uid);
      return s && s.emit('errorMsg', 'The test field needs powers access');
    }
    const L = GD.SANDBOX, n = (v, lo, hi, def) => Math.max(lo, Math.min(hi, Math.floor(Number(v)) || def));
    const cols = n(size && size.cols, L.minCols, L.maxCols, GD.COLS), rows = n(size && size.rows, L.minRows, L.maxRows, GD.ROWS);
    this.clearPending(uid);
    this.startMatch([{ uid, allTowers: true }, { idle: true }], 'sandbox', undefined, { cols, rows }).catch((e) => console.error(e));
  }

  async startMatch(entries, mode, mapId, sandbox) {
    // Claim every player before the first await: two start requests handled back to back must not both
    // start a match (the extra one would run unowned and keep sending its snapshots to the player)
    const humans = entries.filter((e) => e.uid);
    if (humans.some((e) => this.matches.has(this.userMatch.get(e.uid)))) return;
    humans.forEach((e) => this.userMatch.set(e.uid, 'pending'));
    const players = [];
    for (const e of entries) {
      if (e.idle) {
        players.push({ isBot: true, idle: true, name: 'Test field', level: 0, unlocked: [], skin: 'skin_classic', banner: 'banner_slate' });
      } else if (e.bot) {
        const [skin, banner] = BOT_LOOKS[e.bot];
        players.push({ isBot: true, difficulty: e.bot, name: BOT_NAMES[e.bot], level: 0, unlocked: GD.TOWER_ORDER.slice(), skin, banner });
      } else {
        const u = await this.store.getById(e.uid);
        if (!u) { entries.forEach((x) => x.uid && this.userMatch.get(x.uid) === 'pending' && this.userMatch.delete(x.uid)); return; }
        this.userMatch.set(e.uid, 'pending');
        const pub = prog.publicProfile(u);
        players.push({ uid: u.id, name: u.username, level: GD.levelInfo(u.xp).level, rating: u.rating || 1000, ranks: pub.ranks,
          unlocked: e.allTowers ? GD.TOWER_ORDER.slice() : u.unlocked.slice(), skin: u.skin, banner: u.banner, cheats: pub.powers && !sandbox });
      }
    }
    const uids = players.map((p) => p.uid || null);
    const match = new Match({
      players,
      mode,
      mapId,
      sandbox,
      onSnapshot: (idx, snap) => {
        // only to a player whose current match this is (never let a stray match draw over their real one)
        const s = this.userMatch.get(uids[idx]) === match.id && this.sockets.get(uids[idx]);
        if (s) s.volatile.emit('snap', snap);
        const entry = this.matches.get(match.id);
        if (entry && entry.spectators) {
          for (const [suid, sidx] of entry.spectators) {
            if (sidx !== idx) continue;
            const ss = this.sockets.get(suid);
            if (ss) ss.volatile.emit('snap', snap);
          }
        }
      },
      onEnd: (result) => this.finish(match, uids, result).catch((e) => console.error('finish failed', e)),
    });
    // mapId stays undefined for a random map, so a rematch only keeps a map the players chose
    this.matches.set(match.id, { match, uids, spectators: new Map(), mapId });
    uids.forEach((uid, idx) => {
      if (!uid) return;
      this.stopSpectate(uid);
      this.userMatch.set(uid, match.id);
      match.setConnected(idx, this.sockets.has(uid));
      const s = this.sockets.get(uid);
      if (s) s.emit('matchStart', this.startInfo(match, idx));
      this.emitStatus(uid);
    });
    players.forEach((p, idx) => {
      if (p.isBot && !p.idle && Math.random() < 0.7) setTimeout(() => this.emitTo(uids, 'emote', { from: idx, id: 0 }), 2500);
    });
    uids.forEach((u) => u && friends.announce(this, u).catch(() => {}));
    console.log(`[match] ${match.id} ${mode} on ${match.mapId}: ${players.map((p) => p.name).join(' vs ')}`);
    this.broadcastOnline();
  }

  startInfo(match, idx) {
    return {
      matchId: match.id, you: idx, mode: match.mode, map: match.mapId, sandbox: !!match.sandbox,
      mapDef: { name: match.map.name, path: match.map.path, theme: match.map.theme, cols: match.map.cols, rows: match.map.rows },
      players: match.players.map((p, i) => ({ name: p.name, level: p.level, rating: p.rating, ranks: p.ranks || [], skin: p.skin, banner: p.banner, isBot: !!p.isBot, unlocked: p.unlocked, cheats: i === idx && !!p.cheats })),
    };
  }

  async finish(match, uids, result) {
    const ended = this.matches.get(match.id);
    if (ended && ended.spectators) {
      for (const suid of ended.spectators.keys()) {
        this.spectating.delete(suid);
        this.emitTo([suid], 'spectateEnd', {
          winner: result.winner >= 0 ? match.players[result.winner].name : null, reason: result.reason, round: result.round,
        });
      }
    }
    this.matches.delete(match.id);
    // players whose current match this is (anyone already in another match keeps it and gets no end screen)
    const owner = uids.map((uid) => !!uid && this.userMatch.get(uid) === match.id);
    uids.forEach((uid, i) => owner[i] && this.userMatch.delete(uid));
    if (match.sandbox) { // the test field gives nothing and records nothing
      this.emitTo(uids.filter((u, i) => owner[i]), 'matchEnd', { mode: 'sandbox', reason: result.reason });
      uids.forEach((u) => { if (u) { this.emitStatus(u); friends.announce(this, u).catch(() => {}); } });
      console.log(`[match] ${match.id} test field closed (${result.reason})`);
      this.broadcastOnline();
      return;
    }
    // Matches ended by an early forfeit, by a server error, or where admin powers were used, don't count toward records
    const early = ((result.reason === 'forfeit' || result.reason === 'disconnect') && result.round < GD.RULES.earlyEndRound)
      || result.reason === 'error' || !!match.cheated;
    const users = await Promise.all(uids.map((uid) => (uid ? this.store.getById(uid) : null)));
    // Elo rating for real PvP results
    const ratingDelta = [0, 0];
    if (match.mode === 'pvp' && !early && users[0] && users[1]) {
      const score0 = result.winner === -1 ? 0.5 : result.winner === 0 ? 1 : 0;
      const d = prog.eloDelta(users[0].rating || 1000, users[1].rating || 1000, score0);
      ratingDelta[0] = d; ratingDelta[1] = -d;
    }
    for (let idx = 0; idx < 2; idx++) {
      const uid = uids[idx], u = users[idx];
      if (!uid || !u) continue;
      const won = result.winner === idx;
      const draw = result.winner === -1;
      const quitter = !won && !draw && (result.reason === 'forfeit' || result.reason === 'disconnect');
      const rewards = prog.applyResult(u, {
        mode: match.mode, won, draw, round: result.round, early, quitter, stopped: result.reason === 'error',
        difficulty: match.players[1 - idx].difficulty, opponent: match.players[1 - idx].name,
      });
      u.rating = Math.max(100, (u.rating || 1000) + ratingDelta[idx]);
      rewards.rating = ratingDelta[idx];
      if (match.mode === 'pvp' && uids[1 - idx]) this.rematch.set(uid, { opp: uids[1 - idx], at: Date.now(), wants: false, mapId: ended && ended.mapId });
      await this.store.save(u);
      const s = owner[idx] && this.sockets.get(uid);
      if (s) {
        s.emit('matchEnd', {
          won, draw, reason: result.reason, round: result.round, early, cheated: !!match.cheated, rewards, mode: match.mode,
          stats: match.boards.map((b) => Object.assign({ lives: Math.max(0, b.lives) }, b.stats)),
          profile: prog.publicProfile(u),
        });
      }
      this.emitStatus(uid);
    }
    uids.forEach((u) => u && friends.announce(this, u).catch(() => {}));
    console.log(`[match] ${match.id} ended: winner=${result.winner} reason=${result.reason} round=${result.round}`);
    this.broadcastOnline();
  }
}

module.exports = { Lobby };
