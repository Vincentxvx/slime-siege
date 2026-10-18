// Friend list: requests by username, accept/decline/remove, live status, and direct match invites.
// Stored on each user document: friends, friendIn (incoming requests), friendOut (sent requests) — arrays of user ids.
const MAX_FRIENDS = 100;
const INVITE_TTL = 60000;

const lists = (u) => {
  u.friends = u.friends || [];
  u.friendIn = u.friendIn || [];
  u.friendOut = u.friendOut || [];
  return u;
};
const drop = (arr, id) => { const i = arr.indexOf(id); if (i >= 0) arr.splice(i, 1); };

function mount(app, { store, lobby, authed, wrap }) {
  const status = (uid) => (lobby.userMatch.has(uid) ? 'playing' : lobby.sockets.has(uid) ? 'online' : 'offline');

  async function view(me) {
    lists(me);
    const load = async (ids) => (await Promise.all(ids.map((id) => store.getById(id)))).filter(Boolean);
    const [friends, incoming, outgoing] = await Promise.all([load(me.friends), load(me.friendIn), load(me.friendOut)]);
    const order = { playing: 0, online: 0, offline: 1 };
    return {
      friends: friends
        .map((f) => ({ id: f.id, username: f.username, banner: f.banner, rating: f.rating || 1000, status: status(f.id) }))
        .sort((a, b) => order[a.status] - order[b.status] || a.username.localeCompare(b.username)),
      incoming: incoming.map((f) => ({ id: f.id, username: f.username })),
      outgoing: outgoing.map((f) => ({ id: f.id, username: f.username })),
    };
  }

  const done = async (req, res, notify) => {
    for (const id of notify || []) lobby.emitTo([id], 'friendsChanged', {});
    res.json(await view(req.user));
  };

  app.get('/api/friends', authed, wrap(async (req, res) => res.json(await view(req.user))));

  app.post('/api/friends/request', authed, wrap(async (req, res) => {
    const me = lists(req.user);
    const other = await store.getByName(String((req.body || {}).username || '').trim());
    if (!other || other.banned) return res.status(404).json({ error: 'No player with that name' });
    lists(other);
    if (other.id === me.id) return res.status(400).json({ error: "You can't add yourself" });
    if (me.friends.includes(other.id)) return res.status(400).json({ error: `${other.username} is already your friend` });
    if (me.friends.length >= MAX_FRIENDS) return res.status(400).json({ error: `Friend list is full (${MAX_FRIENDS})` });
    if (me.friendIn.includes(other.id)) {
      // They already asked us: accept right away
      drop(me.friendIn, other.id); drop(other.friendOut, me.id);
      me.friends.push(other.id); other.friends.push(me.id);
    } else if (!me.friendOut.includes(other.id)) {
      me.friendOut.push(other.id); other.friendIn.push(me.id);
    }
    await store.save(me); await store.save(other);
    await done(req, res, [other.id]);
  }));

  // accept / decline / cancel / remove share the same shape
  const action = (fn) => wrap(async (req, res) => {
    const me = lists(req.user);
    const other = await store.getById(String((req.body || {}).id || ''));
    if (!other) return res.status(404).json({ error: 'Player not found' });
    lists(other);
    const err = fn(me, other);
    if (err) return res.status(400).json({ error: err });
    await store.save(me); await store.save(other);
    await done(req, res, [other.id]);
  });

  app.post('/api/friends/accept', authed, action((me, o) => {
    if (!me.friendIn.includes(o.id)) return 'No request from that player';
    if (me.friends.length >= MAX_FRIENDS) return `Friend list is full (${MAX_FRIENDS})`;
    drop(me.friendIn, o.id); drop(o.friendOut, me.id);
    if (!me.friends.includes(o.id)) me.friends.push(o.id);
    if (!o.friends.includes(me.id)) o.friends.push(me.id);
  }));
  app.post('/api/friends/decline', authed, action((me, o) => { drop(me.friendIn, o.id); drop(o.friendOut, me.id); }));
  app.post('/api/friends/cancel', authed, action((me, o) => { drop(me.friendOut, o.id); drop(o.friendIn, me.id); }));
  app.post('/api/friends/remove', authed, action((me, o) => { drop(me.friends, o.id); drop(o.friends, me.id); }));
}

// Socket side: status pushes and match invites. Called from Lobby.onConnection.
function attachSocket(lobby, socket, uid) {
  socket.on('invite', async (targetId) => {
    targetId = String(targetId || '');
    const me = await lobby.store.getById(uid);
    const err = (m) => socket.emit('errorMsg', m);
    if (!me || !lists(me).friends.includes(targetId)) return err('You can only invite friends');
    if (!lobby.sockets.has(targetId)) return err('Your friend is offline');
    if (lobby.busy(targetId)) return err('Your friend is in a match right now');
    if (lobby.busy(uid)) return;
    lobby.invites.set(targetId + ':' + uid, Date.now());
    lobby.emitTo([targetId], 'invite', { from: uid, username: me.username });
    socket.emit('inviteSent', { to: targetId });
  });

  socket.on('inviteReply', ({ from, accept } = {}) => {
    from = String(from || '');
    const key = uid + ':' + from;
    const at = lobby.invites.get(key);
    lobby.invites.delete(key);
    if (!at || Date.now() - at > INVITE_TTL) return socket.emit('errorMsg', 'That invite expired');
    if (!accept) return lobby.emitTo([from], 'errorMsg', 'Your invite was declined');
    if (!lobby.sockets.has(from) || lobby.busy(from)) return socket.emit('errorMsg', 'Your friend is no longer available');
    if (lobby.busy(uid)) return;
    lobby.clearPending(uid); lobby.clearPending(from);
    lobby.startMatch([{ uid: from }, { uid }], 'pvp').catch((e) => console.error(e));
  });
}

// Tell online friends that this player's status changed
async function announce(lobby, uid) {
  const u = await lobby.store.getById(uid);
  if (u) lobby.emitTo(lists(u).friends, 'friendsChanged', {});
}

module.exports = { mount, attachSocket, announce };
