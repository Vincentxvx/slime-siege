// In-match client: renders server snapshots, handles placing/upgrading/sending.
(function () {
  const GD = window.GD, R = window.Render;
  const T = R.T, W = R.W, H = R.H;
  const $ = (id) => document.getElementById(id);
  const now = () => performance.now() / 1000;

  const G = {
    active: false, info: null, net: null, you: 0,
    prev: null, cur: null, prevAt: 0, curAt: 0, interval: 0.1,
    placing: null, hover: null, selected: null,
    effects: [], aim: [{}, {}], built: false, panelKey: '', lastRound: -1,
  };

  // ---------- setup ----------
  function start(info, net) {
    Object.assign(G, {
      active: true, info, net, you: info.you, prev: null, cur: null, effects: [], aim: [{}, {}],
      placing: null, hover: null, selected: null, panelKey: '', lastRound: -1, ended: false, previewRound: -1,
    });
    G.map = GD.MAPS[info.map];
    G.me = info.players[info.you];
    G.op = info.players[1 - info.you];
    plate($('hud-me-plate'), G.me);
    plate($('hud-op-plate'), G.op);
    $('end-overlay').hidden = true;
    $('countdown').hidden = false;
    $('btn-forfeit').textContent = 'Forfeit';
    $('btn-forfeit').classList.remove('armed');
    buildTowerBar();
    buildSends();
    renderPanel(true);
    buildEmotes();
    $('bubble-me').hidden = true; $('bubble-op').hidden = true;
    sizeCanvases();
    window.Sfx.play('start');
    requestAnimationFrame(frame);
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
    el.append(n, l);
  }

  function sizeCanvases() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const [id, k] of [['cv-main', 1], ['cv-opp', 0.5]]) {
      const c = $(id);
      c.width = Math.round(W * k * dpr); c.height = Math.round(H * k * dpr);
    }
  }
  window.addEventListener('resize', () => G.active && sizeCanvases());

  function buildTowerBar() {
    const bar = $('tower-bar');
    bar.innerHTML = '';
    let key = 1;
    GD.TOWER_ORDER.forEach((type) => {
      const T0 = GD.TOWERS[type];
      const unlocked = G.me.unlocked.includes(type);
      const b = document.createElement('button');
      b.className = 'tcard' + (unlocked ? '' : ' locked');
      b.dataset.type = type;
      b.title = unlocked ? `${T0.name}: ${T0.desc}` : `${T0.name} — unlock it in the shop`;
      b.append(R.towerIcon(type, G.me.skin, 38));
      const name = document.createElement('span'); name.className = 'tname'; name.textContent = T0.name;
      const cost = document.createElement('span'); cost.className = 'tcost'; cost.textContent = unlocked ? T0.cost : 'Locked';
      b.append(name, cost);
      if (unlocked) {
        const k = document.createElement('kbd'); k.textContent = key; b.dataset.key = key++; b.append(k);
        b.onclick = () => setPlacing(G.placing === type ? null : type);
      } else b.disabled = true;
      bar.append(b);
    });
  }

  function buildSends() {
    const grid = $('send-grid');
    grid.innerHTML = '';
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

  const SEND_KEYS = ['q', 'w', 'e', 'a', 's', 'd', 'z', 'x', 'c'];

  // ---------- networking ----------
  function act(a) {
    G.net.action(a).then((res) => {
      if (!res.ok) { toast(res.error, 'bad'); window.Sfx.play('error'); return; }
      window.Sfx.play(a.type === 'target' ? 'emote' : a.type);
      if (a.type === 'place' && res.id) {
        if (!G.shift) { G.selected = res.id; setPlacing(null); }
      } else if (a.type === 'sell') { G.selected = null; renderPanel(true); }
    });
  }

  function snap(s) {
    if (!G.active) return;
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
      if (G.prev) deaths(i, G.prev.boards[i], b);
    });
    if (G.selected && !G.cur.boards[G.you].tmap.has(G.selected)) G.selected = null;
    updateHud();
    renderPanel(false);
  }

  function processEvents(bi, b) {
    const t = now();
    for (const ev of b.ev) {
      const tw = b.tmap.get(ev[1]);
      const tx = tw ? (tw[2] + 0.5) * T : 0, ty = tw ? (tw[3] + 0.5) * T : 0;
      switch (ev[0]) {
        case 'a': case 's':
          if (bi === G.you) window.Sfx.play(ev[0] === 'a' ? 'arrow' : 'shot');
          G.aim[bi][ev[1]] = Math.atan2(ev[3] * T - ty, ev[2] * T - tx);
          G.effects.push({ b: bi, k: ev[0], x1: tx, y1: ty, x2: ev[2] * T, y2: ev[3] * T, t0: t, dur: ev[0] === 'a' ? 0.12 : 0.08 });
          break;
        case 'b':
          if (bi === G.you) window.Sfx.play('boom');
          G.aim[bi][ev[1]] = Math.atan2(ev[3] * T - ty, ev[2] * T - tx);
          G.effects.push({ b: bi, k: 'b', x1: tx, y1: ty, x2: ev[2] * T, y2: ev[3] * T, r: ev[4] * T, t0: t, dur: 0.42 });
          break;
        case 'p': {
          if (bi === G.you) window.Sfx.play('pulse');
          const range = tw ? GD.towerStats(GD.TOWER_ORDER[tw[1]], tw[4]).range : 2;
          G.effects.push({ b: bi, k: 'p', x1: tx, y1: ty, r: range * T, t0: t, dur: 0.4 });
          break;
        }
        case 'c': {
          if (bi === G.you) window.Sfx.play('zap');
          const pts = [[tx, ty - 4]];
          for (let i = 2; i < ev.length; i += 2) pts.push([ev[i] * T, ev[i + 1] * T]);
          G.effects.push({ b: bi, k: 'c', pts, t0: t, dur: 0.2 });
          break;
        }
        case 'm':
          if (bi === G.you) window.Sfx.play('coin');
          G.effects.push({ b: bi, k: 'txt', x1: tx, y1: ty - 10, text: '+' + ev[2], color: '#ffd35c', t0: t, dur: 1.1 });
          break;
        case 'i':
          if (bi === G.you) {
            window.Sfx.play('incoming');
            const p = GD.SENDS[ev[1]];
            toast(`Incoming: ${p.count}× ${GD.ENEMIES[p.enemy].name}`, 'warn');
          }
          break;
      }
    }
  }

  function deaths(bi, prevB, curB) {
    const t = now();
    for (const e of prevB.enemies) {
      if (curB.emap.has(e[0])) continue;
      const d = e[2] / 100;
      if (d > G.map.length - 0.6) continue; // leaked, not killed
      const p = GD.posAt(G.map, d);
      const type = GD.ENEMY_ORDER[e[1]];
      if (bi === G.you) window.Sfx.play('pop');
      G.effects.push({ b: bi, k: 'splat', x1: p.x * T, y1: p.y * T, color: GD.ENEMIES[type].color, r: GD.ENEMIES[type].r * T, t0: t, dur: 0.35, seed: e[0] });
    }
  }

  // ---------- HUD & panels ----------
  function updateHud() {
    const s = G.cur, me = s.boards[G.you], op = s.boards[1 - G.you];
    $('hud-lives').textContent = me.lives;
    $('hud-gold').textContent = me.gold;
    $('hud-income').textContent = me.income + me.mine;
    $('hud-op-lives').textContent = op.lives;
    $('hud-op-income').textContent = op.income + op.mine;
    $('hud-round').textContent = Math.max(1, s.round);
    $('hud-lives').parentElement.classList.toggle('low', me.lives <= 25);
    const cd = $('countdown');
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
    document.querySelectorAll('#send-grid .send').forEach((b) => {
      const p = GD.SENDS[b.dataset.i];
      const locked = s.round < p.round;
      const cdv = me.cds ? me.cds[b.dataset.i] : 0;
      b.classList.toggle('locked', locked);
      b.classList.toggle('poor', !locked && me.gold < p.cost);
      b.disabled = locked;
      b.querySelector('.scd').style.transform = `scaleX(${p.cd ? Math.min(1, cdv / p.cd) : 0})`;
    });
  }

  function statChips(s) {
    const c = [];
    if (s.kind === 'mine') c.push(['Gold / tick', s.gold]);
    else {
      if (s.dmg) c.push(['Damage', +s.dmg.toFixed(1)]);
      if (s.kind === 'pulse') c.push(['Slow', Math.round(s.slow * 100) + '%']);
      c.push([s.kind === 'pulse' ? 'Pulses/s' : 'Shots/s', +s.rate.toFixed(2)]);
      c.push(['Range', s.range > 50 ? 'Map' : +s.range.toFixed(1)]);
      if (s.targets > 1) c.push(['Targets', s.targets]);
      if (s.chains) c.push(['Jumps', s.chains]);
      if (s.splash) c.push(['Blast', +s.splash.toFixed(1)]);
    }
    const tags = [];
    if (s.detect) tags.push('Sees ghosts');
    if (s.pierceArmor) tags.push('Ignores armor');
    return '<div class="chips">' + c.map(([k, v]) => `<span><b>${v}</b>${k}</span>`).join('') + '</div>' +
      (tags.length ? '<div class="tags">' + tags.map((t) => `<em>${t}</em>`).join('') + '</div>' : '');
  }

  function renderPanel(force) {
    const panel = $('tower-panel');
    const me = G.cur ? G.cur.boards[G.you] : null;
    const tw = G.selected && me ? me.tmap.get(G.selected) : null;
    const key = G.placing ? 'p:' + G.placing : tw ? `t:${tw[0]}:${tw[4]}:${tw[5]}` : 'none';
    if (key !== G.panelKey || force) {
      G.panelKey = key;
      if (G.placing) {
        const T0 = GD.TOWERS[G.placing];
        panel.innerHTML = `<h3>${T0.name}</h3><p class="muted">${T0.desc}</p>${statChips(GD.towerStats(G.placing, 0))}
          <p class="hint">Click a free tile to build for <b class="gold">${T0.cost}</b>. Hold Shift to keep building. Esc cancels.</p>`;
      } else if (tw) {
        const type = GD.TOWER_ORDER[tw[1]], T0 = GD.TOWERS[type], level = tw[4];
        const next = T0.upgrades[level];
        const pips = T0.upgrades.map((u, i) => `<i class="${i < level ? 'done' : ''}" title="${u.name}: ${u.desc}"></i>`).join('');
        const upHtml = next
          ? `<div class="next-up"><div><b>${next.name}</b><small>${next.desc}</small></div><button class="btn up" data-act="upgrade" title="Upgrade (U)">Upgrade <b>${next.cost}</b></button></div>`
          : '<div class="next-up maxed"><b>Fully upgraded</b></div>';
        const modes = T0.base.kind === 'mine' || T0.base.kind === 'pulse' ? '' :
          `<div class="seg" role="group" aria-label="Targeting">${GD.TARGET_MODES.map((m, i) =>
            `<button data-mode="${m}" class="${tw[5] === i ? 'on' : ''}">${m[0].toUpperCase() + m.slice(1)}</button>`).join('')}</div>`;
        panel.innerHTML = `<div class="ph"><h3>${T0.name}</h3><span class="pips" aria-label="Level ${level} of 3">${pips}</span><button class="btn sell" data-act="sell" title="Sell (Delete)">Sell <b>${GD.sellValue(type, level)}</b></button></div>
          ${statChips(GD.towerStats(type, level))}${modes}${upHtml}`;
        panel.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => act({ type: 'target', id: tw[0], mode: b.dataset.mode })));
        const up = panel.querySelector('[data-act=upgrade]');
        if (up) up.onclick = () => act({ type: 'upgrade', id: tw[0] });
        panel.querySelector('[data-act=sell]').onclick = () => act({ type: 'sell', id: tw[0] });
      } else {
        panel.innerHTML = `<h3>Defend your lane</h3><p class="muted">Pick a tower (keys 1–${G.me.unlocked.length}) and click a free tile.
          Click a placed tower to upgrade or sell it. Sending slimes pressures your opponent and raises your income.</p>`;
      }
    }
    // live affordability of the upgrade button
    const up = panel.querySelector('[data-act=upgrade]');
    if (up && tw && me) {
      const u = GD.TOWERS[GD.TOWER_ORDER[tw[1]]].upgrades[tw[4]];
      up.disabled = !u || me.gold < u.cost;
    }
  }

  function setPlacing(type) {
    G.placing = type;
    if (type) G.selected = null;
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
    if (col < 0 || row < 0 || col >= GD.COLS || row >= GD.ROWS) return false;
    if (G.map.pathTiles.has(col + ',' + row)) return false;
    const me = G.cur && G.cur.boards[G.you];
    return !(me && me.towers.some((t) => t[2] === col && t[3] === row));
  }

  function bindInput() {
    const c = $('cv-main');
    c.addEventListener('mousemove', (e) => { G.hover = tileFromEvent(e); });
    c.addEventListener('mouseleave', () => { G.hover = null; });
    c.addEventListener('contextmenu', (e) => { e.preventDefault(); setPlacing(null); G.selected = null; renderPanel(true); });
    c.addEventListener('click', (e) => {
      if (!G.active || !G.cur) return;
      const { col, row } = tileFromEvent(e);
      G.shift = e.shiftKey;
      if (G.placing) {
        if (!tileFree(col, row)) return toast("Can't build there", 'bad');
        act({ type: 'place', tower: G.placing, col, row });
        return;
      }
      const tw = G.cur.boards[G.you].towers.find((t) => t[2] === col && t[3] === row);
      G.selected = tw ? tw[0] : null;
      renderPanel(true);
    });
    window.addEventListener('keydown', (e) => {
      if (!G.active || e.target.tagName === 'INPUT') return;
      if (e.key === 'Escape') { setPlacing(null); G.selected = null; renderPanel(true); return; }
      const card = document.querySelector(`#tower-bar [data-key="${e.key}"]`);
      if (card) { setPlacing(G.placing === card.dataset.type ? null : card.dataset.type); return; }
      const si = SEND_KEYS.indexOf(e.key.toLowerCase());
      if (si >= 0 && !e.ctrlKey && !e.metaKey) {
        const btn = document.querySelector(`#send-grid .send[data-i="${si}"]`);
        if (btn && !btn.disabled) act({ type: 'send', pack: GD.SENDS[si].id });
        return;
      }
      if (G.selected && (e.key === 'u' || e.key === 'U')) act({ type: 'upgrade', id: G.selected });
      if (G.selected && (e.key === 'Delete' || e.key === 'Backspace')) act({ type: 'sell', id: G.selected });
    });
    $('btn-chat').addEventListener('click', () => {
      const row = $('emote-row');
      row.hidden = !row.hidden;
      $('btn-chat').setAttribute('aria-expanded', String(!row.hidden));
    });
    $('btn-forfeit').addEventListener('click', (e) => {
      const b = e.currentTarget;
      if (b.classList.contains('armed')) { G.net.forfeit(); return; }
      b.classList.add('armed'); b.textContent = 'Click again to confirm';
      setTimeout(() => { b.classList.remove('armed'); b.textContent = 'Forfeit'; }, 3000);
    });
  }

  // ---------- rendering ----------
  function frame() {
    if (!G.active) return;
    draw($('cv-main'), G.you, true);
    draw($('cv-opp'), 1 - G.you, false);
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
        const s = GD.towerStats(GD.TOWER_ORDER[sel[1]], sel[4]);
        if (s.range > 0 && s.range < 50) ring(g, (sel[2] + 0.5) * T, (sel[3] + 0.5) * T, s.range * T, 'rgba(255,255,255,0.14)', 'rgba(255,255,255,0.7)');
      }
    }

    for (const tw of b.towers) {
      const type = GD.TOWER_ORDER[tw[1]];
      R.tower(g, type, tw[4], (tw[2] + 0.5) * T, (tw[3] + 0.5) * T, skin, G.aim[bi][tw[0]] || 0, T, t);
      if (main && tw[0] === G.selected) {
        g.strokeStyle = '#fff'; g.lineWidth = 2; g.setLineDash([4, 4]);
        g.strokeRect(tw[2] * T + 1, tw[3] * T + 1, T - 2, T - 2); g.setLineDash([]);
      }
    }

    const sorted = b.enemies.slice().sort((x, y) => GD.ENEMIES[GD.ENEMY_ORDER[x[1]]].r - GD.ENEMIES[GD.ENEMY_ORDER[y[1]]].r);
    for (const e of sorted) {
      let d = e[2] / 100;
      const pe = pb && pb.emap && pb.emap.get(e[0]);
      if (pe) d = pe[2] / 100 + (d - pe[2] / 100) * a;
      const p = GD.posAt(G.map, d);
      R.slime(g, GD.ENEMY_ORDER[e[1]], p.x * T, p.y * T, T, { time: t, id: e[0], hp: e[3], slowed: e[4], dx: p.dx, dy: p.dy });
    }

    for (const f of G.effects) if (f.b === bi) effect(g, f, t);

    if (main && G.placing && G.hover) {
      const { col, row } = G.hover;
      const ok = tileFree(col, row) && b.gold >= GD.TOWERS[G.placing].cost;
      const s = GD.towerStats(G.placing, 0);
      const cx = (col + 0.5) * T, cy = (row + 0.5) * T;
      if (s.range > 0 && s.range < 50) ring(g, cx, cy, s.range * T, ok ? 'rgba(155,225,93,0.18)' : 'rgba(255,92,92,0.18)', ok ? '#9be15d' : '#ff5c5c');
      g.globalAlpha = 0.75;
      R.tower(g, G.placing, 0, cx, cy, skin, 0, T, t);
      g.globalAlpha = 1;
      if (!ok) { g.fillStyle = 'rgba(255,60,60,0.35)'; g.fillRect(col * T, row * T, T, T); }
    }
  }

  function ring(g, x, y, r, fill, stroke) {
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = fill; g.fill();
    g.strokeStyle = stroke; g.lineWidth = 1.5; g.setLineDash([6, 5]); g.stroke(); g.setLineDash([]);
  }

  function effect(g, f, t) {
    const k = (t - f.t0) / f.dur;
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
      case 'p':
        g.strokeStyle = `rgba(200,240,255,${0.8 * (1 - k)})`; g.lineWidth = 3;
        g.beginPath(); g.arc(f.x1, f.y1, f.r * k, 0, 7); g.stroke();
        g.fillStyle = `rgba(160,225,255,${0.12 * (1 - k)})`; g.fill();
        break;
      case 'c':
        g.strokeStyle = `rgba(255,240,120,${1 - k})`; g.lineWidth = 2.2;
        g.shadowColor = '#fff7a0'; g.shadowBlur = 8;
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
  };

  function end(res, onExit) {
    G.ended = true;
    window.Sfx.play(res.won ? 'win' : 'lose');
    const o = $('end-overlay');
    o.hidden = false;
    $('end-title').textContent = res.draw ? 'Draw' : res.won ? 'Victory' : 'Defeat';
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
      (res.early ? '<p class="muted">Match ended before round 5, so it counts for less and not toward your record.</p>' : '');
    $('end-back').onclick = () => { stop(); onExit(); };
  }

  function stop() { G.active = false; }

  bindInput();
  window.Game = { start, snap, end, stop, toast, emote, isActive: () => G.active, mode: () => G.info && G.info.mode };
})();
