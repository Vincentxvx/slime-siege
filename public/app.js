// Accounts, lobby, shop, matchmaking UI and the socket connection.
(function () {
  const GD = window.GD, R = window.Render;
  const $ = (id) => document.getElementById(id);
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (_) { /* private mode */ } },
  };

  const S = { token: store.get('ss_token'), profile: null, socket: null, tab: 'towers', status: {}, botDiff: 'normal' };

  // ---------- helpers ----------
  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: Object.assign({ 'content-type': 'application/json' }, S.token ? { authorization: 'Bearer ' + S.token } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({ error: 'Server unreachable' }));
    if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.status = res.status; throw e; }
    return data;
  }

  function show(screen) {
    for (const s of ['auth', 'lobby', 'game']) $('screen-' + s).hidden = s !== screen;
  }

  function toast(msg, kind) {
    if (window.Game.isActive()) return window.Game.toast(msg, kind);
    const box = $('lobby-toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    box.append(el);
    setTimeout(() => el.remove(), 3000);
  }

  function ago(t) {
    const m = Math.floor((Date.now() - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.floor(m / 60);
    return h < 24 ? h + ' h ago' : Math.floor(h / 24) + ' d ago';
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- auth ----------
  let authMode = 'login';
  document.querySelectorAll('#auth-form [data-mode]').forEach((b) => b.addEventListener('click', () => (authMode = b.dataset.mode)));
  $('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('auth-error').textContent = '';
    try {
      const data = await api('/api/' + authMode, { username: $('auth-user').value.trim(), password: $('auth-pass').value });
      S.token = data.token; store.set('ss_token', data.token);
      enterLobby(data.profile);
    } catch (err) { $('auth-error').textContent = err.message; }
  });

  $('btn-logout').addEventListener('click', logout);
  function logout() {
    S.token = null; store.set('ss_token', null);
    if (S.socket) { S.socket.disconnect(); S.socket = null; }
    window.Game.stop();
    show('auth');
  }

  // ---------- lobby ----------
  function enterLobby(profile) {
    S.profile = profile;
    if (!profile.games && !S.tabChosen) {
      S.tab = 'howto';
      document.querySelectorAll('.tabs [data-tab]').forEach((x) => x.classList.toggle('on', x.dataset.tab === 'howto'));
    }
    renderProfile();
    renderShop();
    show('lobby');
    connect();
  }

  function plate(el, name, banner, sub) {
    el.style.background = (GD.BANNERS[banner] || GD.BANNERS.banner_slate).css;
    el.innerHTML = `<span class="plate-name">${esc(name)}</span><span class="plate-lvl">${esc(sub)}</span>`;
  }

  function renderProfile() {
    const p = S.profile;
    plate($('profile-plate'), p.username, p.banner, `Level ${p.level} ${p.title}`);
    $('xp-fill').style.transform = `scaleX(${p.xpInto / p.xpNeed})`;
    $('xp-text').textContent = `${p.xpInto} / ${p.xpNeed} XP to level ${p.level + 1}`;
    $('coins').textContent = p.coins;
    const total = p.wins + p.losses;
    const rows = [
      ['Rating', p.rating], ['Wins', p.wins], ['Losses', p.losses],
      ['Win rate', total ? Math.round((p.wins / total) * 100) + '%' : '–'], ['Bot wins', p.botWins], ['Best round', p.bestRound || '–'],
    ];
    $('profile-stats').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
    $('daily').hidden = !p.dailyAvailable;
    $('tab-admin').hidden = !p.isAdmin;
    const hist = p.history || [];
    $('history').innerHTML = hist.length
      ? hist.map((h) => `<li class="${h.draw ? 'draw' : h.won ? 'win' : 'loss'}"><b>${h.draw ? 'Draw' : h.won ? 'Win' : 'Loss'}</b><span>vs ${esc(h.opp || '?')}</span><small>R${h.round} · ${ago(h.at)}</small></li>`).join('')
      : '<li class="empty">No matches yet. Try a bot to warm up.</li>';
  }

  document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => {
    S.tab = b.dataset.tab; S.tabChosen = true;
    document.querySelectorAll('.tabs [data-tab]').forEach((x) => x.classList.toggle('on', x === b));
    renderShop();
  }));

  async function shop(path, id) {
    try {
      const data = await api('/api/shop/' + path, { id });
      S.profile = data.profile;
      renderProfile(); renderShop();
      toast(path === 'buy' ? 'Unlocked!' : 'Equipped', 'good');
    } catch (e) { toast(e.message, 'bad'); }
  }

  function buyButton(id, cost, level, owned, equipped) {
    const b = document.createElement('button');
    b.className = 'btn';
    if (equipped) { b.textContent = 'Equipped'; b.disabled = true; }
    else if (owned) { b.textContent = equipped === undefined ? 'Unlocked' : 'Equip'; b.disabled = equipped === undefined; b.onclick = () => shop('equip', id); }
    else if (S.profile.level < level) { b.textContent = `Reach level ${level}`; b.disabled = true; }
    else {
      b.innerHTML = `Unlock <i class="coin"></i>${cost}`;
      b.disabled = S.profile.coins < cost;
      b.classList.add('primary');
      b.onclick = () => shop('buy', id);
    }
    return b;
  }

  async function renderShop() {
    const body = $('shop-body');
    const p = S.profile;
    body.innerHTML = '';
    if (S.tab === 'leaders') {
      body.innerHTML = '<p class="muted">Loading…</p>';
      try {
        const { players } = await api('/api/leaderboard');
        if (S.tab !== 'leaders') return;
        body.innerHTML = players.length ? '' : '<p class="muted">No matches played yet. Win one to get on the board.</p>';
        const ol = document.createElement('ol');
        ol.className = 'leaders';
        players.forEach((x) => {
          const li = document.createElement('li');
          if (x.username === p.username) li.className = 'me';
          const pl = document.createElement('div'); pl.className = 'plate';
          plate(pl, x.username, x.banner, 'Lv ' + x.level);
          const wl = document.createElement('span'); wl.className = 'wl'; wl.innerHTML = `<b class="rating" title="Rating">${x.rating}</b> <b>${x.wins}</b> W <b>${x.losses}</b> L`;
          li.append(pl, wl);
          ol.append(li);
        });
        body.append(ol);
      } catch (e) { body.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
      return;
    }
    if (S.tab === 'howto') { body.append(howTo()); return; }
    if (S.tab === 'admin') { renderAdmin(body); return; }
    const grid = document.createElement('div');
    grid.className = 'items';
    if (S.tab === 'towers') {
      for (const id of GD.TOWER_ORDER) {
        const T = GD.TOWERS[id];
        const card = item(R.towerIcon(id, p.skin, 54), T.name, `${T.desc} Costs ${T.cost} gold in a match.`);
        card.append(buyButton(id, T.unlock.coins, T.unlock.level, p.unlocked.includes(id)));
        grid.append(card);
      }
    } else if (S.tab === 'skins') {
      for (const id in GD.SKINS) {
        const k = GD.SKINS[id];
        const prev = document.createElement('div'); prev.className = 'skin-prev';
        prev.append(R.towerIcon('archer', id, 44), R.towerIcon('cannon', id, 44));
        const card = item(prev, k.name, 'Recolors all your towers. Your opponent sees it too.');
        card.append(buyButton(id, k.cost, k.level, p.owned.includes(id), p.skin === id));
        grid.append(card);
      }
    } else {
      for (const id in GD.BANNERS) {
        const k = GD.BANNERS[id];
        const pl = document.createElement('div'); pl.className = 'plate';
        plate(pl, p.username, id, k.name);
        const card = item(pl, k.name, 'Your name plate in the lobby, matches and leaderboard.');
        card.append(buyButton(id, k.cost, k.level, p.owned.includes(id), p.banner === id));
        grid.append(card);
      }
    }
    body.append(grid);
  }

  function howTo() {
    const wrap = document.createElement('div');
    wrap.className = 'howto';
    wrap.innerHTML = `
      <div class="howto-cols">
        <section><h4>Hold your lane</h4><p>You and your opponent each defend your own path. Every slime that reaches the end costs lives, and bigger slimes cost more. Hit zero lives and you lose.</p></section>
        <section><h4>Build and upgrade</h4><p>Pick a tower with keys <kbd>1</kbd>–<kbd>6</kbd> and click a grass tile. Click a placed tower to upgrade it (<kbd>U</kbd>), change who it targets, or sell it (<kbd>Del</kbd>).</p></section>
        <section><h4>Send slimes</h4><p>Sends drop extra slimes into your opponent's lane and permanently raise your income, paid every 6 seconds. Keys <kbd>Q</kbd><kbd>W</kbd><kbd>E</kbd> <kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> <kbd>Z</kbd><kbd>X</kbd><kbd>C</kbd>. Spend too much on sends and your own defense cracks.</p></section>
        <section><h4>Level up</h4><p>Matches earn XP and coins, even losses. Spend coins on new towers, skins and banners. Your first win each day pays ${GD.DAILY_WIN_BONUS} bonus coins.</p></section>
      </div>
      <h4 class="gallery-title">Know your slimes</h4>`;
    const notes = {
      green: 'Weak, comes in crowds.', blue: 'A bit tougher and faster.', yellow: 'Very fast. Frost helps.',
      purple: 'Splits into 2 blue slimes.', ghost: 'Invisible to most towers. Sniper, Tesla, or upgraded Archer/Frost see it.',
      armored: 'Armor blocks weak hits. Use Cannon, Tesla or Armor Breaker. Splits into a Big Slime.',
      king: 'Boss on round 20, 25, 30… Huge HP, armored, splits into 3 Knights.',
    };
    const g = document.createElement('div');
    g.className = 'slimes';
    for (const k of GD.ENEMY_ORDER) {
      const E = GD.ENEMIES[k];
      const d = document.createElement('div');
      d.className = 'slime-card';
      d.append(R.slimeIcon(k, 44));
      const t = document.createElement('div');
      t.innerHTML = `<b>${E.name}</b><small>${E.hp} HP, costs ${E.leakTotal} ${E.leakTotal === 1 ? 'life' : 'lives'}</small><p>${notes[k]}</p>`;
      d.append(t);
      g.append(d);
    }
    wrap.append(g);
    return wrap;
  }

  // ---------- admin ----------
  const xpAtLevel = (lvl) => { let xp = 0; for (let l = 1; l < lvl; l++) xp += GD.xpForNext(l); return xp; };

  async function renderAdmin(body) {
    body.innerHTML = '<p class="muted">Loading players…</p>';
    let data;
    try { data = await api('/api/admin/overview'); } catch (e) { body.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
    if (S.tab !== 'admin') return;
    S.adminUsers = data.users;
    body.innerHTML = `
      <div class="admin-top">
        <div class="admin-stats"><span><b>${data.players}</b> players</span><span><b>${data.online}</b> online</span><span><b>${data.matches}</b> matches running</span></div>
        <form id="grant-all" class="admin-grant"><label>Give every player <input type="number" min="1" max="1000000" name="coins" value="100"> coins</label><button class="btn">Give to all</button></form>
      </div>
      <div class="admin-grid">
        <div class="admin-list">
          <input id="admin-search" placeholder="Search players" aria-label="Search players">
          <table><thead><tr><th>Player</th><th>Lv</th><th>Coins</th><th>Rating</th><th>W–L</th></tr></thead><tbody id="admin-rows"></tbody></table>
        </div>
        <div class="admin-edit panel-inner" id="admin-edit"><p class="muted">Pick a player to edit.</p></div>
      </div>`;
    const rows = () => {
      const q = $('admin-search').value.trim().toLowerCase();
      $('admin-rows').innerHTML = S.adminUsers.filter((u) => u.username.toLowerCase().includes(q)).map((u) =>
        `<tr data-id="${u.id}" class="${u.id === S.adminSel ? 'sel' : ''}"><td>${esc(u.username)}${u.admin ? ' <em class="tag">admin</em>' : ''}${u.banned ? ' <em class="tag bad">banned</em>' : ''}</td>` +
        `<td>${u.level}</td><td>${u.coins}</td><td>${u.rating}</td><td>${u.wins}–${u.losses}</td></tr>`).join('') ||
        '<tr><td colspan="5" class="muted">No players match.</td></tr>';
    };
    rows();
    $('admin-search').oninput = rows;
    $('admin-rows').onclick = (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (!tr) return;
      S.adminSel = tr.dataset.id;
      rows();
      adminEditor(S.adminUsers.find((u) => u.id === S.adminSel), rows);
    };
    $('grant-all').onsubmit = async (e) => {
      e.preventDefault();
      const coins = Number(e.target.coins.value);
      try { const r = await api('/api/admin/grant-all', { coins }); toast(`Gave ${coins} coins to ${r.players} players`, 'good'); renderAdmin(body); }
      catch (err) { toast(err.message, 'bad'); }
    };
    if (S.adminSel) { const u = S.adminUsers.find((x) => x.id === S.adminSel); if (u) adminEditor(u, rows); }
  }

  function adminEditor(u, refreshRows) {
    const box = $('admin-edit');
    const isMe = u.id === S.profile.id;
    const num = (key, label) => `<label>${label}<input type="number" min="0" name="${key}" value="${u[key]}"></label>`;
    const checks = (name, ids, owned, labelOf, locked) => ids.map((id) =>
      `<label class="chk"><input type="checkbox" name="${name}" value="${id}" ${owned.includes(id) ? 'checked' : ''} ${locked.includes(id) ? 'disabled' : ''}>${esc(labelOf(id))}</label>`).join('');
    box.innerHTML = `
      <div class="ae-head"><h4>${esc(u.username)}</h4><span class="muted small">Joined ${new Date(u.createdAt).toLocaleDateString()}</span></div>
      <form id="ae-form">
        <div class="ae-nums">
          ${num('coins', 'Coins')}
          <label>Level<input type="number" min="1" max="200" name="level" value="${u.level}"></label>
          ${num('xp', 'XP')}${num('rating', 'Rating')}${num('wins', 'Wins')}${num('losses', 'Losses')}
          ${num('botWins', 'Bot wins')}${num('bestRound', 'Best round')}${num('games', 'Matches')}
        </div>
        <div class="row ae-quick">
          <button type="button" class="btn ghost" data-q="coins">+1000 coins</button>
          <button type="button" class="btn ghost" data-q="all">Unlock everything</button>
          <button type="button" class="btn ghost" data-q="reset">Reset stats</button>
        </div>
        <fieldset><legend>Towers</legend>${checks('unlocked', GD.TOWER_ORDER, u.unlocked, (id) => GD.TOWERS[id].name, GD.DEFAULT_TOWERS)}</fieldset>
        <fieldset><legend>Cosmetics</legend>${checks('owned', Object.keys(GD.SKINS).concat(Object.keys(GD.BANNERS)), u.owned,
          (id) => (GD.SKINS[id] ? 'Skin: ' + GD.SKINS[id].name : 'Banner: ' + GD.BANNERS[id].name), GD.DEFAULT_COSMETICS)}</fieldset>
        <label class="chk ban"><input type="checkbox" name="banned" ${u.banned ? 'checked' : ''} ${isMe ? 'disabled' : ''}>Banned (can't log in)</label>
        <button class="btn primary" type="submit">Save changes</button>
      </form>
      <form id="ae-pass" class="ae-inline"><input type="text" name="password" placeholder="New password" minlength="6" autocomplete="off"><button class="btn" type="submit">Set password</button></form>
      ${isMe ? '' : '<button class="btn danger" id="ae-delete">Delete account</button>'}`;
    const f = $('ae-form');
    f.level.oninput = () => { const l = Math.max(1, Number(f.level.value) || 1); f.xp.value = xpAtLevel(l); };
    f.xp.oninput = () => { f.level.value = GD.levelInfo(Number(f.xp.value) || 0).level; };
    box.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => {
      if (b.dataset.q === 'coins') f.coins.value = Number(f.coins.value) + 1000;
      if (b.dataset.q === 'all') f.querySelectorAll('input[type=checkbox]:not([name=banned])').forEach((c) => (c.checked = true));
      if (b.dataset.q === 'reset') { for (const k of ['wins', 'losses', 'botWins', 'bestRound', 'games']) f[k].value = 0; f.rating.value = 1000; }
    }));
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = {};
      for (const k of ['coins', 'xp', 'rating', 'wins', 'losses', 'botWins', 'bestRound', 'games']) body[k] = f[k].value;
      body.unlocked = [...f.querySelectorAll('input[name=unlocked]:checked')].map((c) => c.value);
      body.owned = [...f.querySelectorAll('input[name=owned]:checked')].map((c) => c.value);
      body.banned = f.banned.checked;
      try {
        const r = await api('/api/admin/user/' + u.id, body);
        Object.assign(u, r.user);
        refreshRows();
        adminEditor(u, refreshRows);
        toast(`Saved ${u.username}`, 'good');
        if (isMe) { S.profile = (await api('/api/me')).profile; renderProfile(); }
      } catch (err) { toast(err.message, 'bad'); }
    };
    $('ae-pass').onsubmit = async (e) => {
      e.preventDefault();
      try { await api(`/api/admin/user/${u.id}/password`, { password: e.target.password.value }); e.target.reset(); toast('Password changed', 'good'); }
      catch (err) { toast(err.message, 'bad'); }
    };
    const del = $('ae-delete');
    if (del) del.onclick = async () => {
      if (!del.classList.contains('armed')) {
        del.classList.add('armed'); del.textContent = `Click again to delete ${u.username} forever`;
        setTimeout(() => { del.classList.remove('armed'); del.textContent = 'Delete account'; }, 3000);
        return;
      }
      try {
        await api(`/api/admin/user/${u.id}/delete`, {});
        S.adminUsers = S.adminUsers.filter((x) => x.id !== u.id);
        S.adminSel = null;
        refreshRows();
        $('admin-edit').innerHTML = '<p class="muted">Account deleted.</p>';
        toast(`Deleted ${u.username}`, 'good');
      } catch (err) { toast(err.message, 'bad'); }
    };
  }

  function item(visual, name, desc) {
    const d = document.createElement('div');
    d.className = 'item';
    const v = document.createElement('div'); v.className = 'item-visual'; v.append(visual);
    const h = document.createElement('h4'); h.textContent = name;
    const pp = document.createElement('p'); pp.className = 'muted small'; pp.textContent = desc;
    d.append(v, h, pp);
    return d;
  }

  // ---------- play buttons ----------
  $('btn-queue').addEventListener('click', () => {
    if (!S.socket) return;
    S.socket.emit(S.status.queued ? 'leaveQueue' : 'queue');
  });
  document.querySelectorAll('#bot-diff [data-d]').forEach((b) => b.addEventListener('click', () => {
    S.botDiff = b.dataset.d;
    document.querySelectorAll('#bot-diff [data-d]').forEach((x) => x.classList.toggle('on', x === b));
  }));
  $('btn-bot').addEventListener('click', () => S.socket && S.socket.emit('playBot', S.botDiff));
  $('room-host').addEventListener('click', (e) => {
    if (!S.socket) return;
    if (e.target.id === 'btn-room') S.socket.emit('createRoom');
    if (e.target.id === 'btn-room-cancel') S.socket.emit('leaveQueue');
  });
  $('room-join').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('room-code').value.trim();
    if (code.length === 4 && S.socket) S.socket.emit('joinRoom', code);
  });

  let queueTimer = null;
  function renderStatus() {
    const st = S.status;
    const q = $('btn-queue');
    clearInterval(queueTimer);
    if (st.queued) {
      const since = Date.now();
      q.textContent = 'Searching… click to cancel';
      q.classList.add('searching');
      const tick = () => { $('queue-text').textContent = `Waiting for an opponent (${Math.floor((Date.now() - since) / 1000)}s). Tell a friend to click Find a match too.`; };
      tick(); queueTimer = setInterval(tick, 1000);
    } else {
      q.textContent = 'Find a match';
      q.classList.remove('searching');
      $('queue-text').textContent = 'Play a random opponent who is online.';
    }
    $('room-host').innerHTML = st.room
      ? `<div class="room-code"><span>Your code</span><b>${esc(st.room)}</b></div><p class="muted small">Your friend enters this code and clicks Join.</p><button class="btn ghost" id="btn-room-cancel">Close room</button>`
      : '<button class="btn" id="btn-room">Create room code</button>';
  }

  // ---------- socket ----------
  function connect() {
    if (S.socket) S.socket.disconnect();
    const socket = io({ auth: { token: S.token }, transports: ['websocket', 'polling'] });
    S.socket = socket;
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') { toast('Please log in again', 'bad'); logout(); }
      else $('online').textContent = 'Reconnecting…';
    });
    socket.on('online', (o) => { $('online').textContent = `${o.count} online, ${o.matches} playing`; });
    socket.on('status', (st) => { S.status = st; renderStatus(); });
    socket.on('profile', (p) => { S.profile = p; renderProfile(); if (S.tab !== 'admin' && !window.Game.isActive()) renderShop(); });
    socket.on('errorMsg', (m) => toast(m, 'bad'));
    socket.on('kicked', (k) => { toast(k.reason, 'bad'); S.socket = null; logout(); });
    socket.on('matchStart', (info) => {
      show('game');
      window.Game.start(info, {
        action: (a) => new Promise((resolve) => socket.timeout(4000).emit('action', a, (err, res) => resolve(err ? { ok: false, error: 'No response from server' } : res))),
        forfeit: () => socket.emit('forfeit'),
        emote: (i) => socket.emit('emote', i),
      });
    });
    socket.on('emote', (e) => window.Game.emote(e));
    socket.on('rematchStatus', (r) => {
      const el = $('end-rematch'), btn = $('end-again');
      el.hidden = false;
      if (r.state === 'waiting') { el.textContent = 'Waiting for your opponent to accept…'; btn.disabled = true; }
      else if (r.state === 'offered') { el.textContent = 'Your opponent wants a rematch!'; btn.textContent = 'Accept rematch'; }
      else if (r.state === 'left') { el.textContent = 'Your opponent left.'; btn.disabled = true; }
      else { el.textContent = 'Rematch expired.'; btn.disabled = true; }
    });
    socket.on('snap', (s) => window.Game.snap(s));
    socket.on('matchEnd', (res) => {
      S.profile = res.profile;
      const mode = window.Game.mode();
      const back = () => { renderProfile(); renderShop(); show('lobby'); };
      window.Game.end(res, back);
      const btn = $('end-again');
      btn.disabled = false;
      $('end-rematch').hidden = true;
      btn.textContent = mode === 'pvp' ? 'Rematch' : 'Play again';
      btn.onclick = () => {
        if (mode === 'pvp') socket.emit('rematch');
        else { window.Game.stop(); renderProfile(); socket.emit('playBot', S.botDiff); }
      };
    });
    socket.on('disconnect', () => { if (window.Game.isActive()) window.Game.toast('Connection lost, reconnecting…', 'bad'); });
  }

  // ---------- boot ----------
  (async () => {
    if (!S.token) return show('auth');
    try { enterLobby((await api('/api/me')).profile); }
    catch (e) { if (e.status === 401) { store.set('ss_token', null); S.token = null; } show('auth'); if (e.status !== 401) $('auth-error').textContent = e.message; }
  })();
})();
