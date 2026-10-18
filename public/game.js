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
    effects: [], aim: [{}, {}], hits: [new Map(), new Map()], anim: [new Map(), new Map()], built: false, panelKey: '', lastRound: -1,
  };
  const HIT_FLASH = 0.16; // seconds a slime flashes white after losing HP
  const DROP = 0.18;      // seconds a new tower takes to drop onto its tile
  const TIER_COLORS = ['#efe7ff', '#f0a564', '#e6edf5', '#ffd35c']; // text/sparks per level: base, bronze, silver, gold

  // ---------- setup ----------
  function start(info, net) {
    Object.assign(G, {
      active: true, info, net, you: info.you, prev: null, cur: null, effects: [], aim: [{}, {}], hits: [new Map(), new Map()], anim: [new Map(), new Map()],
      placing: null, hover: null, selected: null, panelKey: '', lastRound: -1, ended: false, previewRound: -1,
    });
    G.map = GD.MAPS[info.map];
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
    $('btn-forfeit').textContent = 'Forfeit';
    $('btn-forfeit').classList.remove('armed');
    buildTowerBar();
    buildSends();
    renderPanel(true);
    buildEmotes();
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
          b.append(R.towerIcon(type, G.me.skin, 46));
          const tags = [st.detect ? 'Sees ghosts' : '', st.pierceArmor ? 'Ignores armor' : ''].filter(Boolean).join(', ');
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

  // Small icons of the towers your opponent brought, kept on their mini view all match.
  // Built from the snapshot, so it also appears after a reload or for a spectator who joins late.
  function showOppLoadout(list) {
    const key = list.join(',');
    if (key === G.oppLoadout) return;
    G.oppLoadout = key;
    const box = $('opp-loadout'), skin = G.info.players[1 - G.you].skin;
    box.innerHTML = '';
    box.hidden = !list.length;
    box.setAttribute('aria-label', `Towers ${G.op.name} brought`);
    for (const type of list) {
      const T0 = GD.TOWERS[type];
      if (!T0) continue;
      const base = GD.towerStats(type, 0), max = GD.towerStats(type, T0.upgrades.length);
      const notes = [];
      if (base.detect) notes.push('Sees ghosts'); else if (max.detect) notes.push('Sees ghosts when fully upgraded');
      if (base.pierceArmor) notes.push('Ignores armor'); else if (max.pierceArmor) notes.push('Ignores armor when fully upgraded');
      const el = document.createElement('span');
      el.title = [`${T0.name}: ${T0.desc}`].concat(notes.filter((n) => !T0.desc.includes(n)).map((n) => n + '.')).join(' ');
      el.setAttribute('role', 'img');
      el.setAttribute('aria-label', el.title);
      el.append(R.towerIcon(type, skin, 18));
      box.append(el);
    }
  }

  function buildTowerBar() {
    const bar = $('tower-bar');
    bar.innerHTML = '';
    let key = 1;
    // Only the towers brought into this match (your loadout), in the order you picked them
    G.me.unlocked.filter((t) => GD.TOWERS[t]).forEach((type) => {
      const T0 = GD.TOWERS[type];
      const unlocked = true;
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
      window.Sfx.play(a.type === 'target' || a.type === 'power' ? 'emote' : a.type);
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
      // the previous snapshot has no maps if it was from the picking phase
      const pb = G.prev && G.prev.boards[i];
      if (pb && pb.emap) { deaths(i, pb, b); hits(i, pb, b); towerChanges(i, pb, b); }
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
        case 'x':
          if (bi === G.you) toast('Your opponent used admin powers, so this match won\'t count', 'warn');
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

  // Slimes whose HP dropped since the last snapshot flash white for a moment
  // (no flash means the shots bounced off, e.g. arrows on a Knight's armor)
  function hits(bi, prevB, curB) {
    const t = now(), m = G.hits[bi];
    for (const e of curB.enemies) {
      const pe = prevB.emap.get(e[0]);
      if (pe && e[3] < pe[3]) m.set(e[0], t);
    }
    for (const [id, at] of m) if (t - at > HIT_FLASH) m.delete(id);
  }

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
        G.effects.push({ b: bi, k: 'txt', x1: x, y1: y - T * 0.55, text: tw[4] >= 3 ? 'MAX' : 'Level ' + (tw[4] + 1), color, t0: t, dur: 1.1 });
      }
    }
    for (const old of prevB.towers) {
      if (curB.tmap.has(old[0])) continue;
      const x = (old[2] + 0.5) * T, y = (old[3] + 0.5) * T;
      G.effects.push({ b: bi, k: 'coins', x1: x, y1: y, t0: t, dur: 0.7 });
      if (bi === G.you) G.effects.push({ b: bi, k: 'txt', x1: x, y1: y - 10, text: '+' + GD.sellValue(GD.TOWER_ORDER[old[1]], old[4]), color: '#ffd35c', t0: t, dur: 1.1 });
    }
    for (const [id, a] of anim) if (t - a.t0 > a.dur) anim.delete(id);
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

  // [label, value] pairs for a tower's stats; `all` also lists stats at their default (0 damage, 1 target)
  function chipList(s, all) {
    const c = [];
    if (s.kind === 'mine') c.push(['Gold / tick', s.gold]);
    else {
      if (s.dmg || all) c.push(['Damage', +(s.dmg || 0).toFixed(1)]);
      if (s.kind === 'pulse') c.push(['Slow', Math.round(s.slow * 100) + '%']);
      c.push([s.kind === 'pulse' ? 'Pulses/s' : 'Shots/s', +s.rate.toFixed(2)]);
      c.push(['Range', s.range > 50 ? 'Map' : +s.range.toFixed(1)]);
      if (s.targets > 1 || (all && s.kind === 'arrow')) c.push(['Targets', s.targets || 1]);
      if (s.chains) c.push(['Jumps', s.chains]);
      if (s.splash) c.push(['Blast', +s.splash.toFixed(1)]);
    }
    return c;
  }
  function tagList(s) {
    const tags = [];
    if (s.detect) tags.push('Sees ghosts');
    if (s.pierceArmor) tags.push('Ignores armor');
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
    const key = G.placing ? 'p:' + G.placing : tw ? `t:${tw[0]}:${tw[4]}:${tw[5]}` : 'none';
    if (key !== G.panelKey || force) {
      G.panelKey = key;
      if (G.placing) {
        const T0 = GD.TOWERS[G.placing];
        panel.innerHTML = `<h3>${T0.name}</h3><p class="muted">${T0.desc}</p>${statChips(GD.towerStats(G.placing, 0))}
          <p class="hint">Click a free tile (or move with the arrows and press <kbd>Enter</kbd>) to build for <b class="gold">${T0.cost}</b>. Hold Shift to keep building. Esc cancels.</p>`;
      } else if (tw) {
        const type = GD.TOWER_ORDER[tw[1]], T0 = GD.TOWERS[type], level = tw[4];
        const next = T0.upgrades[level];
        const lvlLabel = level >= 3 ? 'Level MAX' : `Level ${level + 1}`;
        const upHtml = next
          ? `<div class="next-up"><div><b>${next.name}</b><small title="${next.desc}">${next.desc}</small></div><button class="btn up" data-act="upgrade" title="Upgrade (U)">Upgrade <b>${next.cost}</b></button></div>`
          : '<div class="next-up maxed"><b>Fully upgraded</b></div>';
        const modes = T0.base.kind === 'mine' || T0.base.kind === 'pulse' ? '' :
          `<div class="seg" role="group" aria-label="Targeting">${GD.TARGET_MODES.map((m, i) =>
            `<button data-mode="${m}" class="${tw[5] === i ? 'on' : ''}">${m[0].toUpperCase() + m.slice(1)}</button>`).join('')}</div>`;
        panel.innerHTML = `<div class="ph"><h3>${T0.name}</h3><span class="lvl-badge ${level >= 3 ? 'max' : ''}" title="Level ${level + 1} of 4">${lvlLabel}</span><button class="btn sell" data-act="sell" title="Sell (Delete)">Sell <b>${GD.sellValue(type, level)}</b></button></div>
          ${upHtml}${modes}${statChips(GD.towerStats(type, level), next ? GD.towerStats(type, level + 1) : null)}`;
        panel.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => act({ type: 'target', id: tw[0], mode: b.dataset.mode })));
        const up = panel.querySelector('[data-act=upgrade]');
        if (up) up.onclick = () => act({ type: 'upgrade', id: tw[0] });
        panel.querySelector('[data-act=sell]').onclick = () => act({ type: 'sell', id: tw[0] });
      } else if (G.spectator) {
        panel.innerHTML = `<h3>Watching ${esc(G.info.watching)}</h3><p class="muted">You're seeing ${esc(G.info.watching)}'s lane. Their opponent's lane is in the small view above. Click a tower to see its stats.</p>`;
      } else {
        panel.innerHTML = `<h3>Defend your lane</h3><p class="muted">Pick a tower (keys 1–${G.me.unlocked.length}) and click a free tile.
          Click a placed tower to upgrade or sell it. Sending slimes pressures your opponent and raises your income.</p>
          <p class="hint">Keyboard: arrows move, <kbd>Enter</kbd> builds or selects, <kbd>U</kbd> upgrade, <kbd>T</kbd> targeting, <kbd>Del</kbd> sell.</p>`;
      }
    }
    // live affordability of the upgrade button: says how much gold is missing
    const up = panel.querySelector('[data-act=upgrade]');
    if (up && tw && me) {
      const u = GD.TOWERS[GD.TOWER_ORDER[tw[1]]].upgrades[tw[4]];
      const short = u ? u.cost - me.gold : 0;
      up.disabled = !u || short > 0;
      const label = u ? (short > 0 ? `Need <b>${short}</b> more` : `Upgrade <b>${u.cost}</b>`) : '';
      if (up.dataset.label !== label) { up.dataset.label = label; up.innerHTML = label; }
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
    c.addEventListener('mousemove', (e) => { G.hover = tileFromEvent(e); G.cursor = Object.assign({}, G.hover); G.kb = false; });
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
      if (G.picking) {
        if (G.spectator) return;
        const n = Number(e.key);
        const cards = [...document.querySelectorAll('#pick-grid .pick-tower')];
        if (n >= 1 && n <= cards.length) togglePick(cards[n - 1].dataset.type);
        if (e.key === 'Enter' && !$('pick-ready').disabled) $('pick-ready').click();
        return;
      }
      if (e.key === 'Escape') { setPlacing(null); G.selected = null; renderPanel(true); return; }
      // Keyboard play: arrows move a cursor, Enter builds or selects, T changes targeting
      const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (dir) {
        e.preventDefault();
        if (!G.cursor) G.cursor = { col: 7, row: 5 };
        else {
          G.cursor.col = Math.max(0, Math.min(GD.COLS - 1, G.cursor.col + dir[0]));
          G.cursor.row = Math.max(0, Math.min(GD.ROWS - 1, G.cursor.row + dir[1]));
        }
        G.hover = Object.assign({}, G.cursor);
        G.kb = true;
        return;
      }
      if (e.key === 'Enter' && G.cursor && G.cur && !G.spectator) {
        e.preventDefault();
        const { col, row } = G.cursor;
        G.shift = e.shiftKey;
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
      if ((e.key === 't' || e.key === 'T') && G.selected && G.cur) {
        const tw = G.cur.boards[G.you].tmap.get(G.selected);
        const kind = tw && GD.TOWERS[GD.TOWER_ORDER[tw[1]]].base.kind;
        if (tw && kind !== 'mine' && kind !== 'pulse') act({ type: 'target', id: tw[0], mode: GD.TARGET_MODES[(tw[5] + 1) % GD.TARGET_MODES.length] });
        return;
      }
      const card = document.querySelector(`#tower-bar [data-key="${e.key}"]`);
      if (card) { setPlacing(G.placing === card.dataset.type ? null : card.dataset.type); return; }
      const bk = BULK_KEYS[e.key.toLowerCase()];
      if (bk && !e.ctrlKey && !e.metaKey) { bulkSend(bk); return; }
      const si = SEND_KEYS.indexOf(e.key.toLowerCase());
      if (si >= 0 && !e.ctrlKey && !e.metaKey) {
        const btn = document.querySelector(`#send-grid .send[data-i="${si}"]`);
        if (btn && !btn.disabled) act({ type: 'send', pack: GD.SENDS[si].id });
        return;
      }
      if (G.selected && (e.key === 'u' || e.key === 'U')) act({ type: 'upgrade', id: G.selected });
      if (G.selected && (e.key === 'Delete' || e.key === 'Backspace')) act({ type: 'sell', id: G.selected });
    });
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
      let y = (tw[3] + 0.5) * T, size = T;
      const an = G.anim[bi].get(tw[0]);
      if (an) { // new towers drop in, upgraded ones pop
        const k = Math.min(1, (t - an.t0) / an.dur);
        if (an.k === 'drop') y -= (1 - k) * (1 - k) * T * 0.7;
        else size = T * (1 + 0.2 * Math.sin(k * Math.PI));
      }
      R.tower(g, type, tw[4], (tw[2] + 0.5) * T, y, skin, G.aim[bi][tw[0]] || 0, size, t);
      if (main && tw[0] === G.selected) {
        g.strokeStyle = '#fff'; g.lineWidth = 2; g.setLineDash([4, 4]);
        g.strokeRect(tw[2] * T + 1, tw[3] * T + 1, T - 2, T - 2); g.setLineDash([]);
      }
    }

    // towers that see ghosts (main board only): [x, y, range²], same check as the server's candidates()
    const seers = main ? b.towers.map((tw) => {
      const s = GD.towerStats(GD.TOWER_ORDER[tw[1]], tw[4]);
      return s.detect ? [tw[2] + 0.5, tw[3] + 0.5, s.range * s.range] : null;
    }).filter(Boolean) : null;

    const sorted = b.enemies.slice().sort((x, y) => GD.ENEMIES[GD.ENEMY_ORDER[x[1]]].r - GD.ENEMIES[GD.ENEMY_ORDER[y[1]]].r);
    for (const e of sorted) {
      let d = e[2] / 100;
      const pe = pb && pb.emap && pb.emap.get(e[0]);
      if (pe) d = pe[2] / 100 + (d - pe[2] / 100) * a;
      const p = GD.posAt(G.map, d);
      const type = GD.ENEMY_ORDER[e[1]];
      const hit = G.hits[bi].get(e[0]);
      // a ghost on the board that none of your ghost-seeing towers can reach gets a warning
      const unseen = !!seers && !!GD.ENEMIES[type].ghost && p.x >= 0 && p.x <= GD.COLS && p.y >= 0 && p.y <= GD.ROWS &&
        !seers.some(([sx, sy, r2]) => (p.x - sx) * (p.x - sx) + (p.y - sy) * (p.y - sy) <= r2);
      R.slime(g, type, p.x * T, p.y * T, T, {
        time: t, id: e[0], hp: e[3], slowed: e[4], dx: p.dx, dy: p.dy, unseen,
        flash: hit ? Math.max(0, 1 - (t - hit) / HIT_FLASH) : 0,
        // sent slimes wear a headband: pink in your lane (from your opponent), lime in theirs (from you)
        band: e[5] ? (bi === G.you ? '#ff6fa8' : '#9be15d') : null,
      });
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
  }

  function ring(g, x, y, r, fill, stroke) {
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = fill; g.fill();
    g.strokeStyle = stroke; g.lineWidth = 1.5; g.setLineDash([6, 5]); g.stroke(); g.setLineDash([]);
  }

  function effect(g, f, t) {
    const k = (t - f.t0) / f.dur;
    if (k < 0) return; // scheduled to start later
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
  };

  function end(res, onExit) {
    G.ended = true;
    window.Sfx.play(res.won ? 'win' : 'lose');
    $('end-again').hidden = false;
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
      (res.cheated ? '<p class="muted">Admin powers were used, so this match doesn\'t count toward rating or wins.</p>'
        : res.early ? '<p class="muted">Match ended before round 5, so it counts for less and not toward your record.</p>' : '');
    $('end-back').onclick = () => { stop(); onExit(); };
  }

  function stop() { G.active = false; document.body.classList.remove('spectating'); }

  function spectateEnd(r, onExit) {
    if (!G.active) return;
    G.ended = true;
    const o = $('end-overlay');
    o.hidden = false;
    o.className = 'end draw';
    $('end-title').textContent = r.winner ? `${r.winner} won` : 'Draw';
    $('end-reason').textContent = `${(REASONS[r.reason] ? '' : '')}The match ended in round ${r.round}.`;
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
