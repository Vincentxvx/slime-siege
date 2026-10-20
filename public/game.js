// In-match client: renders server snapshots, handles placing/upgrading/sending.
(function () {
  const GD = window.GD, R = window.Render;
  const T = R.T;
  let W = R.W, H = R.H; // board size in pixels: COLS × ROWS tiles, except on a test field (set in start)
  const $ = (id) => document.getElementById(id);
  const now = () => performance.now() / 1000;

  const G = {
    active: false, info: null, net: null, you: 0,
    prev: null, cur: null, prevAt: 0, curAt: 0, interval: 0.1,
    placing: null, hover: null, selected: null,
    effects: [], aim: [{}, {}], hits: [new Map(), new Map()], anim: [new Map(), new Map()], cdFull: {}, cdLast: {}, built: false, panelKey: '', lastRound: -1,
  };
  // a tower tuple's upgrade path (8th field) and its stats on that path
  const twPath = (tw) => (tw[7] === 1 ? 'b' : 'a');
  const twStats = (tw) => GD.towerStats(GD.TOWER_ORDER[tw[1]], tw[4], twPath(tw));
  const HIT_FLASH = 0.16; // seconds a slime flashes white after losing HP
  const HIT_GAP = 0.33;   // at most ~3 flashes per second per slime
  const DROP = 0.18;      // seconds a new tower takes to drop onto its tile
  const TIER_COLORS = ['#efe7ff', '#f0a564', '#e6edf5', '#ffd35c']; // text/sparks per level: base, bronze, silver, gold

  // ---------- setup ----------
  function start(info, net) {
    Object.assign(G, {
      active: true, info, net, you: info.you, prev: null, cur: null, effects: [], aim: [{}, {}], hits: [new Map(), new Map()], anim: [new Map(), new Map()], cdFull: {}, cdLast: {},
      placing: null, hover: null, selected: null, panelKey: '', lastRound: -1, ended: false, previewRound: -1, cursor: null, kb: false,
    });
    G.map = GD.MAPS[info.map];
    // test field: any board size, a slime palette instead of sends, tools instead of quick sends
    G.sandbox = !!info.sandbox;
    G.placingSlime = null;
    G.cols = G.map.cols || GD.COLS; G.rows = G.map.rows || GD.ROWS;
    W = G.cols * T; H = G.rows * T;
    document.body.classList.toggle('sandbox', G.sandbox);
    $('screen-game').style.setProperty('--cols', G.cols);
    $('screen-game').style.setProperty('--rows', G.rows);
    G.picking = false; G.pickSel = null; G.pickSent = '';
    $('pick-overlay').hidden = true;
    G.spectator = !!info.spectator;
    document.body.classList.toggle('spectating', G.spectator);
    $('btn-stopwatch').hidden = !G.spectator;
    $('spectator-count').textContent = '';
    G.me = info.players[info.you];
    G.op = info.players[1 - info.you];
    plate($('hud-me-plate'), G.me);
    plate($('hud-op-plate'), G.op);
    $('end-overlay').hidden = true;
    $('countdown').hidden = false;
    $('btn-forfeit').textContent = G.sandbox ? 'Leave' : 'Forfeit';
    $('btn-forfeit').classList.remove('armed');
    $('hud-lives').parentElement.hidden = G.sandbox; // nothing can leak on a test field
    $('hud-income').closest('.stat').hidden = G.sandbox;
    buildTowerBar();
    buildSends();
    renderPanel(true);
    buildEmotes();
    $('emote-row').hidden = true; $('btn-chat').setAttribute('aria-expanded', 'false'); // not left open from the last match
    buildPowers();
    $('bubble-me').hidden = true; $('bubble-op').hidden = true;
    G.oppLoadout = null; $('opp-loadout').hidden = true; $('opp-loadout').innerHTML = '';
    sizeCanvases();
    window.Sfx.play('start');
    requestAnimationFrame(frame);
  }

  function buildPowers() {
    const btn = $('btn-powers'), panel = $('power-panel');
    btn.hidden = !G.me.cheats;
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (!G.me.cheats || panel.dataset.built) return;
    panel.dataset.built = '1';
    const sel = panel.querySelector('select[name=enemy]');
    sel.innerHTML = GD.ENEMY_ORDER.map((k) => `<option value="${k}">${GD.ENEMIES[k].name}</option>`).join('');
    btn.addEventListener('click', () => { panel.hidden = !panel.hidden; btn.setAttribute('aria-expanded', String(!panel.hidden)); $('emote-row').hidden = true; });
    panel.addEventListener('click', (e) => {
      const b = e.target.closest('[data-p]');
      if (!b) return;
      const a = { type: 'power', power: b.dataset.p, amount: Number(b.dataset.v || 0) };
      if (a.power === 'maxTower') { if (!G.selected) return toast('Click one of your towers first', 'bad'); a.id = G.selected; }
      act(a);
    });
    $('pp-spawn').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      act({ type: 'power', power: 'spawn', enemy: f.enemy.value, count: Number(f.count.value), target: f.target.value });
    });
  }

  function buildEmotes() {
    const row = $('emote-row');
    row.innerHTML = '';
    GD.EMOTES.forEach((text, i) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.onclick = () => { G.net.emote(i); row.hidden = true; $('btn-chat').setAttribute('aria-expanded', 'false'); };
      row.append(b);
    });
  }

  const bubbleTimers = {};
  function emote(e) {
    if (!G.active) return;
    const el = $(e.from === G.you ? 'bubble-me' : 'bubble-op');
    el.textContent = GD.EMOTES[e.id] || '';
    el.hidden = false;
    el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
    clearTimeout(bubbleTimers[el.id]);
    bubbleTimers[el.id] = setTimeout(() => { el.hidden = true; }, 2800);
    window.Sfx.play('emote');
  }

  function plate(el, p) {
    el.style.background = (GD.BANNERS[p.banner] || GD.BANNERS.banner_slate).css;
    el.innerHTML = '';
    const n = document.createElement('span'); n.className = 'plate-name'; n.textContent = p.name;
    const l = document.createElement('span'); l.className = 'plate-lvl'; l.textContent = p.isBot ? 'Bot' : `Lv ${p.level}` + (G.info.mode === 'pvp' && p.rating ? ` · ${p.rating}` : '');
    el.append(n);
    // custom ranks from the admin: the main (first) one and "+N" on a second line with the level
    const ranks = (p.ranks || []).filter((r) => r.text && GD.RANK_HEX.test(r.color));
    el.classList.toggle('has-rank', ranks.length > 0);
    if (ranks.length) {
      const box = document.createElement('span'); box.className = 'rank-tags';
      const r = document.createElement('span'); r.className = 'rank-tag ink-' + GD.rankInk(ranks[0].color);
      r.style.setProperty('--rank', ranks[0].color); r.textContent = r.title = ranks[0].text;
      box.append(r);
      if (ranks.length > 1) {
        const more = document.createElement('span'); more.className = 'rank-more';
        more.textContent = '+' + (ranks.length - 1); more.title = ranks.slice(1).map((x) => x.text).join(', ');
        box.append(more);
      }
      el.append(box);
    }
    el.append(l);
  }

  function sizeCanvases() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const id of ['cv-main', 'cv-opp']) {
      const c = $(id);
      // both lanes are drawn at the board's own size; a test field follows its size on screen (a small field
      // shown big stays sharp), but at most ~2400px across
      const fit = G.sandbox ? Math.max(1, c.clientWidth / W) : 1;
      const k = Math.min(fit, 2400 / (Math.max(W, H) * dpr));
      c.width = Math.round(W * k * dpr); c.height = Math.round(H * k * dpr);
    }
  }
  window.addEventListener('resize', () => G.active && sizeCanvases());

  // ---------- tower selection at the start of a match ----------
  function renderPick(s) {
    const o = $('pick-overlay');
    const size = GD.RULES.loadoutSize;
    if (!G.picking) {
      G.picking = true;
      o.hidden = false;
      $('countdown').hidden = true;
      if (G.spectator) {
        $('pick-grid').innerHTML = '';
        $('pick-sub').textContent = 'The players are choosing their towers.';
        $('pick-ready').hidden = true;
        $('pick-count').textContent = '';
      } else {
        G.pickSel = (s.pick && s.pick.mine.length ? s.pick.mine : []).slice();
        const choices = s.pick ? s.pick.choices : G.me.unlocked;
        const need = Math.min(size, choices.length);
        $('pick-sub').textContent = `Pick ${need}. You can only build these in this match.`;
        $('pick-ready').hidden = false;
        const grid = $('pick-grid');
        grid.innerHTML = '';
        GD.TOWER_ORDER.filter((t) => choices.includes(t)).forEach((type) => {
          const T0 = GD.TOWERS[type], st = GD.towerStats(type, 0);
          const b = document.createElement('button');
          b.className = 'pick-tower';
          b.dataset.type = type;
          b.title = `${T0.name}: ${T0.desc}`;
          b.append(R.towerIcon(type, G.me.skin, 38));
          const tags = [st.detect ? 'Sees ghosts' : '', st.kind === 'light' ? 'Lights up ghosts' : '', st.pierceArmor ? 'Ignores armor' : ''].filter(Boolean).join(', ');
          b.insertAdjacentHTML('beforeend', `<b>${T0.name}</b><span class="gold">${T0.cost}</span><small>${T0.desc}</small>${tags ? `<em>${tags}</em>` : ''}`);
          b.onclick = () => togglePick(type);
          grid.append(b);
        });
      }
    }
    const left = Math.ceil(s.pickLeft || 0);
    $('pick-timer').textContent = left;
    $('pick-timer').classList.toggle('urgent', left <= 5);
    if (!G.spectator && s.pick) {
      if (s.pick.ready) G.pickSel = s.pick.mine.slice();
      const need = Math.min(size, s.pick.choices.length);
      document.querySelectorAll('#pick-grid .pick-tower').forEach((b) => {
        const on = G.pickSel.includes(b.dataset.type);
        b.classList.toggle('on', on);
        b.disabled = s.pick.ready;
        b.dataset.slot = on ? G.pickSel.indexOf(b.dataset.type) + 1 : '';
      });
      $('pick-count').textContent = s.pick.ready ? 'Locked in' : `${G.pickSel.length} / ${need} chosen`;
      $('pick-ready').disabled = s.pick.ready || G.pickSel.length < need;
      $('pick-ready').textContent = s.pick.ready ? 'Waiting for opponent…' : 'Lock in';
      $('pick-opp').textContent = s.pick.oppReady ? 'Opponent is ready' : 'Opponent is choosing…';
      $('pick-opp').classList.toggle('ready', !!s.pick.oppReady);
    }
  }

  function togglePick(type) {
    const size = GD.RULES.loadoutSize;
    const i = G.pickSel.indexOf(type);
    if (i >= 0) G.pickSel.splice(i, 1);
    else if (G.pickSel.length >= size) { toast(`You can only bring ${size} towers`, 'bad'); return; }
    else G.pickSel.push(type);
    window.Sfx.play('emote');
    G.net.action({ type: 'loadout', towers: G.pickSel }).then((r) => { if (!r.ok) toast(r.error, 'bad'); });
    if (G.cur) renderPick(G.cur);
  }

  function endPick(s) {
    G.picking = false;
    $('pick-overlay').hidden = true;
    if (s.loadouts) {
      if (!G.spectator) G.me.unlocked = s.loadouts[G.you].slice();
      const opp = s.loadouts[1 - G.you] || [];
      if (opp.length) toast(`${G.op.name} brought: ${opp.map((t) => GD.TOWERS[t].name).join(', ')}`, 'warn');
    }
    buildTowerBar();
    renderPanel(true);
    window.Sfx.play('start');
  }

  // Small icons of the towers your opponent brought, kept on their lane all match.
  // Built from the snapshot, so it also appears after a reload or for a spectator who joins late.
  function showOppLoadout(list) {
    const key = list.join(',');
    if (key === G.oppLoadout) return;
    G.oppLoadout = key;
    const box = $('opp-loadout'), skin = G.info.players[1 - G.you].skin;
    box.innerHTML = '';
    box.hidden = !list.length;
    box.setAttribute('aria-label', `Towers ${G.op.name} brought`);
    // sit in the corner whose ~6×2 tiles have the least path under them (Canyon starts bottom-left)
    let least = Infinity;
    for (const [corner, c0, r0] of [['bl', 0, G.rows - 2], ['tl', 0, 0], ['br', G.cols - 6, G.rows - 2]]) {
      let n = 0;
      for (let c = c0; c < c0 + 6; c++) for (let r = r0; r < r0 + 2; r++) if (G.map.pathTiles.has(c + ',' + r)) n++;
      if (n < least) { least = n; box.dataset.corner = corner; }
    }
    for (const type of list) {
      const T0 = GD.TOWERS[type];
      if (!T0) continue;
      // when each counter arrives: "Sees ghosts", "... from level 3" or "... when fully upgraded"
      const notes = [];
      // (with upgrade paths: the earliest level on either path, naming the path when only one gets it)
      for (const [flag, text] of [['detect', 'Sees ghosts'], ['pierceArmor', 'Ignores armor']]) {
        const max = T0.upgrades.length;
        const at = (p) => { let l = 0; while (l <= max && !GD.towerStats(type, l, p)[flag]) l++; return l > max ? null : l; };
        const la = at('a'), lb = T0.branch ? at('b') : null;
        const lvl = la == null ? lb : lb == null ? la : Math.min(la, lb);
        if (lvl == null) continue;
        const via = T0.branch && lvl > GD.FORK && la !== lb ? ` (${GD.upgradeList(type, lvl === la ? 'a' : 'b')[GD.FORK].name} path)` : '';
        notes.push((lvl === 0 ? text : lvl === max ? `${text} when fully upgraded` : `${text} from level ${lvl + 1}`) + via);
      }
      const el = document.createElement('span');
      el.title = [`${T0.name}: ${T0.desc}`].concat(notes.filter((n) => !T0.desc.includes(n)).map((n) => n + '.')).join(' ');
      el.setAttribute('role', 'img');
      el.setAttribute('aria-label', el.title);
      el.append(R.towerIcon(type, skin, 24));
      box.append(el);
    }
  }

  function buildTowerBar() {
    const bar = $('tower-bar');
    bar.innerHTML = '';
    let key = 1;
    // Only the towers brought into this match (your loadout), in the order you picked them. Until the pick
    // ends, unlocked still lists every tower you own, so cap it at the loadout size (the bar has 4 slots).
    // (a test field brings every tower: 16 small cards in two rows)
    G.me.unlocked.filter((t) => GD.TOWERS[t]).slice(0, G.sandbox ? Infinity : GD.RULES.loadoutSize).forEach((type) => {
      const T0 = GD.TOWERS[type];
      const unlocked = true;
      const b = document.createElement('button');
      b.className = 'tcard' + (unlocked ? '' : ' locked');
      b.dataset.type = type;
      b.title = unlocked ? `${T0.name}: ${T0.desc}` : `${T0.name} — unlock it in the shop`;
      b.append(R.towerIcon(type, G.me.skin, 46));
      const name = document.createElement('span'); name.className = 'tname'; name.textContent = T0.name;
      const cost = document.createElement('span'); cost.className = 'tcost'; cost.textContent = unlocked ? T0.cost : 'Locked';
      b.append(name, cost);
      if (unlocked) {
        // keys 1-9 (a test field has 16 cards; the rest are picked with the mouse)
        if (key <= 9) { const k = document.createElement('kbd'); k.textContent = key; b.dataset.key = key; b.append(k); }
        key++;
        b.onclick = () => setPlacing(G.placing === type ? null : type);
      } else b.disabled = true;
      bar.append(b);
    });
  }

  function buildSends() {
    const grid = $('send-grid');
    grid.innerHTML = '';
    $('sends-title').textContent = G.sandbox ? 'Place slimes' : 'Send slimes';
    if (G.sandbox) return buildSlimePalette(grid);
    GD.SENDS.forEach((p, i) => {
      const b = document.createElement('button');
      b.className = 'send';
      b.dataset.i = i;
      b.title = `Send ${p.count} ${GD.ENEMIES[p.enemy].name}s to your opponent. Income +${p.eco}.`;
      b.append(R.slimeIcon(p.enemy, 24));
      const key = SEND_KEYS[i] ? SEND_KEYS[i].toUpperCase() : '';
      const info = document.createElement('span');
      info.className = 'sinfo';
      info.innerHTML = `<span class="r"><b class="scount">×${p.count}</b><kbd>${key}</kbd></span>` +
        `<span class="r"><span class="scost">${p.cost}</span><span class="seco">${p.eco ? '+' + p.eco : ''}</span></span>`;
      const lock = document.createElement('span'); lock.className = 'slock'; lock.textContent = 'Round ' + p.round;
      const cd = document.createElement('i'); cd.className = 'scd';
      b.append(info, lock, cd);
      b.onclick = () => act({ type: 'send', pack: p.id });
      if (key) b.title += ` (key ${key})`;
      grid.append(b);
    });
  }

  // Test field: one button per slime type (same keys as the sends); pick one, then click tiles
  function buildSlimePalette(grid) {
    GD.ENEMY_ORDER.forEach((type, i) => {
      const E = GD.ENEMIES[type];
      const b = document.createElement('button');
      b.className = 'send slime-pick';
      b.dataset.slime = type;
      const key = SEND_KEYS[i] ? SEND_KEYS[i].toUpperCase() : '';
      const notes = [E.armor ? `armor ${E.armor}` : '', E.ghost ? 'needs ghost sight' : '', E.children ? 'splits' : ''].filter(Boolean);
      b.title = `${E.name}${notes.length ? ': ' + notes.join(', ') : ''}${key ? ` (key ${key})` : ''}`;
      b.append(R.slimeIcon(type, 24));
      const info = document.createElement('span');
      info.className = 'sinfo';
      info.innerHTML = `<span class="r"><b class="sname">${E.name.replace(' Slime', '')}</b><kbd>${key}</kbd></span><span class="r"><span class="shp" data-hp="${type}"></span></span>`;
      b.append(info);
      b.onclick = () => setSlime(G.placingSlime === type ? null : type);
      grid.append(b);
    });
  }

  // HP of a standing test slime at the chosen round (the server uses the same formula)
  const slimeHp = (type, round) => Math.max(1, Math.round(GD.ENEMIES[type].hp * GD.hpMulForRound(round)));

  function setSlime(type) {
    G.placingSlime = type;
    if (type) { G.placing = null; G.selected = null; }
    renderPanel(true);
    if (G.cur) updateHud();
  }

  const SEND_KEYS = ['q', 'w', 'e', 'a', 's', 'd', 'z', 'x', 'c'];
  const BULK_KEYS = { r: 'strong', f: 'eco', v: 'all' };

  // Packs that can be sent right now: unlocked, off cooldown, affordable with the given gold
  function sendable(gold) {
    const s = G.cur, me = s && s.boards[G.you];
    if (!me) return [];
    return GD.SENDS.map((p, i) => ({ p, i })).filter(({ p, i }) => s.round >= p.round && (!me.cds || me.cds[i] <= 0) && p.cost <= gold);
  }
  function bulkSend(kind) {
    if (G.spectator || !G.cur) return;
    let gold = G.cur.boards[G.you].gold;
    const list = sendable(gold);
    if (!list.length) return toast('Nothing you can send right now', 'bad');
    if (kind === 'strong') return act({ type: 'send', pack: list.reduce((a, b) => (b.p.cost > a.p.cost ? b : a)).p.id });
    if (kind === 'eco') {
      const withEco = list.filter((x) => x.p.eco > 0);
      if (!withEco.length) return toast('No income send available', 'bad');
      return act({ type: 'send', pack: withEco.reduce((a, b) => (b.p.eco / b.p.cost > a.p.eco / a.p.cost ? b : a)).p.id });
    }
    // all: strongest first while gold lasts
    let n = 0;
    for (const { p } of list.sort((a, b) => b.p.cost - a.p.cost)) {
      if (p.cost > gold) continue;
      gold -= p.cost; n++;
      act({ type: 'send', pack: p.id });
    }
    if (n > 1) toast(`Sent ${n} packs`, 'good');
  }

  // ---------- networking ----------
  function act(a) {
    if (G.spectator) return;
    G.net.action(a).then((res) => {
      if (!res.ok) { toast(res.error, 'bad'); window.Sfx.play('error'); return; }
      const sound = { target: 'emote', power: 'emote', sandbox: 'emote', slime: res.removed ? 'sell' : 'pop' }[a.type];
      window.Sfx.play(sound || a.type);
      if (a.type === 'power' && a.power === 'maxTower') renderPanel(true);
      if (a.type === 'place' && res.id) {
        if (!G.shift) { G.selected = res.id; setPlacing(null); }
      } else if (a.type === 'sell') { G.selected = null; renderPanel(true); }
    });
  }

  function snap(s) {
    if (!G.active) return;
    if (s.state === 'picking') { renderPick(s); G.cur = s; G.curAt = now(); updateHud(); return; }
    if (G.picking) endPick(s);
    if (s.loadouts) showOppLoadout(s.loadouts[1 - G.you] || []);
    const t = now();
    if (G.cur && s.boards[G.you].lives < G.cur.boards[G.you].lives) {
      window.Sfx.play('leak');
      const lost = G.cur.boards[G.you].lives - s.boards[G.you].lives;
      const ex = GD.posAt(G.map, G.map.length - 1.2);
      G.effects.push({ b: G.you, k: 'txt', x1: Math.min(W - 24, ex.x * T), y1: ex.y * T - 12, text: '-' + lost, color: '#ff6b6b', t0: now(), dur: 1.2 });
      const w = document.querySelector('.main-wrap');
      w.classList.remove('hurt'); void w.offsetWidth; w.classList.add('hurt');
    }
    G.prev = G.cur; G.prevAt = G.curAt;
    G.cur = s; G.curAt = t;
    if (G.prev) G.interval = Math.min(0.25, Math.max(0.05, G.curAt - G.prevAt));
    G.cur.boards.forEach((b, i) => {
      b.tmap = new Map(b.towers.map((x) => [x[0], x]));
      b.emap = new Map(b.enemies.map((x) => [x[0], x]));
      processEvents(i, b);
      hits(i, b);
      // the previous snapshot has no maps if it was from the picking phase
      const pb = G.prev && G.prev.boards[i];
      if (pb && pb.emap) { deaths(i, pb, b); towerChanges(i, pb, b); }
    });
    if (G.selected && !G.cur.boards[G.you].tmap.has(G.selected)) G.selected = null;
    updateHud();
    renderPanel(false);
  }

  // How the newer towers' 'a'/'s' shots look and sound (Archer arrows and Sniper lines are the default)
  const SHOT = {
    bramble: { k: 'vine', sound: 'arrow', dur: 0.22 },
    drake: { k: 'cone', sound: 'flame', dur: 0.18 },
    sapling: { k: 'seed', sound: 'arrow', dur: 0.18 },
    hex: { k: 'beam', sound: 'hex', dur: 0.22, color: '255,90,220', width: 3.2 },
    basilisk: { k: 'beam', sound: 'arrow', dur: 0.16, color: '200,240,90', width: 1.8 },
    ballista: { k: 'bolt', sound: 'shot', dur: 0.2 },
  };

  function processEvents(bi, b) {
    const t = now();
    for (const ev of b.ev) {
      const tw = b.tmap.get(ev[1]);
      const type = tw ? GD.TOWER_ORDER[tw[1]] : null;
      const tx = tw ? (tw[2] + 0.5) * T : 0, ty = tw ? (tw[3] + 0.5) * T : 0;
      switch (ev[0]) {
        case 'a': case 's': {
          const st = SHOT[type];
          if (bi === G.you) window.Sfx.play(st ? st.sound : ev[0] === 'a' ? 'arrow' : 'shot');
          G.aim[bi][ev[1]] = Math.atan2(ev[3] * T - ty, ev[2] * T - tx);
          const f = { b: bi, k: st ? st.k : ev[0], x1: tx, y1: ty, x2: ev[2] * T, y2: ev[3] * T, t0: t, dur: st ? st.dur : ev[0] === 'a' ? 0.12 : 0.08 };
          if (st && st.color) { f.color = st.color; f.width = st.width; }
          if (type === 'drake') { const s = twStats(tw); f.r = s.range * T; f.half = (s.cone * Math.PI) / 360; f.blue = tw[4] >= 2; }
          G.effects.push(f);
          break;
        }
        case 'b':
          if (type === 'basilisk') { // a petrified slime shatters into stone
            if (bi === G.you) window.Sfx.play('stone');
            G.effects.push({ b: bi, k: 'stone', x1: ev[2] * T, y1: ev[3] * T, r: ev[4] * T, t0: t, dur: 0.45, seed: ev[1] });
            break;
          }
          if (bi === G.you) window.Sfx.play('boom');
          G.aim[bi][ev[1]] = Math.atan2(ev[3] * T - ty, ev[2] * T - tx);
          G.effects.push({ b: bi, k: 'b', x1: tx, y1: ty, x2: ev[2] * T, y2: ev[3] * T, r: ev[4] * T, t0: t, dur: 0.42 });
          break;
        case 'p': {
          if (type === 'hatchery') { // you just sent: a pink ring from the nest, and "+N" for the extra slimes
            G.effects.push({ b: bi, k: 'p', x1: tx, y1: ty, r: 1.2 * T, color: '255,111,168', t0: t, dur: 0.5 });
            if (ev[2] > 0) G.effects.push({ b: bi, k: 'txt', x1: labelX(tx), y1: Math.max(T * 0.75, ty - 10), text: `+${ev[2]} slime${ev[2] > 1 ? 's' : ''}`, color: '#ff6fa8', t0: t, dur: 1.1 });
            break;
          }
          if (bi === G.you) window.Sfx.play('pulse');
          const range = tw ? twStats(tw).range : 2;
          G.effects.push({ b: bi, k: 'p', x1: tx, y1: ty, r: range * T, color: type === 'lantern' ? '255,214,110' : null, t0: t, dur: 0.4 });
          break;
        }
        case 'c': {
          const pts = [[tx, ty - (type === 'stormjar' ? 10 : 4)]];
          for (let i = 2; i < ev.length; i += 2) pts.push([ev[i] * T, ev[i + 1] * T]);
          if (type === 'goldspitter') { // gold coins flying (and bouncing with Ricochet)
            if (bi === G.you) window.Sfx.play('shot');
            G.aim[bi][ev[1]] = Math.atan2(pts[1][1] - ty, pts[1][0] - tx);
            pts[0] = [tx, ty];
            G.effects.push({ b: bi, k: 'gold', pts, t0: t, dur: 0.22 });
            break;
          }
          if (bi === G.you) window.Sfx.play('zap');
          G.effects.push({ b: bi, k: 'c', pts, color: type === 'stormjar' && tw[4] >= 3 ? '225,205,255' : null, t0: t, dur: 0.2 });
          break;
        }
        case 'm':
          if (bi === G.you) window.Sfx.play('coin');
          G.effects.push({ b: bi, k: 'txt', x1: tx, y1: ty - 10, text: '+' + ev[2], color: '#ffd35c', t0: t, dur: 1.1 });
          break;
        case 'x':
          if (bi === G.you) toast('Your opponent used admin powers, so this match won\'t count', 'warn');
          break;
        case 'i':
          if (bi === G.you) {
            window.Sfx.play('incoming');
            const p = GD.SENDS[ev[1]];
            toast(`Incoming: ${ev[2] || p.count}× ${GD.ENEMIES[p.enemy].name}`, 'warn'); // ev[2]: count with a Slime Hatchery
          }
          break;
      }
    }
  }

  // Where a slime is: standing test field slimes send x, y (e[7], e[8]); the rest are a distance along the path,
  // eased from the previous snapshot (pe) by a. Returns null for a slime that reached the exit.
  function slimePos(e, pe, a) {
    if (e.length > 7) return { x: e[7] / 100, y: e[8] / 100, dx: 0, dy: 1 };
    let d = e[2] / 100;
    if (pe) d = pe[2] / 100 + (d - pe[2] / 100) * a;
    if (!pe && d > G.map.length - 0.6) return null;
    return GD.posAt(G.map, d);
  }

  function deaths(bi, prevB, curB) {
    const t = now();
    for (const e of prevB.enemies) {
      if (curB.emap.has(e[0])) continue;
      const p = slimePos(e);
      if (!p) continue; // leaked, not killed
      const type = GD.ENEMY_ORDER[e[1]];
      if (bi === G.you) window.Sfx.play('pop');
      G.effects.push({ b: bi, k: 'splat', x1: p.x * T, y1: p.y * T, color: GD.ENEMIES[type].color, r: GD.ENEMIES[type].r * T, t0: t, dur: 0.35, seed: e[0] });
    }
  }

  // Slimes the server says took damage since the last snapshot (e[6]) flash white for a moment
  // (no flash means the shots bounced off, e.g. arrows on a Knight's armor).
  // A new flash only starts once the last one is HIT_GAP old, so slimes under constant fire don't strobe.
  function hits(bi, b) {
    const t = now(), m = G.hits[bi];
    for (const [id, at] of m) if (t - at > HIT_GAP) m.delete(id);
    for (const e of b.enemies) if (e[6] && !m.has(e[0])) m.set(e[0], t);
  }

  // floating labels stay inside the board for towers on the edge columns/top row
  const labelX = (x) => Math.min(W - 28, Math.max(28, x));

  // Build, upgrade and sell effects, found by comparing towers between snapshots (both lanes)
  function towerChanges(bi, prevB, curB) {
    const t = now(), anim = G.anim[bi];
    for (const tw of curB.towers) {
      const old = prevB.tmap.get(tw[0]);
      const x = (tw[2] + 0.5) * T, y = (tw[3] + 0.5) * T;
      if (!old) {
        anim.set(tw[0], { k: 'drop', t0: t, dur: DROP });
        G.effects.push({ b: bi, k: 'dust', x1: x, y1: y + T * 0.3, t0: t + DROP, dur: 0.45, seed: tw[0] });
      } else if (tw[4] > old[4]) {
        const color = TIER_COLORS[Math.min(3, tw[4])];
        anim.set(tw[0], { k: 'pop', t0: t, dur: 0.3 });
        G.effects.push({ b: bi, k: 'spark', x1: x, y1: y, color, t0: t, dur: 0.6, seed: tw[0] + tw[4] });
        G.effects.push({ b: bi, k: 'txt', x1: labelX(x), y1: Math.max(T * 0.75, y - T * 0.55), text: tw[4] >= 3 ? 'MAX' : 'Level ' + (tw[4] + 1), color, t0: t, dur: 1.1 });
      }
    }
    for (const old of prevB.towers) {
      if (curB.tmap.has(old[0])) continue;
      const x = (old[2] + 0.5) * T, y = (old[3] + 0.5) * T;
      G.effects.push({ b: bi, k: 'coins', x1: x, y1: y, t0: t, dur: 0.7 });
      if (bi === G.you) G.effects.push({ b: bi, k: 'txt', x1: labelX(x), y1: Math.max(T * 0.75, y - 10), text: '+' + GD.sellValue(GD.TOWER_ORDER[old[1]], old[4], twPath(old)), color: '#ffd35c', t0: t, dur: 1.1 });
    }
    for (const [id, a] of anim) if (t - a.t0 > a.dur) anim.delete(id);
  }

  // ---------- HUD & panels ----------
  // Test field HUD: the round only sets how tough new slimes are; gold never runs out
  function updateSandboxHud(s) {
    $('hud-round').textContent = s.round;
    $('hud-next').textContent = `Test field ${G.cols} × ${G.rows}`;
    $('hud-gold').textContent = '∞';
    $('countdown').hidden = true;
    document.querySelectorAll('#tower-bar .tcard').forEach((b) => b.classList.toggle('active', G.placing === b.dataset.type));
    document.querySelectorAll('#send-grid .slime-pick').forEach((b) => {
      b.classList.toggle('active', G.placingSlime === b.dataset.slime);
      const hp = b.querySelector('.shp'), v = slimeHp(b.dataset.slime, s.round) + ' HP';
      if (hp.textContent !== v) hp.textContent = v;
    });
    if (s.sandbox) $('sb-respawn').checked = s.sandbox.respawn;
    if (document.activeElement !== $('sb-round')) $('sb-round').value = s.round;
  }

  function updateHud() {
    const s = G.cur, me = s.boards[G.you], op = s.boards[1 - G.you];
    if (G.sandbox) return updateSandboxHud(s);
    $('hud-lives').textContent = me.lives;
    $('hud-gold').textContent = me.gold;
    $('hud-income').textContent = me.income + me.mine;
    $('hud-op-lives').textContent = op.lives;
    $('hud-op-income').textContent = op.income + op.mine;
    $('hud-round').textContent = Math.max(1, s.round);
    $('hud-lives').parentElement.classList.toggle('low', me.lives <= 25);
    const cd = $('countdown');
    if (s.state === 'picking') { cd.hidden = true; $('hud-next').textContent = 'Choosing towers'; return; }
    if (s.t < 0) { cd.hidden = false; cd.textContent = Math.ceil(-s.t); cd.className = 'overlay big'; }
    else if (s.round === 0) { cd.hidden = false; cd.textContent = `Build your defense — round 1 in ${Math.ceil(s.nextRound)}s`; cd.className = 'overlay hint'; }
    else cd.hidden = true;
    $('hud-next').textContent = s.round === 0 ? 'Get ready' : `Next round in ${Math.ceil(s.nextRound)}s`;
    if (G.previewRound !== s.round + 1) {
      G.previewRound = s.round + 1;
      const box = $('next-wave');
      box.innerHTML = `<span>Round ${s.round + 1}</span>`;
      for (const [type, count] of GD.roundWave(s.round + 1)) {
        const item = document.createElement('span');
        item.className = 'nw-item';
        item.title = GD.ENEMIES[type].name;
        item.append(R.slimeIcon(type, 20), document.createTextNode(count));
        box.append(item);
      }
    }
    if (s.round !== G.lastRound && s.round > 0) {
      G.lastRound = s.round;
      window.Sfx.play('round');
      const w = GD.roundWave(s.round);
      if (w.some((g) => g[0] === 'king')) toast(`Round ${s.round}: a Slime King approaches!`, 'warn');
    }
    // tower bar affordability
    document.querySelectorAll('#tower-bar .tcard').forEach((b) => {
      const type = b.dataset.type;
      b.classList.toggle('poor', G.me.unlocked.includes(type) && me.gold < GD.TOWERS[type].cost);
      b.classList.toggle('active', G.placing === type);
    });
    // cooldown bars: the full length is whatever the cooldown was when the pack was sent
    // (a Slime Hatchery's Warm Nest shortens it, and could be bought or sold in between)
    document.querySelectorAll('#send-grid .send').forEach((b) => {
      const i = b.dataset.i, p = GD.SENDS[i];
      const locked = s.round < p.round;
      const cdv = me.cds ? me.cds[i] : 0;
      if (cdv > (G.cdLast[i] || 0) + 0.05) G.cdFull[i] = cdv; // a new send started this cooldown
      G.cdLast[i] = cdv;
      b.classList.toggle('locked', locked);
      b.classList.toggle('poor', !locked && me.gold < p.cost);
      b.disabled = locked;
      b.querySelector('.scd').style.transform = `scaleX(${cdv > 0 ? Math.min(1, cdv / (G.cdFull[i] || p.cd)) : 0})`;
    });
  }

  const RATE_LABEL = { pulse: 'Pulses/s', light: 'Flares/s', flame: 'Breaths/s', gaze: 'Gazes/s' };
  const pct = (v) => Math.round(v * 100) + '%';
  // towers without a targeting choice
  const NO_TARGET = new Set(['mine', 'pulse', 'light', 'nest']);

  // [label, value] pairs for a tower's stats; `all` also lists stats at their default (0 damage, 1 target)
  function chipList(s, all) {
    const c = [];
    if (s.kind === 'mine') return [['Gold / tick', s.gold]];
    if (s.kind === 'nest') { // what it does to your sends
      const signed = (v, sign) => (v ? sign + pct(v) : '0%');
      c.push(['Extra slimes', signed(s.extra, '+')]);
      if (s.cdMul || all) c.push(['Cooldown', signed(1 - (s.cdMul || 1), '-')]);
      if (s.hpBonus || all) c.push(['Slime HP', signed(s.hpBonus || 0, '+')]);
      if (s.spd || all) c.push(['Slime speed', signed((s.spd || 1) - 1, '+')]);
      return c;
    }
    if (s.pct) { c.push(['Max HP / hit', pct(s.pct)]); c.push(['Max hit', s.maxHit]); } // Hex Idol
    else if (s.dmg || all) c.push(['Damage', +(s.dmg || 0).toFixed(1)]);
    if (s.kind === 'pulse' || s.slow || (all && s.kind === 'bomb')) c.push(['Slow', pct(s.slow || 0)]); // Cannon path B slows too
    if (s.brittle || (all && s.kind === 'pulse')) c.push(['Damage taken', '+' + pct(s.brittle || 0)]); // Frost path B
    if (s.kind === 'jar') { c.push(['Charges', s.charges]); c.push(['Recharge', s.chargeTime + 's']); }
    else if (s.rate || all) c.push([RATE_LABEL[s.kind] || 'Shots/s', +(s.rate || 0).toFixed(2)]);
    c.push([s.kind === 'light' ? 'Light' : 'Range', s.range > 50 ? 'Map' : +s.range.toFixed(1)]);
    if (s.targets > 1 || (all && (s.kind === 'arrow' || s.kind === 'snare' || s.kind === 'shot'))) c.push(['Targets', s.targets || 1]);
    if (s.chains) c.push(['Jumps', s.chains]);
    if (s.splash) c.push(['Blast', +s.splash.toFixed(1)]);
    if (s.pierce) c.push(['Pierce', s.pierce >= 99 ? 'All' : s.pierce]);
    if (s.cone) c.push(['Cone', s.cone + '°']);
    if (s.root) c.push(['Root', s.root + 's']);
    if (s.execute) c.push(['Petrify below', pct(s.execute)]);
    if (s.shotCost) c.push(['Gold / shot', GD.shotCost(s, G.cur ? G.cur.round : 0)]);
    if (s.growCap) c.push(['Growth cap', '+' + s.growCap]);
    return c;
  }
  function tagList(s) {
    const tags = [];
    if (s.detect) tags.push('Sees ghosts');
    if (s.kind === 'light') tags.push('Lights up ghosts');
    if (s.pierceArmor) tags.push('Ignores armor');
    if (s.executeKing) tags.push('Petrifies the King');
    if (s.bounce) tags.push('Ricochets');
    return tags;
  }

  // Stat chips. With `nx` (the stats after the next upgrade) every stat it changes shows "old → new".
  function statChips(s, nx) {
    const c = chipList(s).map(([k, v]) => [k, v, null]);
    if (nx) {
      const full = chipList(s, true);
      for (const [k, v] of chipList(nx)) {
        const cur = c.find((x) => x[0] === k);
        if (cur) { if (cur[1] !== v) cur[2] = v; }
        else c.push([k, (full.find((x) => x[0] === k) || [k, 0])[1], v]);
      }
    }
    const tags = tagList(s), newTags = nx ? tagList(nx).filter((t) => !tags.includes(t)) : [];
    return '<div class="chips">' + c.map(([k, v, n]) =>
      n == null ? `<span><b>${v}</b>${k}</span>` : `<span class="chg"><b>${v}<i>→${n}</i></b>${k}</span>`).join('') + '</div>' +
      (tags.length || newTags.length ? '<div class="tags">' + tags.map((t) => `<em>${t}</em>`).join('') +
        newTags.map((t) => `<em class="chg">→ ${t}</em>`).join('') + '</div>' : '');
  }

  function renderPanel(force) {
    const panel = $('tower-panel');
    const me = G.cur ? G.cur.boards[G.you] : null;
    const tw = G.selected && me ? me.tmap.get(G.selected) : null;
    // an Elder Sapling's growth (tw[6]) changes its damage, so it rebuilds the panel too
    // Goldspitter: its gold per shot rises every 8 rounds, so the round is part of the key too
    const round = G.cur ? G.cur.round : 0;
    const key = G.placingSlime ? `sl:${G.placingSlime}:${round}`
      : G.placing ? `p:${G.placing}:${GD.TOWERS[G.placing].base.shotCost ? round : ''}`
      : tw ? `t:${tw[0]}:${tw[4]}:${tw[5]}:${tw[7]}:${GD.TOWERS[GD.TOWER_ORDER[tw[1]]].base.growCap ? tw[6] : ''}:${GD.TOWERS[GD.TOWER_ORDER[tw[1]]].base.shotCost ? round : ''}` : 'none';
    if (key !== G.panelKey || force) {
      G.panelKey = key;
      if (G.placingSlime) { // test field: placing a slime
        const E = GD.ENEMIES[G.placingSlime];
        const facts = [`<b>${slimeHp(G.placingSlime, round)}</b> HP`, E.armor ? `armor <b>${E.armor}</b>` : '', E.ghost ? 'only towers that see ghosts (or a lantern) can hit it' : '',
          E.children ? `splits into ${E.children.map((c) => GD.ENEMIES[c].name).join(', ')}` : ''].filter(Boolean);
        panel.innerHTML = `<div class="tp-main"><h3>${E.name}</h3><p class="muted">${facts.join(' · ')} (as in round ${round})</p></div>
          <div class="tp-side"><p class="hint">Click tiles to place it. Click one again to remove it. <kbd>Esc</kbd> stops.</p></div>`;
      } else if (G.placing) {
        const T0 = GD.TOWERS[G.placing];
        // the panel has two columns: what it is | its stats (see .tower-panel in style.css)
        panel.innerHTML = `<div class="tp-main"><h3>${T0.name}</h3><p class="muted desc" title="${T0.desc}">${T0.desc}</p>
          <p class="hint">Click a free tile to build for <b class="gold">${T0.cost}</b>. <kbd>Esc</kbd> cancels.</p></div>
          <div class="tp-side">${statChips(GD.towerStats(G.placing, 0))}<p class="hint"><kbd>Shift</kbd> + click builds several.</p></div>`;
      } else if (tw) {
        const type = GD.TOWER_ORDER[tw[1]], T0 = GD.TOWERS[type], level = tw[4], path = twPath(tw);
        // a spectator sees the watched player's tower read-only: no upgrade preview, sell or targeting buttons
        // fork: this upgrade picks one of two paths (Archer, Cannon, Frost, Sniper); both are offered side by side
        const fork = !G.spectator && !!T0.branch && level === GD.FORK;
        const next = G.spectator || fork ? null : GD.upgradeList(type, path)[level];
        const pathName = T0.branch && level > GD.FORK ? GD.upgradeList(type, path)[GD.FORK].name : '';
        const lvlLabel = level >= 3 ? 'MAX' : `Level ${level + 1}`;
        const forkBtn = (p, i) => {
          const list = GD.upgradeList(type, p), u = list[level], then = list[level + 1];
          const tip = `${u.name}: ${u.desc}.${then ? ` Then ${then.name}: ${then.desc}.` : ''} (${i ? 'I' : 'U'})`;
          return `<button class="btn up path" data-path="${p}" data-cost="${u.cost}" title="${tip}"><span>${u.name}</span><b>${u.cost}</b></button>`;
        };
        const upHtml = G.spectator ? `<p class="muted desc" title="${T0.desc}">${T0.desc}</p>`
          : fork ? `<div class="next-up fork" role="group" aria-label="Choose an upgrade path">${['a', 'b'].map(forkBtn).join('')}</div>`
          : next ? `<div class="next-up"><div><b>${next.name}</b><small title="${next.desc}">${next.desc}</small></div><button class="btn up" data-act="upgrade" title="Upgrade (U)">Upgrade <b>${next.cost}</b></button></div>`
          : '<div class="next-up maxed"><b>Fully upgraded</b></div>';
        const modeName = (m) => m[0].toUpperCase() + m.slice(1);
        const modes = NO_TARGET.has(T0.base.kind) ? ''
          : G.spectator ? `<p class="muted">Targeting: <b>${modeName(GD.TARGET_MODES[tw[5]] || 'first')}</b></p>`
          : `<div class="seg" role="group" aria-label="Targeting">${GD.TARGET_MODES.map((m, i) =>
            `<button data-mode="${m}" class="${tw[5] === i ? 'on' : ''}">${modeName(m)}</button>`).join('')}</div>`;
        const cur = GD.towerStats(type, level, path), nx = next ? GD.towerStats(type, level + 1, path) : null;
        // Elder Sapling: tw[6] is its growth before the cap; each level caps it (a higher cap pays out at once)
        if (cur.growCap) { cur.dmg += Math.min(cur.growCap, tw[6] || 0); if (nx) nx.dmg += Math.min(nx.growCap, tw[6] || 0); }
        const sell = G.spectator ? '' : `<button class="btn sell" data-act="sell" title="Sell (Delete)">Sell <b>${GD.sellValue(type, level, path)}</b></button>`;
        const badgeTip = `Level ${level + 1} of 4${pathName ? `, ${pathName} path` : ''}`;
        panel.innerHTML = `<div class="tp-main"><div class="ph"><h3>${T0.name}</h3><span class="lvl-badge ${level >= 3 ? 'max' : ''} ${path === 'b' && pathName ? 'path-b' : ''}" title="${badgeTip}">${lvlLabel}</span>${sell}</div>
          ${upHtml}${modes}</div><div class="tp-side"><div class="tp-chips">${statChips(cur, nx)}</div>${G.sandbox ? '<p class="dps" title="Counted since the tower was built or the counters were reset"></p>' : ''}</div>`;
        // at a fork, pointing at a path (or tabbing to it) previews what it changes
        panel.querySelectorAll('[data-path]').forEach((b) => {
          const show = (p) => { panel.querySelector('.tp-chips').innerHTML = statChips(cur, p ? GD.towerStats(type, level + 1, p) : null); };
          b.onmouseenter = b.onfocus = () => show(b.dataset.path);
          b.onmouseleave = b.onblur = () => show(null);
          b.onclick = () => act({ type: 'upgrade', id: tw[0], path: b.dataset.path });
        });
        panel.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => act({ type: 'target', id: tw[0], mode: b.dataset.mode })));
        const up = panel.querySelector('[data-act=upgrade]');
        if (up) up.onclick = () => act({ type: 'upgrade', id: tw[0] });
        const sb = panel.querySelector('[data-act=sell]');
        if (sb) sb.onclick = () => act({ type: 'sell', id: tw[0] });
      } else if (G.spectator) {
        panel.innerHTML = `<div class="tp-main"><h3>Watching ${esc(G.info.watching)}</h3><p class="muted">The first lane is ${esc(G.info.watching)}'s, the other one their opponent's.</p></div>
          <div class="tp-side"><p class="muted">Click a tower in ${esc(G.info.watching)}'s lane to see its stats.</p></div>`;
      } else if (G.sandbox) {
        panel.innerHTML = `<div class="tp-main"><h3>Test field</h3><p class="muted">Pick a tower (keys 1–9) or a slime (Q W E A S D Z), then click tiles. Slimes stand still.</p></div>
          <div class="tp-side"><p class="muted">Click a slime again to remove it. Select a tower to see how much damage it deals.</p></div>`;
      } else {
        panel.innerHTML = `<div class="tp-main"><h3>Defend your lane</h3><p class="muted">Pick a tower (keys 1–${G.me.unlocked.length}) and click a free tile.
          Click a placed tower to upgrade or sell it.</p></div>
          <div class="tp-side"><p class="muted">Sending slimes pressures your opponent and raises your income.</p>
          <p class="hint">Arrows move, <kbd>Enter</kbd> builds or selects, <kbd>U</kbd> upgrade, <kbd>T</kbd> targeting, <kbd>Del</kbd> sell.</p></div>`;
      }
    }
    // live affordability of the upgrade button: says how much gold is missing
    const up = panel.querySelector('[data-act=upgrade]');
    if (up && tw && me) {
      const u = GD.upgradeList(GD.TOWER_ORDER[tw[1]], twPath(tw))[tw[4]];
      const short = u ? u.cost - me.gold : 0;
      up.disabled = !u || short > 0;
      const label = u ? (short > 0 ? `Need <b>${short}</b> more` : `Upgrade <b>${u.cost}</b>`) : '';
      if (up.dataset.label !== label) { up.dataset.label = label; up.innerHTML = label; }
    }
    // the two path buttons at a fork: greyed out until you can afford them
    if (me) panel.querySelectorAll('[data-path]').forEach((b) => { b.disabled = me.gold < Number(b.dataset.cost); });
    // test field: the selected tower's damage counter (tw[8] damage over tw[9] seconds)
    const dps = panel.querySelector('.dps');
    if (dps && tw && tw.length > 9) {
      const v = `Damage <b>${tw[8]}</b> · <b>${(tw[8] / Math.max(1, tw[9])).toFixed(1)}</b> per second`;
      if (dps.dataset.v !== v) { dps.dataset.v = v; dps.innerHTML = v; }
    }
  }

  function setPlacing(type) {
    G.placing = G.spectator ? null : type;
    if (G.placing) { G.selected = null; G.placingSlime = null; }
    renderPanel(true);
    if (G.cur) updateHud();
  }

  let toastTimer = 0;
  function toast(msg, kind) {
    const box = $('toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    box.append(el);
    while (box.children.length > 2) box.firstChild.remove();
    setTimeout(() => el.remove(), 2600);
    void toastTimer;
  }

  // ---------- input ----------
  function tileFromEvent(e) {
    const c = $('cv-main'), r = c.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W, y = ((e.clientY - r.top) / r.height) * H;
    return { col: Math.floor(x / T), row: Math.floor(y / T) };
  }

  function tileFree(col, row) {
    if (col < 0 || row < 0 || col >= G.cols || row >= G.rows) return false;
    if (G.map.pathTiles.has(col + ',' + row)) return false;
    const me = G.cur && G.cur.boards[G.you];
    if (!me) return true;
    // test field: a slime placed by hand stands exactly on its tile center (split children never do)
    if (G.sandbox && me.enemies.some((e) => e[7] === col * 100 + 50 && e[8] === row * 100 + 50)) return false;
    return !me.towers.some((t) => t[2] === col && t[3] === row);
  }

  function bindInput() {
    const c = $('cv-main');
    c.addEventListener('mousemove', (e) => { G.hover = tileFromEvent(e); G.cursor = Object.assign({}, G.hover); G.kb = false; });
    c.addEventListener('mouseleave', () => { G.hover = null; });
    c.addEventListener('contextmenu', (e) => { e.preventDefault(); G.placingSlime = null; setPlacing(null); G.selected = null; renderPanel(true); });
    c.addEventListener('click', (e) => {
      if (!G.active || !G.cur) return;
      const { col, row } = tileFromEvent(e);
      G.shift = e.shiftKey;
      if (G.placingSlime) { act({ type: 'slime', enemy: G.placingSlime, col, row }); return; } // test field
      if (G.placing) {
        if (!tileFree(col, row)) return toast("Can't build there", 'bad');
        act({ type: 'place', tower: G.placing, col, row });
        return;
      }
      const tw = G.cur.boards[G.you].towers.find((t) => t[2] === col && t[3] === row);
      G.selected = tw ? tw[0] : null;
      renderPanel(true);
    });
    // The next-wave box covers the bottom-right tiles: pass its mouse events on to the board, so those
    // tiles still build and select while the box keeps its slime name tooltips
    const nw = $('next-wave');
    for (const type of ['mousemove', 'click', 'contextmenu']) {
      nw.addEventListener(type, (e) => { e.preventDefault(); c.dispatchEvent(new MouseEvent(type, e)); });
    }
    nw.addEventListener('mouseleave', (e) => { if (e.relatedTarget !== c) G.hover = null; });
    window.addEventListener('keydown', (e) => {
      // typing in a field or choosing in a dropdown (admin Powers) must not send slimes or build
      const tag = e.target.tagName;
      // (a checkbox or button keeps the shortcuts working; text and number fields take the keys)
      const typing = tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes(e.target.type));
      if (!G.active || typing) return;
      if (G.picking) {
        if (G.spectator) return;
        const cards = [...document.querySelectorAll('#pick-grid .pick-tower')];
        // arrows move between cards (Space or Enter picks the focused one), number keys pick cards 1-9
        const cols = getComputedStyle($('pick-grid')).gridTemplateColumns.split(' ').length;
        const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.key];
        if (step && cards.length) {
          e.preventDefault();
          const at = cards.indexOf(document.activeElement);
          cards[at < 0 ? 0 : Math.max(0, Math.min(cards.length - 1, at + step))].focus();
          return;
        }
        const n = Number(e.key);
        if (n >= 1 && n <= cards.length) togglePick(cards[n - 1].dataset.type);
        if (e.key === 'Enter' && !cards.includes(document.activeElement) && !$('pick-ready').disabled) $('pick-ready').click();
        return;
      }
      if (e.key === 'Escape') { G.placingSlime = null; setPlacing(null); G.selected = null; renderPanel(true); return; }
      // Keyboard play: arrows move a cursor, Enter builds or selects, T changes targeting
      const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (dir) {
        e.preventDefault();
        if (!G.cursor) G.cursor = { col: Math.min(7, G.cols - 1), row: Math.min(5, G.rows - 1) };
        else {
          G.cursor.col = Math.max(0, Math.min(G.cols - 1, G.cursor.col + dir[0]));
          G.cursor.row = Math.max(0, Math.min(G.rows - 1, G.cursor.row + dir[1]));
        }
        G.hover = Object.assign({}, G.cursor);
        G.kb = true;
        return;
      }
      // (a spectator's Enter on a focused button, like Stop watching, stays a button press)
      if (e.key === 'Enter' && G.cursor && G.cur && !G.ended && !(G.spectator && tag === 'BUTTON')) {
        e.preventDefault();
        const { col, row } = G.cursor;
        G.shift = e.shiftKey;
        if (G.placingSlime) { act({ type: 'slime', enemy: G.placingSlime, col, row }); return; }
        if (G.placing) {
          if (!tileFree(col, row)) { toast("Can't build there", 'bad'); return; }
          act({ type: 'place', tower: G.placing, col, row });
          return;
        }
        const tw = G.cur.boards[G.you].towers.find((t) => t[2] === col && t[3] === row);
        G.selected = tw ? tw[0] : null;
        renderPanel(true);
        return;
      }
      if (G.spectator) return; // watching: towers can be inspected, but there is nothing to build, upgrade or send
      if ((e.key === 't' || e.key === 'T') && G.selected && G.cur) {
        const tw = G.cur.boards[G.you].tmap.get(G.selected);
        const kind = tw && GD.TOWERS[GD.TOWER_ORDER[tw[1]]].base.kind;
        if (tw && !NO_TARGET.has(kind)) act({ type: 'target', id: tw[0], mode: GD.TARGET_MODES[(tw[5] + 1) % GD.TARGET_MODES.length] });
        return;
      }
      const card = document.querySelector(`#tower-bar [data-key="${e.key}"]`);
      if (card) { setPlacing(G.placing === card.dataset.type ? null : card.dataset.type); return; }
      const bk = BULK_KEYS[e.key.toLowerCase()];
      if (bk && !e.ctrlKey && !e.metaKey && !G.sandbox) { bulkSend(bk); return; }
      const si = SEND_KEYS.indexOf(e.key.toLowerCase());
      if (si >= 0 && !e.ctrlKey && !e.metaKey && G.sandbox) { // test field: the send keys pick a slime type
        const type = GD.ENEMY_ORDER[si];
        if (type) setSlime(G.placingSlime === type ? null : type);
        return;
      }
      if (si >= 0 && !e.ctrlKey && !e.metaKey) {
        const btn = document.querySelector(`#send-grid .send[data-i="${si}"]`);
        if (btn && !btn.disabled) act({ type: 'send', pack: GD.SENDS[si].id });
        return;
      }
      if (G.selected && (e.key === 'u' || e.key === 'U')) act({ type: 'upgrade', id: G.selected }); // at a fork: the left path
      if (G.selected && (e.key === 'i' || e.key === 'I') && $('tower-panel').querySelector('[data-path="b"]')) act({ type: 'upgrade', id: G.selected, path: 'b' });
      if (G.selected && (e.key === 'Delete' || e.key === 'Backspace')) act({ type: 'sell', id: G.selected });
    });
    // test field tools
    // the round box gives the keys back to the game once a value is set (Enter or leaving the box)
    $('sb-round').addEventListener('change', (e) => { act({ type: 'sandbox', round: Number(e.target.value) }); e.target.blur(); });
    $('sb-round').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') e.target.blur(); });
    $('sb-respawn').addEventListener('change', (e) => act({ type: 'sandbox', respawn: e.target.checked }));
    $('sb-clear').addEventListener('click', () => act({ type: 'sandbox', clear: true }));
    $('sb-reset').addEventListener('click', () => act({ type: 'sandbox', resetDamage: true }));
    document.querySelector('.send-bulk').addEventListener('click', (e) => {
      const b = e.target.closest('[data-bulk]');
      if (b) bulkSend(b.dataset.bulk);
    });
    $('pick-ready').addEventListener('click', () => {
      G.net.action({ type: 'loadout', towers: G.pickSel, ready: true }).then((r) => { if (!r.ok) toast(r.error, 'bad'); else window.Sfx.play('upgrade'); });
    });
    $('btn-stopwatch').addEventListener('click', () => { if (G.spectator && G.net.stopWatching) G.net.stopWatching(); });
    $('btn-chat').addEventListener('click', () => {
      const row = $('emote-row');
      row.hidden = !row.hidden;
      $('btn-chat').setAttribute('aria-expanded', String(!row.hidden));
    });
    $('btn-forfeit').addEventListener('click', (e) => {
      const b = e.currentTarget;
      if (b.classList.contains('armed') || G.sandbox) { G.net.forfeit(); return; } // leaving a test field needs no confirm
      b.classList.add('armed'); b.textContent = 'Click again to confirm';
      setTimeout(() => { b.classList.remove('armed'); b.textContent = G.sandbox ? 'Leave' : 'Forfeit'; }, 3000);
    });
  }

  // ---------- rendering ----------
  function frame() {
    if (!G.active) return;
    draw($('cv-main'), G.you, true);
    if (!G.sandbox) draw($('cv-opp'), 1 - G.you, false); // a test field has no other lane
    if (G.cur) {
      const left = Math.max(0, G.cur.nextIncome - (now() - G.curAt));
      $('hud-income-bar').style.transform = `scaleX(${1 - left / GD.RULES.incomeInterval})`;
    }
    G.effects = G.effects.filter((f) => now() - f.t0 < f.dur);
    requestAnimationFrame(frame);
  }

  function draw(canvas, bi, main) {
    const g = canvas.getContext('2d');
    g.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
    g.drawImage(R.ground(G.info.map), 0, 0, W, H);
    if (!G.cur) return;
    const t = now();
    const b = G.cur.boards[bi], pb = G.prev ? G.prev.boards[bi] : null;
    const a = Math.min(1, (t - G.curAt) / G.interval);
    const skin = G.info.players[bi].skin;

    // selected tower range / placement preview (main board only)
    if (main) {
      const sel = G.selected && b.tmap.get(G.selected);
      if (sel) {
        const s = twStats(sel);
        if (s.range > 0 && s.range < 50) ring(g, (sel[2] + 0.5) * T, (sel[3] + 0.5) * T, s.range * T, 'rgba(255,255,255,0.14)', 'rgba(255,255,255,0.7)');
      }
    }

    // Glow Lanterns light the ground; ghosts inside the light can be hit by every tower: [x, y, radius²]
    const lights = [];
    for (const tw of b.towers) {
      if (GD.TOWER_ORDER[tw[1]] !== 'lantern') continue;
      const r = twStats(tw).range, cx = (tw[2] + 0.5) * T, cy = (tw[3] + 0.5) * T;
      lights.push([tw[2] + 0.5, tw[3] + 0.5, r * r]);
      const glow = g.createRadialGradient(cx, cy, T * 0.3, cx, cy, r * T);
      glow.addColorStop(0, 'rgba(255,214,110,0.32)'); glow.addColorStop(0.7, 'rgba(255,200,90,0.12)'); glow.addColorStop(1, 'rgba(255,190,80,0)');
      g.fillStyle = glow; g.beginPath(); g.arc(cx, cy, r * T, 0, 7); g.fill();
    }

    for (const tw of b.towers) {
      const type = GD.TOWER_ORDER[tw[1]];
      let y = (tw[3] + 0.5) * T, size = T;
      const an = G.anim[bi].get(tw[0]);
      if (an && !R.reducedMotion) { // new towers drop in, upgraded ones pop
        const k = Math.min(1, (t - an.t0) / an.dur);
        if (an.k === 'drop') y -= (1 - k) * (1 - k) * T * 0.7;
        else size = T * (1 + 0.2 * Math.sin(k * Math.PI));
      }
      const extra = type === 'sapling' ? Math.min(twStats(tw).growCap, tw[6] || 0) : tw[6] || 0;
      R.tower(g, type, tw[4], (tw[2] + 0.5) * T, y, skin, G.aim[bi][tw[0]] || 0, size, t, { extra, path: twPath(tw) });
      if (main && tw[0] === G.selected) {
        g.strokeStyle = '#fff'; g.lineWidth = 2; g.setLineDash([4, 4]);
        g.strokeRect(tw[2] * T + 1, tw[3] * T + 1, T - 2, T - 2); g.setLineDash([]);
      }
    }

    // towers that see ghosts, plus lantern lights (main board only): [x, y, range²], same check as the server
    const seers = main ? b.towers.map((tw) => {
      const s = twStats(tw);
      return s.detect ? [tw[2] + 0.5, tw[3] + 0.5, s.range * s.range] : null;
    }).filter(Boolean).concat(lights) : null;
    const inside = (list, p) => list.some(([sx, sy, r2]) => (p.x - sx) * (p.x - sx) + (p.y - sy) * (p.y - sy) <= r2);

    const sorted = b.enemies.slice().sort((x, y) => GD.ENEMIES[GD.ENEMY_ORDER[x[1]]].r - GD.ENEMIES[GD.ENEMY_ORDER[y[1]]].r);
    const hpLabels = [];
    for (const e of sorted) {
      const pe = pb && pb.emap && pb.emap.get(e[0]);
      const p = slimePos(e, pe || null, a) || GD.posAt(G.map, e[2] / 100);
      const type = GD.ENEMY_ORDER[e[1]];
      const hit = G.hits[bi].get(e[0]);
      // a ghost on the board that none of your ghost-seeing towers can reach gets a warning
      const ghost = !!GD.ENEMIES[type].ghost;
      const unseen = !!seers && ghost && p.x >= 0 && p.x <= G.cols && p.y >= 0 && p.y <= G.rows && !inside(seers, p);
      R.slime(g, type, p.x * T, p.y * T, T, {
        time: t, id: e[0], hp: e[3], slowed: e[4], dx: p.dx, dy: p.dy, unseen,
        lit: ghost && lights.length > 0 && inside(lights, p), // a ghost in a lantern's light is drawn solid
        flash: hit ? Math.max(0, 1 - (t - hit) / HIT_FLASH) : 0,
        // sent slimes wear a headband: pink in your lane (from your opponent), lime in theirs (from you)
        band: e[5] ? (bi === G.you ? '#ff6fa8' : '#9be15d') : null,
      });
      if (e.length > 9) hpLabels.push([p.x * T, (p.y - GD.ENEMIES[type].r) * T - 9, e[9]]);
    }
    // test field: exact HP above each standing slime (drawn last so other slimes don't cover it)
    if (hpLabels.length) {
      g.font = '700 11px Lexend, sans-serif'; g.textAlign = 'center'; g.lineWidth = 3; g.strokeStyle = 'rgba(14,9,24,0.85)'; g.fillStyle = '#fff';
      for (const [x, y, hp] of hpLabels) { g.strokeText(hp, x, Math.max(10, y)); g.fillText(hp, x, Math.max(10, y)); }
    }

    for (const f of G.effects) if (f.b === bi) effect(g, f, t);

    if (main && G.kb && G.cursor && !G.placing) {
      g.strokeStyle = '#ffffff'; g.lineWidth = 2.5; g.setLineDash([6, 4]);
      g.strokeRect(G.cursor.col * T + 2, G.cursor.row * T + 2, T - 4, T - 4); g.setLineDash([]);
    }
    if (main && G.placing && G.hover) {
      const { col, row } = G.hover;
      const ok = tileFree(col, row) && b.gold >= GD.TOWERS[G.placing].cost;
      const s = GD.towerStats(G.placing, 0);
      const cx = (col + 0.5) * T, cy = (row + 0.5) * T;
      if (s.range > 0 && s.range < 50) ring(g, cx, cy, s.range * T, ok ? 'rgba(155,225,93,0.18)' : 'rgba(255,92,92,0.18)', ok ? '#9be15d' : '#ff5c5c');
      g.globalAlpha = 0.75;
      R.tower(g, G.placing, 0, cx, cy, skin, 0, T, t, { noBadge: true });
      g.globalAlpha = 1;
      if (!ok) { g.fillStyle = 'rgba(255,60,60,0.35)'; g.fillRect(col * T, row * T, T, T); }
    }
    // test field: a see-through slime where the next one would go (red on a tower)
    if (main && G.placingSlime && G.hover && G.hover.col >= 0 && G.hover.row >= 0 && G.hover.col < G.cols && G.hover.row < G.rows) {
      const { col, row } = G.hover;
      const onTower = b.towers.some((tw) => tw[2] === col && tw[3] === row);
      g.globalAlpha = 0.6;
      R.slime(g, G.placingSlime, (col + 0.5) * T, (row + 0.5) * T, T, { time: t, id: 0, hp: 100, dx: 0, dy: 1 });
      g.globalAlpha = 1;
      g.strokeStyle = onTower ? '#ff5c5c' : '#ffffff'; g.lineWidth = 2; g.setLineDash([4, 4]);
      g.strokeRect(col * T + 1, row * T + 1, T - 2, T - 2); g.setLineDash([]);
    }
  }

  function ring(g, x, y, r, fill, stroke) {
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = fill; g.fill();
    g.strokeStyle = stroke; g.lineWidth = 1.5; g.setLineDash([6, 5]); g.stroke(); g.setLineDash([]);
  }

  function effect(g, f, t) {
    const k = (t - f.t0) / f.dur;
    // not started yet, or already over: a frame can come late (e.g. after the tab was in the background),
    // and k > 1 would give negative radii, which make arc() throw and stop the render loop
    if (k < 0 || k >= 1) return;
    switch (f.k) {
      case 'a': {
        const x = f.x1 + (f.x2 - f.x1) * k, y = f.y1 + (f.y2 - f.y1) * k;
        const ang = Math.atan2(f.y2 - f.y1, f.x2 - f.x1);
        g.strokeStyle = '#fff6dc'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(x - Math.cos(ang) * 9, y - Math.sin(ang) * 9); g.lineTo(x, y); g.stroke();
        break;
      }
      case 's':
        g.strokeStyle = `rgba(255,255,220,${1 - k})`; g.lineWidth = 2.5;
        g.beginPath(); g.moveTo(f.x1, f.y1); g.lineTo(f.x2, f.y2); g.stroke();
        break;
      case 'b': {
        const fly = 0.35;
        if (k < fly) {
          const q = k / fly, x = f.x1 + (f.x2 - f.x1) * q, y = f.y1 + (f.y2 - f.y1) * q - Math.sin(q * Math.PI) * 14;
          g.fillStyle = '#22252e'; g.beginPath(); g.arc(x, y, 4.5, 0, 7); g.fill();
        } else {
          const q = (k - fly) / (1 - fly);
          g.fillStyle = `rgba(255,170,60,${0.55 * (1 - q)})`;
          g.beginPath(); g.arc(f.x2, f.y2, f.r * (0.4 + 0.6 * q), 0, 7); g.fill();
          g.strokeStyle = `rgba(255,240,180,${1 - q})`; g.lineWidth = 2; g.stroke();
        }
        break;
      }
      case 'p': // Frost pulse (lantern flares and hatchery rings pass their own colour)
        g.strokeStyle = `rgba(${f.color || '200,240,255'},${0.8 * (1 - k)})`; g.lineWidth = 3;
        g.beginPath(); g.arc(f.x1, f.y1, f.r * k, 0, 7); g.stroke();
        g.fillStyle = `rgba(${f.color || '160,225,255'},${0.12 * (1 - k)})`; g.fill();
        break;
      case 'vine': { // Bramble Snare: a wavy thorn vine to the target
        const dx = f.x2 - f.x1, dy = f.y2 - f.y1, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
        g.strokeStyle = `rgba(79,154,60,${1 - k})`; g.lineWidth = 2.6; g.lineCap = 'round';
        g.beginPath();
        for (let i = 0; i <= 12; i++) {
          const q = (i / 12) * Math.min(1, k * 3), w = Math.sin(q * Math.PI * 3 + f.t0 * 20) * 3.5 * Math.sin(q * Math.PI);
          g.lineTo(f.x1 + dx * q + nx * w, f.y1 + dy * q + ny * w);
        }
        g.stroke(); g.lineCap = 'butt';
        break;
      }
      case 'cone': { // Ember Drake: a fire cone (blue from Blue Flame)
        const a0 = Math.atan2(f.y2 - f.y1, f.x2 - f.x1), r = f.r * (0.55 + 0.45 * Math.min(1, k * 2));
        const grad = g.createRadialGradient(f.x1, f.y1, 2, f.x1, f.y1, r);
        const stops = f.blue ? ['230,248,255', '90,170,255', '40,90,255'] : ['255,250,200', '255,170,40', '255,80,20'];
        grad.addColorStop(0, `rgba(${stops[0]},0.9)`); grad.addColorStop(0.55, `rgba(${stops[1]},0.75)`); grad.addColorStop(1, `rgba(${stops[2]},0)`);
        g.globalAlpha = 1 - k * 0.7; g.fillStyle = grad;
        g.beginPath(); g.moveTo(f.x1, f.y1); g.arc(f.x1, f.y1, r, a0 - f.half, a0 + f.half); g.closePath(); g.fill();
        g.globalAlpha = 1;
        break;
      }
      case 'seed': { // Elder Sapling: a seed flying to the target
        const x = f.x1 + (f.x2 - f.x1) * k, y = f.y1 + (f.y2 - f.y1) * k - Math.sin(k * Math.PI) * 6;
        g.fillStyle = '#8a5a2b'; g.strokeStyle = '#3d260f'; g.lineWidth = 1;
        g.beginPath(); g.ellipse(x, y, 3.2, 2.3, Math.atan2(f.y2 - f.y1, f.x2 - f.x1), 0, 7); g.fill(); g.stroke();
        break;
      }
      case 'beam': // Hex Idol (magenta) and Basilisk Eye (yellow-green)
        g.strokeStyle = `rgba(${f.color},${1 - k})`; g.lineWidth = f.width;
        g.shadowColor = `rgb(${f.color})`; g.shadowBlur = 8;
        g.beginPath(); g.moveTo(f.x1, f.y1 - 4); g.lineTo(f.x2, f.y2); g.stroke(); g.shadowBlur = 0;
        break;
      case 'bolt': { // Ballista: the bolt streaks along its whole line
        const ang = Math.atan2(f.y2 - f.y1, f.x2 - f.x1), x = f.x1 + (f.x2 - f.x1) * k, y = f.y1 + (f.y2 - f.y1) * k;
        const tq = Math.max(0, k - 0.4);
        g.strokeStyle = `rgba(255,246,220,${0.6 * (1 - k)})`; g.lineWidth = 3;
        g.beginPath(); g.moveTo(f.x1 + (f.x2 - f.x1) * tq, f.y1 + (f.y2 - f.y1) * tq); g.lineTo(x, y); g.stroke();
        g.strokeStyle = '#2a2018'; g.lineWidth = 2.6;
        g.beginPath(); g.moveTo(x - Math.cos(ang) * 14, y - Math.sin(ang) * 14); g.lineTo(x, y); g.stroke();
        g.fillStyle = '#c9d3df';
        g.beginPath(); g.moveTo(x + Math.cos(ang) * 4, y + Math.sin(ang) * 4);
        g.lineTo(x + Math.cos(ang + 2.5) * 4, y + Math.sin(ang + 2.5) * 4); g.lineTo(x + Math.cos(ang - 2.5) * 4, y + Math.sin(ang - 2.5) * 4);
        g.closePath(); g.fill();
        break;
      }
      case 'gold': { // Goldspitter: coins fly along the path (tower, target, ricochet target)
        const P = f.pts, seg = [];
        let total = 0;
        for (let i = 1; i < P.length; i++) { const l = Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); seg.push(l); total += l; }
        const at = (q) => {
          let d = q * total;
          for (let i = 0; i < seg.length; i++) {
            if (d <= seg[i] || i === seg.length - 1) { const u = seg[i] ? Math.min(1, d / seg[i]) : 1; return [P[i][0] + (P[i + 1][0] - P[i][0]) * u, P[i][1] + (P[i + 1][1] - P[i][1]) * u]; }
            d -= seg[i];
          }
          return P[P.length - 1];
        };
        g.fillStyle = '#ffd35c'; g.strokeStyle = '#8a6410'; g.lineWidth = 1;
        for (let j = 0; j < 3; j++) {
          const q = k - j * 0.1;
          if (q < 0) continue;
          const [x, y] = at(q);
          g.globalAlpha = 1 - j * 0.3;
          g.beginPath(); g.arc(x, y, 3.4 - j * 0.7, 0, 7); g.fill(); g.stroke();
        }
        g.globalAlpha = 1;
        break;
      }
      case 'stone': // Basilisk Eye: a petrified slime shatters into stone chunks
        g.globalAlpha = 1 - k;
        g.strokeStyle = `rgba(210,214,222,${1 - k})`; g.lineWidth = 2;
        g.beginPath(); g.arc(f.x1, f.y1, f.r * (1 + k), 0, 7); g.stroke();
        g.fillStyle = '#9aa0aa'; g.strokeStyle = '#4a4e57'; g.lineWidth = 1;
        for (let i = 0; i < 7; i++) {
          const a = i * 0.9 + f.seed, d = f.r * (0.3 + 1.6 * k), sx = f.x1 + Math.cos(a) * d, sy = f.y1 + Math.sin(a) * d + 10 * k * k;
          g.beginPath(); g.moveTo(sx, sy - 3.2); g.lineTo(sx + 3.2, sy); g.lineTo(sx, sy + 3.2); g.lineTo(sx - 3.2, sy); g.closePath(); g.fill(); g.stroke();
        }
        g.globalAlpha = 1;
        break;
      case 'c':
        g.strokeStyle = `rgba(${f.color || '255,240,120'},${1 - k})`; g.lineWidth = 2.2;
        g.shadowColor = f.color ? `rgb(${f.color})` : '#fff7a0'; g.shadowBlur = 8;
        g.beginPath();
        f.pts.forEach(([x, y], i) => {
          if (!i) return g.moveTo(x, y);
          const [px, py] = f.pts[i - 1];
          const mx = (px + x) / 2 + (Math.sin(f.t0 * 50 + i) * 6), my = (py + y) / 2 + (Math.cos(f.t0 * 40 + i) * 6);
          g.lineTo(mx, my); g.lineTo(x, y);
        });
        g.stroke(); g.shadowBlur = 0;
        break;
      case 'splat':
        g.fillStyle = f.color; g.globalAlpha = 1 - k;
        for (let i = 0; i < 6; i++) {
          const ang = i * 1.05 + f.seed, dist = f.r * (0.4 + k * 1.4);
          g.beginPath(); g.arc(f.x1 + Math.cos(ang) * dist, f.y1 + Math.sin(ang) * dist, f.r * 0.28 * (1 - k * 0.5), 0, 7); g.fill();
        }
        g.globalAlpha = 1;
        break;
      case 'dust': { // a new tower lands
        g.globalAlpha = 1 - k;
        g.strokeStyle = 'rgba(40,28,16,0.45)'; g.lineWidth = 2;
        g.beginPath(); g.ellipse(f.x1, f.y1, T * (0.3 + 0.45 * k), T * (0.1 + 0.15 * k), 0, 0, 7); g.stroke();
        g.fillStyle = 'rgba(240,230,210,0.95)'; g.strokeStyle = 'rgba(40,28,16,0.35)'; g.lineWidth = 1;
        for (let i = 0; i < 7; i++) {
          const a = i * 0.9 + f.seed, d = T * (0.28 + 0.4 * k);
          g.beginPath(); g.arc(f.x1 + Math.cos(a) * d, f.y1 + Math.sin(a) * d * 0.35 - k * 4, 3.2 * (1 - 0.5 * k), 0, 7); g.fill(); g.stroke();
        }
        g.globalAlpha = 1;
        break;
      }
      case 'spark': { // upgrade: a ring and sparks in the new tier colour
        g.globalAlpha = 1 - k;
        g.strokeStyle = f.color; g.lineWidth = 3 * (1 - k) + 0.5;
        g.beginPath(); g.arc(f.x1, f.y1, T * (0.35 + 0.45 * k), 0, 7); g.stroke();
        g.fillStyle = f.color; g.strokeStyle = 'rgba(30,21,48,0.7)'; g.lineWidth = 1;
        for (let i = 0; i < 10; i++) {
          const a = i * 0.628 + f.seed * 0.37, d = T * (0.3 + 0.55 * k), s = 4 * (1 - k) + 1.5;
          const sx = f.x1 + Math.cos(a) * d, sy = f.y1 + Math.sin(a) * d - k * 8;
          g.beginPath(); g.moveTo(sx, sy - s); g.lineTo(sx + s * 0.45, sy); g.lineTo(sx, sy + s); g.lineTo(sx - s * 0.45, sy); g.closePath();
          g.fill(); g.stroke();
        }
        g.globalAlpha = 1;
        break;
      }
      case 'coins': // sold: coins hop out of the empty tile
        g.globalAlpha = 1 - k * k;
        g.fillStyle = '#ffd35c'; g.strokeStyle = '#8a6410'; g.lineWidth = 1.2;
        for (let i = 0; i < 5; i++) {
          const a = -Math.PI / 2 + (i - 2) * 0.5, v = T * 0.85;
          const cx = f.x1 + Math.cos(a) * v * k, cy = f.y1 + Math.sin(a) * v * k + T * 0.9 * k * k;
          g.beginPath(); g.ellipse(cx, cy, 1 + 3.5 * Math.abs(Math.cos(k * 10 + i)), 4.5, 0, 0, 7); g.fill(); g.stroke();
        }
        g.globalAlpha = 1;
        break;
      case 'txt':
        g.globalAlpha = 1 - k; g.fillStyle = f.color; g.strokeStyle = '#2b1d00'; g.lineWidth = 3;
        g.font = 'bold 14px Lexend, sans-serif'; g.textAlign = 'center';
        g.strokeText(f.text, f.x1, f.y1 - k * 18); g.fillText(f.text, f.x1, f.y1 - k * 18);
        g.globalAlpha = 1;
        break;
    }
  }

  // ---------- end ----------
  const REASONS = {
    lives: (won) => (won ? 'Their lane got overrun.' : 'Your lane got overrun.'),
    forfeit: (won) => (won ? 'Your opponent forfeited.' : 'You forfeited.'),
    disconnect: (won) => (won ? 'Your opponent disconnected.' : 'You were disconnected too long.'),
    draw: () => 'Both lanes fell at the same moment.',
    error: () => "The match stopped because of a server error, so it doesn't count toward rating or wins.",
  };

  function end(res, onExit) {
    G.ended = true;
    window.Sfx.play(res.won ? 'win' : 'lose');
    $('end-again').hidden = false;
    const o = $('end-overlay');
    o.hidden = false;
    $('end-title').textContent = res.reason === 'error' ? 'Match stopped' : res.draw ? 'Draw' : res.won ? 'Victory' : 'Defeat';
    o.className = 'end ' + (res.draw ? 'draw' : res.won ? 'win' : 'loss');
    $('end-reason').textContent = (REASONS[res.reason] || REASONS.lives)(res.won) + ` Reached round ${res.round}.`;
    const r = res.rewards;
    const me = res.stats[G.you];
    $('end-rewards').innerHTML =
      `<div><b>+${r.xp}</b><span>XP</span></div><div><b class="gold">+${r.coins + r.levelBonus + (r.daily || 0)}</b><span>Coins</span></div>` +
      `<div><b>${me.kills}</b><span>Slimes popped</span></div><div><b>${me.sentGold}</b><span>Gold sent</span></div>` +
      (r.rating ? `<p class="rating-change ${r.rating > 0 ? 'up' : 'down'}">Rating ${r.rating > 0 ? '+' : ''}${r.rating} (now ${res.profile.rating})</p>` : '') +
      (r.levelUps ? `<p class="lvlup">Level up! You're now level ${r.level}.</p>` : '') +
      (r.daily ? `<p class="lvlup">First win of the day: +${r.daily} bonus coins included.</p>` : '') +
      (res.cheated ? '<p class="muted">Admin powers were used, so this match doesn\'t count toward rating or wins.</p>'
        : res.early && res.reason !== 'error' ? '<p class="muted">Match ended before round 5, so it counts for less and not toward your record.</p>' : '');
    $('end-back').onclick = () => { stop(); onExit(); };
  }

  function stop() { G.active = false; document.body.classList.remove('spectating'); }

  function spectateEnd(r, onExit) {
    if (!G.active) return;
    G.ended = true;
    const o = $('end-overlay');
    o.hidden = false;
    o.className = 'end draw';
    $('end-title').textContent = r.reason === 'error' ? 'Match stopped' : r.winner ? `${r.winner} won` : 'Draw';
    $('end-reason').textContent = (r.reason === 'error' ? 'The match stopped because of a server error. ' : '') + `The match ended in round ${r.round}.`;
    $('end-rewards').innerHTML = '';
    $('end-rematch').hidden = true;
    $('end-again').hidden = true;
    $('end-back').onclick = () => { $('end-again').hidden = false; stop(); onExit(); };
  }

  function setSpectators(n) {
    $('spectator-count').textContent = n > 0 ? `${n} watching` : '';
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  bindInput();
  window.Game = { start, snap, end, stop, toast, emote, spectateEnd, setSpectators, isActive: () => G.active, mode: () => G.info && G.info.mode };
})();
