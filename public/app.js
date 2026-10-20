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

  // custom ranks from the admin ([{ text, color: '#rrggbb' }]): small colored tags next to the name.
  // max = how many fit in that spot; the rest become "+N" (hover lists them)
  const rankTag = (r) => (r && r.text && GD.RANK_HEX.test(r.color)
    ? `<span class="rank-tag ink-${GD.rankInk(r.color)}" style="--rank:${r.color}" title="${esc(r.text)}">${esc(r.text)}</span>` : '');
  function rankTags(ranks, max) {
    if (!ranks || !ranks.length) return '';
    const shown = ranks.slice(0, max || ranks.length), rest = ranks.slice(shown.length);
    return `<span class="rank-tags">${shown.map(rankTag).join('')}${rest.length ? `<span class="rank-more" title="${esc(rest.map((r) => r.text).join(', '))}">+${rest.length}</span>` : ''}</span>`;
  }

  function plate(el, name, banner, sub, ranks, max) {
    el.style.background = (GD.BANNERS[banner] || GD.BANNERS.banner_slate).css;
    el.innerHTML = `<span class="plate-name">${esc(name)}</span>${rankTags(ranks, max)}<span class="plate-lvl">${esc(sub)}</span>`;
    el.classList.toggle('has-rank', !!(ranks && ranks.length));
  }

  function renderProfile() {
    const p = S.profile;
    plate($('profile-plate'), p.username, p.banner, `Level ${p.level} ${p.title}`, p.ranks);
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
    $('sandbox-block').hidden = !p.powers;
    $('tab-ideas').hidden = !p.ideas;
    $('tab-maps').hidden = !p.mapEditor;
    if ((S.tab === 'admin' && !p.isAdmin) || (S.tab === 'ideas' && !p.ideas) || (S.tab === 'maps' && !p.mapEditor)) {
      S.tab = 'towers';
      document.querySelectorAll('.tabs [data-tab]').forEach((x) => x.classList.toggle('on', x.dataset.tab === 'towers'));
      renderShop();
    }
    const hist = p.history || [];
    $('history').innerHTML = hist.length
      ? hist.map((h) => `<li class="${h.stopped ? 'stopped' : h.draw ? 'draw' : h.won ? 'win' : 'loss'}"><b>${h.stopped ? 'Stopped' : h.draw ? 'Draw' : h.won ? 'Win' : 'Loss'}</b><span>vs ${esc(h.opp || '?')}</span><small>R${h.round} · ${ago(h.at)}</small></li>`).join('')
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
          plate(pl, x.username, x.banner, 'Lv ' + x.level, x.ranks);
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
    if (S.tab === 'ideas') { renderIdeas(body); return; }
    if (S.tab === 'maps') { renderMapEditor(body); return; }
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
        plate(pl, p.username, id, k.name, p.ranks, 1);
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
        <section><h4>Pick your 4 towers</h4><p>Every match starts with ${GD.RULES.pickTime} seconds to choose ${GD.RULES.loadoutSize} of your unlocked towers. You can only build those 4, so pick a mix that handles armored Knights and invisible Ghosts. Your opponent sees your choice when the match starts. Archer, Cannon, Frost and Sniper split into two upgrade paths at their 2nd upgrade (<kbd>U</kbd> takes the left one, <kbd>I</kbd> the right).</p></section>
        <section><h4>Build and upgrade</h4><p>Pick a tower with keys <kbd>1</kbd>–<kbd>${GD.RULES.loadoutSize}</kbd> and click a grass tile. Click a placed tower to upgrade it (<kbd>U</kbd>), change who it targets (<kbd>T</kbd>), or sell it (<kbd>Del</kbd>). You can also play with the keyboard only: arrow keys move a cursor and <kbd>Enter</kbd> builds or selects.</p></section>
        <section><h4>Send slimes</h4><p>Sends drop extra slimes into your opponent's lane and permanently raise your income, paid every 6 seconds. Keys <kbd>Q</kbd><kbd>W</kbd><kbd>E</kbd> <kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> <kbd>Z</kbd><kbd>X</kbd><kbd>C</kbd>. Quick sends: <kbd>R</kbd> strongest, <kbd>F</kbd> best income, <kbd>V</kbd> all you can afford. Spend too much on sends and your own defense cracks.</p></section>
        <section><h4>Level up</h4><p>Matches earn XP and coins, even losses. Spend coins on new towers, skins and banners. Your first win each day pays ${GD.DAILY_WIN_BONUS} bonus coins.</p></section>
      </div>
      <h4 class="gallery-title">Know your slimes</h4>`;
    const notes = {
      green: 'Weak, comes in crowds.', blue: 'A bit tougher and faster.', yellow: 'Very fast. Frost helps.',
      purple: 'Splits into 2 blue slimes.', ghost: 'Invisible to most towers. Sniper, Tesla, or a fully upgraded Archer (Eagle Eye) or Frost (Glacier) see it, and a Glow Lantern lights it up for all your towers.',
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

  // ---------- map editor ----------
  const ED = { pts: [], theme: 'meadow', name: '' };
  function editorPath() {
    if (!ED.pts.length) return null;
    const p = [[-1, ED.pts[0][1]]].concat(ED.pts);
    const last = ED.pts[ED.pts.length - 1];
    if (last[0] === GD.COLS - 1) p.push([GD.COLS, last[1]]);
    return p;
  }
  function renderMapEditor(body) {
    const mine = S.maps.filter((m) => m.custom);
    body.innerHTML = `
      <div class="editor">
        <div class="ed-main">
          <canvas id="ed-canvas" width="${GD.COLS * 40}" height="${GD.ROWS * 40}" aria-label="Map editor grid"></canvas>
          <p class="ed-status" id="ed-status"></p>
        </div>
        <div class="ed-side">
          <h4>Draw a path</h4>
          <ol class="ed-steps">
            <li>Click a tile in the <b>left column</b>. Slimes enter there.</li>
            <li>Click tiles in the same row or column to add corners.</li>
            <li>Finish with a tile in the <b>right column</b>.</li>
          </ol>
          <label>Name <input id="ed-name" maxlength="24" placeholder="My map" value="${esc(ED.name)}"></label>
          <label>Look <select id="ed-theme">${Object.keys(GD.THEMES).map((t) => `<option value="${t}" ${t === ED.theme ? 'selected' : ''}>${GD.MAPS[t].name}</option>`).join('')}</select></label>
          <div class="row"><button class="btn" id="ed-undo">Undo</button><button class="btn" id="ed-clear">Clear</button><button class="btn primary" id="ed-save">Save map</button></div>
          <h4>Custom maps</h4>
          <ul class="ed-list">${mine.map((m) => `<li><span>${esc(m.name)}</span><small>by ${esc(m.author)}</small>${
            m.authorId === S.profile.id || S.profile.isAdmin ? `<button class="fx" data-del="${m.id}" title="Delete map">×</button>` : ''}</li>`).join('') || '<li class="muted">No custom maps yet.</li>'}</ul>
        </div>
      </div>`;
    const cv = $('ed-canvas'), g = cv.getContext('2d');
    const draw = () => {
      const th = GD.THEMES[ED.theme], T = 40;
      for (let x = 0; x < GD.COLS; x++) for (let y = 0; y < GD.ROWS; y++) { g.fillStyle = th.ground[(x + y) % 2]; g.fillRect(x * T, y * T, T, T); }
      g.fillStyle = 'rgba(155,225,93,0.25)'; g.fillRect(0, 0, T, GD.ROWS * T);
      g.fillStyle = 'rgba(255,111,168,0.22)'; g.fillRect((GD.COLS - 1) * T, 0, T, GD.ROWS * T);
      const p = editorPath();
      if (p) {
        const pts = p.map(([c, r]) => [(c + 0.5) * T, (r + 0.5) * T]);
        for (const [col, w] of [[th.edge, T * 0.96], [th.path, T * 0.8]]) {
          g.strokeStyle = col; g.lineWidth = w; g.lineJoin = 'round'; g.lineCap = 'round';
          g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
        }
        g.fillStyle = '#1e1530';
        ED.pts.forEach(([c, r], i) => { g.beginPath(); g.arc((c + 0.5) * T, (r + 0.5) * T, i === ED.pts.length - 1 ? 7 : 4, 0, 7); g.fill(); });
      }
      const full = p && p[p.length - 1][0] === GD.COLS;
      const err = full ? GD.validatePath(p) : null;
      $('ed-status').textContent = !p ? 'Click a tile in the green left column to start.'
        : err ? err : full ? 'Path complete. Give it a name and save it.' : 'Keep going until you reach the pink right column.';
      $('ed-status').className = 'ed-status' + (err ? ' bad' : full ? ' good' : '');
      $('ed-save').disabled = !full || !!err;
    };
    cv.onclick = (e) => {
      const r = cv.getBoundingClientRect();
      const c = Math.floor(((e.clientX - r.left) / r.width) * GD.COLS), row = Math.floor(((e.clientY - r.top) / r.height) * GD.ROWS);
      const last = ED.pts[ED.pts.length - 1];
      if (!last) { if (c !== 0) return toast('Start in the left column', 'bad'); ED.pts.push([c, row]); return draw(); }
      if (last[0] === GD.COLS - 1 && ED.pts.length > 1) return toast('The path is finished. Undo to change it.', 'bad');
      if (c !== last[0] && row !== last[1]) return toast('Pick a tile in the same row or column', 'bad');
      if (c === last[0] && row === last[1]) return;
      ED.pts.push([c, row]);
      draw();
    };
    $('ed-undo').onclick = () => { ED.pts.pop(); draw(); };
    $('ed-clear').onclick = () => { ED.pts = []; draw(); };
    $('ed-theme').onchange = (e) => { ED.theme = e.target.value; draw(); };
    $('ed-name').oninput = (e) => { ED.name = e.target.value; };
    $('ed-save').onclick = async () => {
      try {
        await api('/api/maps', { name: ED.name, path: editorPath(), themeId: ED.theme });
        toast(`Saved "${ED.name}"`, 'good');
        ED.pts = []; ED.name = '';
        await loadMaps();
      } catch (err) { toast(err.message, 'bad'); }
    };
    body.querySelector('.ed-list').onclick = async (e) => {
      const b = e.target.closest('[data-del]');
      if (!b) return;
      if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = 'Delete?'; setTimeout(() => { b.classList.remove('armed'); b.textContent = '×'; }, 3000); return; }
      try { await api(`/api/maps/${b.dataset.del}/delete`, {}); toast('Map deleted', 'good'); await loadMaps(); } catch (err) { toast(err.message, 'bad'); }
    };
    draw();
  }

  // ---------- ideas box ----------
  const IDEA_LABEL = { new: 'New', planned: 'Planned', done: 'Done', rejected: 'Not doing' };
  async function renderIdeas(body) {
    body.innerHTML = '<p class="muted">Loading ideas…</p>';
    let data;
    try { data = await api('/api/ideas'); } catch (e) { body.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
    if (S.tab !== 'ideas') return;
    const draw = (d) => {
      data = Object.assign(data, d);
      const filter = S.ideaFilter || 'open';
      const shown = data.ideas.filter((i) => filter === 'all' || (filter === 'open' ? i.status === 'new' || i.status === 'planned' : i.status === filter));
      $('idea-list').innerHTML = shown.map((i) => `
        <li class="idea st-${i.status}" data-id="${i.id}">
          <button class="vote ${i.voted ? 'on' : ''}" data-act="vote" aria-pressed="${i.voted}" title="Upvote"><span>▲</span><b>${i.votes}</b></button>
          <div class="idea-body"><p>${esc(i.text)}</p><small>${esc(i.author)}, ${ago(i.at)}</small></div>
          <div class="idea-side">
            ${data.admin
              ? `<select data-act="status" aria-label="Status">${data.statuses.map((st) => `<option value="${st}" ${st === i.status ? 'selected' : ''}>${IDEA_LABEL[st]}</option>`).join('')}</select>`
              : `<em class="status">${IDEA_LABEL[i.status]}</em>`}
            ${data.admin || i.mine ? '<button class="btn ghost del" data-act="del">Delete</button>' : ''}
          </div>
        </li>`).join('') || '<li class="empty muted">No ideas here yet. Post the first one.</li>';
    };
    body.innerHTML = `
      <div class="ideas">
        <form id="idea-form" class="idea-form">
          <textarea id="idea-text" maxlength="500" rows="2" placeholder="A new tower, a map, a balance change…" aria-label="Your idea"></textarea>
          <button class="btn primary" type="submit">Post idea</button>
        </form>
        <p class="muted small">Only ${data.admin ? 'you and the players you enable in the Admin tab' : 'the admin and invited players'} can see this box.</p>
        <div class="seg idea-filter" role="group" aria-label="Filter">
          ${['open', 'done', 'rejected', 'all'].map((k) => `<button data-f="${k}" class="${(S.ideaFilter || 'open') === k ? 'on' : ''}">${{ open: 'Open', done: 'Done', rejected: 'Not doing', all: 'All' }[k]}</button>`).join('')}
        </div>
        <ol class="idea-list" id="idea-list"></ol>
      </div>`;
    draw(data);
    $('idea-form').onsubmit = async (e) => {
      e.preventDefault();
      try { draw(await api('/api/ideas', { text: $('idea-text').value })); $('idea-text').value = ''; toast('Idea posted', 'good'); }
      catch (err) { toast(err.message, 'bad'); }
    };
    body.querySelector('.idea-filter').onclick = (e) => {
      const b = e.target.closest('[data-f]');
      if (!b) return;
      S.ideaFilter = b.dataset.f;
      body.querySelectorAll('.idea-filter button').forEach((x) => x.classList.toggle('on', x === b));
      draw(data);
    };
    const act = async (id, path, payload) => { try { draw(await api(`/api/ideas/${id}/${path}`, payload || {})); } catch (err) { toast(err.message, 'bad'); } };
    $('idea-list').onclick = (e) => {
      const b = e.target.closest('[data-act]'), li = e.target.closest('li[data-id]');
      if (!b || !li || b.tagName === 'SELECT') return;
      if (b.dataset.act === 'vote') act(li.dataset.id, 'vote');
      if (b.dataset.act === 'del') {
        if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = 'Sure?'; setTimeout(() => { b.classList.remove('armed'); b.textContent = 'Delete'; }, 3000); return; }
        act(li.dataset.id, 'delete');
      }
    };
    $('idea-list').onchange = (e) => {
      const li = e.target.closest('li[data-id]');
      if (e.target.dataset.act === 'status' && li) act(li.dataset.id, 'status', { status: e.target.value });
    };
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
        `<tr data-id="${u.id}" class="${u.id === S.adminSel ? 'sel' : ''}"><td>${esc(u.username)}${rankTags(u.ranks)}${u.admin ? ' <em class="tag">admin</em>' : ''}${u.ideasAccess && !u.admin ? ' <em class="tag idea">ideas</em>' : ''}${u.cheatAccess && !u.admin ? ' <em class="tag pow">powers</em>' : ''}${u.mapAccess && !u.admin ? ' <em class="tag idea">maps</em>' : ''}${u.banned ? ' <em class="tag bad">banned</em>' : ''}</td>` +
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
      <form id="ae-rank" class="ae-rank"><fieldset><legend>Ranks</legend>
        <ul class="ae-rank-list" id="ae-rank-list"></ul>
        <div class="ae-inline">
          <input type="text" name="text" maxlength="${GD.RANKS.maxText}" placeholder="New rank" autocomplete="off" aria-label="Rank text">
          <button class="btn" type="submit" id="ae-rank-go">Add rank</button>
          <button class="btn ghost" type="button" id="ae-rank-cancel" hidden>Cancel</button>
        </div>
        <div class="swatches" role="radiogroup" aria-label="Rank color">${GD.RANKS.colors.map(([name, hex], i) =>
          `<label class="swatch" title="${name}"><input type="radio" name="color" value="${hex}" aria-label="${name}" ${i ? '' : 'checked'}><span style="--rank:${hex}"></span></label>`).join('')}
          <label class="swatch pick" title="Any color"><input type="color" name="pick" value="${GD.RANKS.colors[0][1]}" aria-label="Pick any color"><span></span></label></div>
        <span class="ae-rank-prev" id="ae-rank-prev"></span>
      </fieldset></form>
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
        <label class="chk"><input type="checkbox" name="mapAccess" ${u.mapAccess || u.admin ? 'checked' : ''} ${u.admin ? 'disabled' : ''}>Can make maps</label>
        <label class="chk"><input type="checkbox" name="cheatAccess" ${u.cheatAccess || u.admin ? 'checked' : ''} ${u.admin ? 'disabled' : ''}>In-game powers (gold, lives, slimes)</label>
        <label class="chk"><input type="checkbox" name="ideasAccess" ${u.ideasAccess || u.admin ? 'checked' : ''} ${u.admin ? 'disabled' : ''}>Can see the Ideas box</label>
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
      if (b.dataset.q === 'all') f.querySelectorAll('input[name=unlocked], input[name=owned]').forEach((c) => (c.checked = true));
      if (b.dataset.q === 'reset') { for (const k of ['wins', 'losses', 'botWins', 'bestRound', 'games']) f[k].value = 0; f.rating.value = 1000; }
    }));
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = {};
      for (const k of ['coins', 'xp', 'rating', 'wins', 'losses', 'botWins', 'bestRound', 'games']) body[k] = f[k].value;
      body.unlocked = [...f.querySelectorAll('input[name=unlocked]:checked')].map((c) => c.value);
      body.owned = [...f.querySelectorAll('input[name=owned]:checked')].map((c) => c.value);
      body.banned = f.banned.checked;
      if (!u.admin) { body.ideasAccess = f.ideasAccess.checked; body.cheatAccess = f.cheatAccess.checked; body.mapAccess = f.mapAccess.checked; }
      try {
        const r = await api('/api/admin/user/' + u.id, body);
        Object.assign(u, r.user);
        refreshRows();
        adminEditor(u, refreshRows);
        toast(`Saved ${u.username}`, 'good');
        if (isMe) { S.profile = (await api('/api/me')).profile; renderProfile(); }
      } catch (err) { toast(err.message, 'bad'); }
    };
    // ranks: every change sends the whole new list; clicking a rank loads it into the form to edit it
    const rf = $('ae-rank'), pick = rf.pick, pickBox = rf.querySelector('.swatch.pick');
    const ranks = (u.ranks || []).slice();
    let editing = -1;
    const color = () => { const c = rf.querySelector('input[name=color]:checked'); return c ? c.value : pick.value; };
    const markPick = () => { // the picker swatch shows its color once it's the chosen one
      const on = !rf.querySelector('input[name=color]:checked');
      pickBox.classList.toggle('on', on);
      pickBox.querySelector('span').style.background = on ? pick.value : '';
    };
    const setColor = (hex) => {
      let preset = false;
      rf.querySelectorAll('input[name=color]').forEach((r) => { r.checked = r.value === hex; preset = preset || r.checked; });
      if (!preset) pick.value = hex;
      markPick();
    };
    const preview = () => {
      const text = rf.text.value.trim(), full = editing < 0 && ranks.length >= GD.RANKS.max;
      $('ae-rank-prev').innerHTML = text ? 'Preview ' + rankTag({ text, color: color() })
        : `<span class="muted small">${full ? `That's the most a player can have. Remove one to add another.`
          : `Up to ${GD.RANKS.max} ranks. The first one also shows in matches. Click a rank to change it.`}</span>`;
    };
    const drawRanks = () => {
      $('ae-rank-list').innerHTML = ranks.map((r, i) => `<li data-i="${i}" class="${i === editing ? 'editing' : ''}">
        <button type="button" class="rank-edit" data-r="edit" title="Change this rank">${rankTag(r)}</button>
        ${i ? `<button type="button" class="fx" data-r="up" title="Move earlier" aria-label="Move ${esc(r.text)} earlier">↑</button>` : ''}
        <button type="button" class="fx" data-r="del" title="Remove" aria-label="Remove ${esc(r.text)}">×</button></li>`).join('')
        || '<li class="muted small">No ranks yet.</li>';
      $('ae-rank-go').textContent = editing >= 0 ? 'Save rank' : 'Add rank';
      $('ae-rank-go').disabled = editing < 0 && ranks.length >= GD.RANKS.max;
      $('ae-rank-cancel').hidden = editing < 0;
      preview();
    };
    const saveRanks = async (list, msg) => {
      try {
        const r = await api(`/api/admin/user/${u.id}/ranks`, { ranks: list });
        Object.assign(u, r.user);
        refreshRows();
        adminEditor(u, refreshRows);
        toast(msg, 'good');
        if (isMe) { S.profile = (await api('/api/me')).profile; renderProfile(); }
      } catch (err) { toast(err.message, 'bad'); }
    };
    rf.oninput = rf.onchange = (e) => {
      if (e.target === pick) rf.querySelectorAll('input[name=color]').forEach((r) => (r.checked = false));
      markPick();
      preview();
    };
    rf.onsubmit = (e) => {
      e.preventDefault();
      const r = { text: rf.text.value.trim(), color: color() };
      if (!r.text) return toast('Type a rank first', 'bad');
      const list = ranks.slice();
      if (editing >= 0) list[editing] = r; else list.push(r);
      saveRanks(list, editing >= 0 ? `Saved "${r.text}"` : `Gave ${u.username} "${r.text}"`);
    };
    $('ae-rank-cancel').onclick = () => { editing = -1; rf.text.value = ''; drawRanks(); };
    $('ae-rank-list').onclick = (e) => {
      const b = e.target.closest('[data-r]'), li = e.target.closest('li[data-i]');
      if (!b || !li) return;
      const i = Number(li.dataset.i), r = ranks[i];
      if (b.dataset.r === 'edit') { editing = i; rf.text.value = r.text; setColor(r.color); drawRanks(); rf.text.focus(); }
      if (b.dataset.r === 'up') { const list = ranks.slice(); list.splice(i - 1, 0, list.splice(i, 1)[0]); saveRanks(list, `Moved "${r.text}" earlier`); }
      if (b.dataset.r === 'del') saveRanks(ranks.filter((x, k) => k !== i), `Removed "${r.text}"`);
    };
    drawRanks();
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
  $('btn-bot').addEventListener('click', () => S.socket && S.socket.emit('playBot', S.botDiff, pickedMap()));
  $('sandbox-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (S.socket) S.socket.emit('playSandbox', { cols: Number($('sb-cols').value), rows: Number($('sb-rows').value) });
  });
  $('room-host').addEventListener('click', (e) => {
    if (!S.socket) return;
    if (e.target.id === 'btn-room') S.socket.emit('createRoom', pickedMap());
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

  // ---------- maps ----------
  S.maps = [];
  async function loadMaps() {
    try {
      const { maps } = await api('/api/maps');
      S.maps = maps;
      for (const m of maps) if (!GD.MAPS[m.id]) GD.registerMap(m.id, { name: m.name, path: m.path, theme: m.theme });
      const sel = $('map-pick'), keep = sel.value;
      sel.innerHTML = '<option value="">Random</option>' + maps.map((m) => `<option value="${m.id}">${esc(m.name)}${m.custom ? ' (custom)' : ''}</option>`).join('');
      if (maps.some((m) => m.id === keep)) sel.value = keep;
      if (S.tab === 'maps') renderShop();
    } catch (e) { /* ignore */ }
  }
  const pickedMap = () => $('map-pick').value || '';
  const ensureMap = (info) => { if (info.mapDef && !GD.MAPS[info.map]) GD.registerMap(info.map, info.mapDef); };

  // ---------- friends ----------
  const STATUS_LABEL = { online: 'Online', playing: 'In a match', offline: 'Offline' };
  async function loadFriends() {
    if (!S.token) return;
    try { renderFriends(await api('/api/friends')); } catch (e) { /* ignore while offline */ }
  }
  function renderFriends(d) {
    S.friends = d;
    $('friend-requests').innerHTML = d.incoming.map((r) => `
      <div class="freq" data-id="${r.id}"><span><b>${esc(r.username)}</b> wants to be friends</span>
        <button class="btn primary small-btn" data-f="accept">Accept</button><button class="btn small-btn" data-f="decline">Decline</button></div>`).join('');
    const rows = d.friends.map((f) => `
      <li data-id="${f.id}" class="st-${f.status}">
        <span class="dot" aria-hidden="true"></span>
        <span class="fname"><span>${esc(f.username)}</span>${rankTags(f.ranks, 3)}</span>
        <small>${STATUS_LABEL[f.status]}</small>
        ${f.status === 'online' ? '<button class="btn primary small-btn" data-f="invite">Invite</button>' : f.status === 'playing' ? '<button class="btn small-btn" data-f="watch">Watch</button>' : ''}
        <button class="fx" data-f="remove" title="Remove friend" aria-label="Remove ${esc(f.username)}">×</button>
      </li>`).concat(d.outgoing.map((o) => `
      <li data-id="${o.id}" class="st-pending"><span class="dot" aria-hidden="true"></span><span class="fname"><span>${esc(o.username)}</span></span><small>Request sent</small>
        <button class="fx" data-f="cancel" title="Cancel request" aria-label="Cancel request to ${esc(o.username)}">×</button></li>`));
    $('friend-list').innerHTML = rows.join('') || '<li class="empty muted">Add friends by username to see when they are online and invite them.</li>';
  }
  $('friend-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('friend-name').value.trim();
    if (!name) return;
    try {
      const d = await api('/api/friends/request', { username: name });
      renderFriends(d);
      $('friend-name').value = '';
      const now = d.friends.some((f) => f.username.toLowerCase() === name.toLowerCase());
      toast(now ? `You and ${name} are now friends` : 'Friend request sent', 'good');
    }
    catch (err) { toast(err.message, 'bad'); }
  });
  async function friendAction(e) {
    const b = e.target.closest('[data-f]'), row = e.target.closest('[data-id]');
    if (!b || !row) return;
    const id = row.dataset.id, f = b.dataset.f;
    if (f === 'invite') { if (S.socket) S.socket.emit('invite', id); return; }
    if (f === 'watch') { if (S.socket) S.socket.emit('spectate', id); return; }
    if (f === 'remove' && !b.classList.contains('armed')) {
      b.classList.add('armed'); b.textContent = 'Remove?';
      setTimeout(() => { b.classList.remove('armed'); b.textContent = '×'; }, 3000);
      return;
    }
    try { renderFriends(await api('/api/friends/' + f, { id })); } catch (err) { toast(err.message, 'bad'); }
  }
  $('friend-list').addEventListener('click', friendAction);
  $('friend-requests').addEventListener('click', friendAction);

  let inviteTimer = null;
  function showInvite(inv) {
    if (window.Game.isActive()) return;
    S.invite = inv;
    $('invite-name').textContent = inv.username;
    $('invite-card').hidden = false;
    window.Sfx.play('incoming');
    clearTimeout(inviteTimer);
    inviteTimer = setTimeout(hideInvite, 55000);
  }
  function hideInvite() { $('invite-card').hidden = true; S.invite = null; clearTimeout(inviteTimer); }
  const replyInvite = (accept) => { if (S.invite && S.socket) S.socket.emit('inviteReply', { from: S.invite.from, accept }); hideInvite(); };
  $('invite-accept').addEventListener('click', () => replyInvite(true));
  $('invite-decline').addEventListener('click', () => replyInvite(false));

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
    socket.on('friendsChanged', () => loadFriends());
    socket.on('inviteSent', () => toast('Invite sent', 'good'));
    socket.on('invite', (inv) => showInvite(inv));
    socket.on('connect', () => { loadFriends(); loadMaps(); });
    socket.on('profile', (p) => { S.profile = p; renderProfile(); if (S.tab !== 'admin' && !window.Game.isActive()) renderShop(); });
    socket.on('errorMsg', (m) => toast(m, 'bad'));
    socket.on('kicked', (k) => { toast(k.reason, 'bad'); S.socket = null; logout(); });
    socket.on('matchStart', (info) => {
      ensureMap(info);
      hideInvite();
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
    const backToLobby = () => { window.Game.stop(); renderProfile(); renderShop(); show('lobby'); loadFriends(); };
    socket.on('spectateStart', (info) => {
      ensureMap(info);
      hideInvite();
      show('game');
      window.Game.start(info, {
        action: () => Promise.resolve({ ok: false, error: "You're spectating" }),
        forfeit: () => {}, emote: () => {},
        stopWatching: () => { socket.emit('stopSpectate'); backToLobby(); },
      });
    });
    socket.on('spectateEnd', (r) => window.Game.spectateEnd(r, backToLobby));
    socket.on('spectators', (d) => window.Game.setSpectators(d.count));
    socket.on('matchEnd', (res) => {
      if (res.mode === 'sandbox') { // leaving the test field: no end screen, nothing to show
        backToLobby();
        if (res.reason === 'error') toast('The test field stopped because of a server error', 'bad');
        return;
      }
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
        else { window.Game.stop(); renderProfile(); socket.emit('playBot', S.botDiff, pickedMap()); }
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
