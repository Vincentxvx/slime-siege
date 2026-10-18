// Canvas drawing: map ground, towers, slimes. All art is procedural (no image files).
(function () {
  const GD = window.GD;
  const T = 40; // pixels per tile at scale 1
  const W = GD.COLS * T, H = GD.ROWS * T;

  function rng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const groundCache = {};
  function ground(mapId) {
    if (groundCache[mapId]) return groundCache[mapId];
    const map = GD.MAPS[mapId], th = map.theme;
    const c = document.createElement('canvas');
    c.width = W * 2; c.height = H * 2;
    const g = c.getContext('2d');
    g.scale(2, 2);
    for (let x = 0; x < GD.COLS; x++) for (let y = 0; y < GD.ROWS; y++) {
      g.fillStyle = th.ground[(x + y) % 2];
      g.fillRect(x * T, y * T, T, T);
    }
    const rand = rng(mapId.length * 977);
    for (let i = 0; i < 90; i++) {
      const x = rand() * W, y = rand() * H;
      const key = Math.floor(x / T) + ',' + Math.floor(y / T);
      if (map.pathTiles.has(key)) continue;
      if (th.deco === 'grass') {
        g.strokeStyle = 'rgba(30,70,20,0.35)'; g.lineWidth = 1.5; g.lineCap = 'round';
        g.beginPath();
        g.moveTo(x, y); g.lineTo(x - 2, y - 5);
        g.moveTo(x + 3, y); g.lineTo(x + 3, y - 6);
        g.moveTo(x + 6, y); g.lineTo(x + 8, y - 4);
        g.stroke();
        if (rand() < 0.15) { g.fillStyle = rand() < 0.5 ? '#fff4a8' : '#ffc0d8'; g.beginPath(); g.arc(x + 3, y - 7, 2, 0, 7); g.fill(); }
      } else if (th.deco === 'snow') {
        if (rand() < 0.3) {
          g.fillStyle = 'rgba(0,0,0,0.12)'; g.beginPath(); g.ellipse(x, y + 2, 7, 2.5, 0, 0, 7); g.fill();
          g.fillStyle = '#4f7f6a';
          g.beginPath(); g.moveTo(x, y - 14); g.lineTo(x - 7, y); g.lineTo(x + 7, y); g.closePath(); g.fill();
          g.fillStyle = '#ffffff';
          g.beginPath(); g.moveTo(x, y - 14); g.lineTo(x - 3, y - 8); g.lineTo(x + 3, y - 8); g.closePath(); g.fill();
        } else {
          g.fillStyle = 'rgba(120,150,180,0.35)'; g.beginPath(); g.arc(x, y, 1.5 + rand() * 1.5, 0, 7); g.fill();
        }
      } else {
        g.fillStyle = 'rgba(90,50,25,0.28)';
        g.beginPath(); g.ellipse(x, y, 3 + rand() * 4, 2 + rand() * 2.5, rand() * 3, 0, 7); g.fill();
      }
    }
    // path as a thick rounded polyline
    const pts = map.path.map(([cx, cy]) => [(cx + 0.5) * T, (cy + 0.5) * T]);
    const stroke = (color, width) => {
      g.strokeStyle = color; g.lineWidth = width; g.lineJoin = 'round'; g.lineCap = 'round';
      g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
    };
    stroke(th.edge, T * 0.96);
    stroke(th.path, T * 0.8);
    g.setLineDash([3, 9]);
    stroke('rgba(0,0,0,0.08)', 3);
    g.setLineDash([]);
    // exit marker
    const [ex, ey] = pts[pts.length - 2];
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.fillRect(W - 6, ey - T * 0.4, 6, T * 0.8);
    void ex;
    groundCache[mapId] = c;
    return c;
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }

  // Draw a tower centred at (x,y) pixels. size = tile size in px.
  // Draw a tower centred at (x,y) px. size = tile size in px.
  // level 0 = base, 1-3 = upgrades bought. Each upgrade changes the look; a badge shows the level.
  function tower(g, type, level, x, y, skinId, angle, size, time, opts) {
    const skin = GD.SKINS[skinId] || GD.SKINS.skin_classic;
    const s = size / 40;
    const L = level || 0, t = time || 0;
    // Tiers: bronze (lvl 2) → silver with battlements (lvl 3) → gold, glowing (MAX). Towers also grow a little.
    const k = [0.9, 1.0, 1.06, 1.1][Math.min(3, L)];
    const tier = [skin.trim, '#c8793a', '#d6dee8', '#f0b81c'][Math.min(3, L)];
    g.save();
    g.translate(x, y); g.scale(s * k, s * k);
    g.fillStyle = 'rgba(0,0,0,0.22)';
    g.beginPath(); g.ellipse(1, 14, 16, 5, 0, 0, 7); g.fill();
    if (L >= 2) { // battlements (merlons) around the plate
      g.fillStyle = tier; g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 1;
      for (const p of [-9, 0, 9]) {
        for (const [rx, ry, rw, rh] of [[p - 2.5, -18.5, 5, 4], [p - 2.5, 14.5, 5, 4], [-18.5, p - 2.5, 4, 5], [14.5, p - 2.5, 4, 5]]) {
          g.fillRect(rx, ry, rw, rh); g.strokeRect(rx, ry, rw, rh);
        }
      }
    }
    if (skin.glow) { g.shadowColor = skin.trim; g.shadowBlur = 10; }
    if (L >= 3) { g.shadowColor = '#ffd35c'; g.shadowBlur = 10 + 4 * Math.sin(t * 3); }
    roundRect(g, -16, -16, 32, 32, 8);
    g.fillStyle = skin.base; g.fill();
    g.lineWidth = [2.5, 3.4, 3.6, 4][Math.min(3, L)]; g.strokeStyle = tier; g.stroke();
    g.shadowBlur = 0;
    if (L >= 1) { // inner ring in the tier colour
      roundRect(g, -12.5, -12.5, 25, 25, 6);
      g.lineWidth = 1.6; g.strokeStyle = tier; g.globalAlpha = 0.85; g.stroke(); g.globalAlpha = 1;
    }
    if (L >= 2) { // corner studs
      g.fillStyle = L >= 3 ? '#fff1a8' : '#ffffff';
      g.strokeStyle = 'rgba(0,0,0,0.45)'; g.lineWidth = 0.8;
      for (const [cx, cy] of [[-12, -12], [12, -12], [-12, 12], [12, 12]]) { g.beginPath(); g.arc(cx, cy, 2.3, 0, 7); g.fill(); g.stroke(); }
    }
    const a = angle || 0;
    switch (type) {
      case 'archer': {
        g.fillStyle = L >= 2 ? '#8c5a2b' : '#b57c45'; g.beginPath(); g.arc(0, 0, 10, 0, 7); g.fill();
        g.strokeStyle = L >= 3 ? '#e0a816' : '#7a4d24'; g.lineWidth = 2; g.stroke();
        g.rotate(a);
        const br = L >= 2 ? 11.5 : 10; // Quick Draw: bigger bow
        g.strokeStyle = L >= 2 ? '#2a1708' : '#3d2610'; g.lineWidth = L >= 2 ? 3.2 : 2.6;
        g.beginPath(); g.arc(-3, 0, br, -1.15, 1.15); g.stroke();
        g.strokeStyle = '#eee'; g.lineWidth = 1;
        const ex = -3 + br * Math.cos(1.15), ey = br * Math.sin(1.15);
        g.beginPath(); g.moveTo(ex, -ey); g.lineTo(ex, ey); g.stroke();
        const arrows = L >= 3 ? [-0.32, 0, 0.32] : [0]; // Eagle Eye: three arrows
        for (const off of arrows) {
          g.save(); g.rotate(off);
          g.strokeStyle = '#f5f0e0'; g.lineWidth = 2;
          g.beginPath(); g.moveTo(-1, 0); g.lineTo(13, 0); g.stroke();
          if (L >= 1) { g.fillStyle = '#c9d3df'; g.beginPath(); g.moveTo(16, 0); g.lineTo(12, -2.6); g.lineTo(12, 2.6); g.fill(); } // Sharp Arrows: metal tips
          g.restore();
        }
        if (L >= 3) { g.rotate(-a); g.fillStyle = '#e0453a'; g.beginPath(); g.moveTo(-8, -9); g.quadraticCurveTo(-14, -15, -6, -16); g.quadraticCurveTo(-7, -12, -8, -9); g.fill(); } // feather
        break;
      }
      case 'cannon': {
        const r = L >= 1 ? 12.5 : 11; // Bigger Bombs
        g.fillStyle = '#454c5c'; g.beginPath(); g.arc(0, 0, r, 0, 7); g.fill();
        if (L >= 3) { g.strokeStyle = '#e0a816'; g.lineWidth = 2; g.stroke(); }
        g.rotate(a);
        const barrel = (yOff, w) => {
          g.fillStyle = '#2a2f3a'; roundRect(g, -2, yOff - w / 2, 18, w, 3); g.fill();
          g.fillStyle = '#1a1d24'; g.fillRect(13, yOff - w / 2 - 1, 4, w + 2);
          if (L >= 3) { g.fillStyle = '#e0a816'; g.fillRect(6, yOff - w / 2, 2, w); g.fillRect(10, yOff - w / 2, 2, w); }
        };
        if (L >= 2) { barrel(-4.5, 7); barrel(4.5, 7); } // Rapid Reload: twin barrels
        else barrel(0, L >= 1 ? 11 : 10);
        g.fillStyle = '#6a7386'; g.beginPath(); g.arc(-3, -3, 3, 0, 7); g.fill();
        break;
      }
      case 'frost': {
        const r = L >= 3 ? 13.5 : 12;
        g.fillStyle = L >= 1 ? '#7fd2ff' : '#a8e6ff'; g.strokeStyle = L >= 1 ? '#2a7fb8' : '#3f9fd1'; g.lineWidth = 2;
        if (L >= 3) { g.shadowColor = '#bff0ff'; g.shadowBlur = 10; }
        g.beginPath();
        for (let i = 0; i < 6; i++) { const q = (i / 6) * Math.PI * 2 + Math.PI / 6; g.lineTo(Math.cos(q) * r, Math.sin(q) * r); }
        g.closePath(); g.fill(); g.stroke(); g.shadowBlur = 0;
        if (L >= 2) { // Frostbite: ice shards
          g.fillStyle = '#e8fbff';
          for (let i = 0; i < 6; i++) {
            const q = (i / 6) * Math.PI * 2;
            g.beginPath(); g.moveTo(Math.cos(q) * (r + 4), Math.sin(q) * (r + 4));
            g.lineTo(Math.cos(q + 0.18) * (r - 1), Math.sin(q + 0.18) * (r - 1)); g.lineTo(Math.cos(q - 0.18) * (r - 1), Math.sin(q - 0.18) * (r - 1)); g.fill();
          }
        }
        g.strokeStyle = '#ffffff'; g.lineWidth = 1.6;
        for (let i = 0; i < 3; i++) { const q = (i / 3) * Math.PI + t * 0.6; g.beginPath(); g.moveTo(Math.cos(q) * 8, Math.sin(q) * 8); g.lineTo(-Math.cos(q) * 8, -Math.sin(q) * 8); g.stroke(); }
        break;
      }
      case 'sniper': {
        g.fillStyle = L >= 3 ? '#4a5530' : '#66753f'; g.beginPath(); g.arc(0, 0, 9, 0, 7); g.fill();
        g.strokeStyle = L >= 3 ? '#e0a816' : '#3e4825'; g.lineWidth = 2; g.stroke();
        g.rotate(a);
        const len = L >= 1 ? 24 : 21; // Hollow Points: longer barrel
        g.fillStyle = L >= 3 ? '#8a6410' : '#262b19'; g.fillRect(-2, -2.5, len, 5);
        g.fillStyle = '#111'; g.fillRect(len - 4, -3.2, 3, 6.4); // muzzle
        g.fillStyle = '#111'; g.fillRect(2, L >= 2 ? -7.5 : -6.5, L >= 2 ? 11 : 8, L >= 2 ? 5 : 4); // Bolt Action: bigger scope
        g.fillStyle = '#7fd3ff'; g.fillRect(L >= 2 ? 12 : 9, L >= 2 ? -7 : -6, 1.5, L >= 2 ? 4 : 3);
        if (L >= 3) { g.strokeStyle = 'rgba(255,60,60,0.55)'; g.lineWidth = 1; g.beginPath(); g.moveTo(len, 0); g.lineTo(len + 14, 0); g.stroke(); } // laser
        break;
      }
      case 'tesla': {
        g.fillStyle = L >= 3 ? '#3b3260' : '#4a4f66'; g.beginPath(); g.arc(0, 0, 11, 0, 7); g.fill();
        g.strokeStyle = L >= 3 ? '#e0a816' : '#c99a3a'; g.lineWidth = 2;
        const rings = L >= 1 ? [9.5, 7.5, 5.5] : [8.5, 6]; // Arc Coil: extra ring
        for (const r of rings) { g.beginPath(); g.arc(0, 0, r, 0, 7); g.stroke(); }
        const p = 0.7 + 0.3 * Math.sin(t * 9);
        const orb = L >= 2 ? 5.4 : 4.2; // Overcharge: bigger orb
        g.shadowColor = L >= 3 ? '#c9a7ff' : '#ffe766'; g.shadowBlur = (L >= 2 ? 16 : 10) * p;
        g.fillStyle = L >= 3 ? '#f1e6ff' : '#fff3a0'; g.beginPath(); g.arc(0, 0, orb, 0, 7); g.fill();
        g.shadowBlur = 0;
        if (L >= 3) { // Storm Core: crackling arcs
          g.strokeStyle = `rgba(220,200,255,${0.5 + 0.4 * p})`; g.lineWidth = 1.2;
          for (let i = 0; i < 3; i++) {
            const q = t * 4 + i * 2.1;
            g.beginPath(); g.moveTo(Math.cos(q) * 6, Math.sin(q) * 6);
            g.lineTo(Math.cos(q + 0.3) * 10, Math.sin(q + 0.3) * 10 + 1.5); g.lineTo(Math.cos(q + 0.5) * 14, Math.sin(q + 0.5) * 14);
            g.stroke();
          }
        }
        break;
      }
      case 'mine': {
        g.fillStyle = L >= 2 ? '#6b4526' : '#7d5532'; roundRect(g, -12, -10, 24, 20, 4); g.fill();
        if (L >= 1) { g.strokeStyle = '#4a2e15'; g.lineWidth = 1.5; for (const yy of [-4, 2]) { g.beginPath(); g.moveTo(-12, yy); g.lineTo(-7, yy); g.moveTo(7, yy); g.lineTo(12, yy); g.stroke(); } } // support beams
        g.fillStyle = '#2b1a0e'; g.beginPath(); g.moveTo(-7, 10); g.lineTo(-7, 0); g.arc(0, 0, 7, Math.PI, 0); g.lineTo(7, 10); g.fill();
        g.fillStyle = '#ffd34d';
        const nuggets = [[-3, 6, 2.6], [3, 7, 2.2], [0, 3, 2]];
        if (L >= 2) nuggets.push([-5, 8.5, 1.8], [5, 4, 1.8], [1, 8.5, 2]);
        for (const [px, py, pr] of nuggets) { g.beginPath(); g.arc(px, py, pr, 0, 7); g.fill(); }
        g.strokeStyle = '#d9d2c5'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(5, -14); g.lineTo(13, -6); g.stroke();
        if (L >= 3) { // Mother Lode: sparkles + gold sign
          g.fillStyle = '#ffd35c'; roundRect(g, -10, -15, 11, 6, 2); g.fill();
          for (let i = 0; i < 3; i++) {
            const k = (t * 1.5 + i / 3) % 1, sx = -8 + i * 8, sy = 6 - k * 14;
            g.globalAlpha = 1 - k; g.fillStyle = '#fff7c2';
            g.beginPath(); g.moveTo(sx, sy - 2.5); g.lineTo(sx + 1, sy); g.lineTo(sx, sy + 2.5); g.lineTo(sx - 1, sy); g.closePath(); g.fill();
          }
          g.globalAlpha = 1;
        }
        break;
      }
    }
    g.restore();
    // level badge (bottom-right corner)
    if (!(opts && opts.noBadge)) {
      g.save(); g.translate(x, y); g.scale(s, s);
      const max = L >= 3, label = max ? 'MAX' : String(L + 1);
      const w = max ? 19 : 10;
      roundRect(g, 15 - w, 9, w, 9, 3);
      g.fillStyle = max ? '#ffd35c' : L >= 1 ? '#9be15d' : '#efe7ff';
      g.fill(); g.strokeStyle = '#1e1530'; g.lineWidth = 1.2; g.stroke();
      g.fillStyle = '#1e1530'; g.font = 'bold 7px Lexend, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(label, 15 - w / 2, 13.8);
      g.restore();
    }
  }

  // Draw a slime centred at (x,y) px.
  // opts.flash (0-1): just took damage, so it squishes and flashes white
  // opts.band (colour): sent by a player, so it wears a headband in that colour
  function slime(g, type, x, y, size, opts) {
    opts = opts || {};
    const E = GD.ENEMIES[type];
    const r = E.r * size;
    const t = opts.time || 0, id = opts.id || 0, flash = opts.flash || 0;
    const wob = Math.sin(t * 9 + id * 1.7) * 0.09 + flash * 0.14;
    const rx = r * (1 + wob), ry = r * (1 - wob);
    g.save();
    g.translate(x, y + r * 0.1);
    if (E.ghost) g.globalAlpha = 0.55;
    g.fillStyle = 'rgba(0,0,0,0.22)';
    g.beginPath(); g.ellipse(0, ry * 0.85, rx * 0.95, ry * 0.3, 0, 0, 7); g.fill();
    // body: flat-bottomed dome
    const body = () => {
      g.beginPath();
      g.moveTo(-rx, ry * 0.7);
      g.bezierCurveTo(-rx * 1.05, -ry * 0.9, rx * 1.05, -ry * 0.9, rx, ry * 0.7);
      g.quadraticCurveTo(0, ry * 1.05, -rx, ry * 0.7);
    };
    body();
    const grad = g.createRadialGradient(-rx * 0.35, -ry * 0.35, r * 0.1, 0, 0, r * 1.3);
    grad.addColorStop(0, lighten(E.color, 0.45));
    grad.addColorStop(0.55, E.color);
    grad.addColorStop(1, darken(E.color, 0.35));
    g.fillStyle = grad; g.fill();
    g.lineWidth = Math.max(1, size / 30); g.strokeStyle = darken(E.color, 0.55); g.stroke();
    if (flash > 0) { g.fillStyle = `rgba(255,255,255,${0.75 * flash})`; g.fill(); }
    if (type === 'armored') {
      g.fillStyle = '#5b6472';
      g.beginPath(); g.moveTo(-rx * 0.95, -ry * 0.05);
      g.bezierCurveTo(-rx * 0.9, -ry * 0.95, rx * 0.9, -ry * 0.95, rx * 0.95, -ry * 0.05);
      g.closePath(); g.fill();
      g.fillStyle = '#c9d0db';
      for (const px of [-0.5, 0, 0.5]) { g.beginPath(); g.arc(px * rx, -ry * 0.15, r * 0.07, 0, 7); g.fill(); }
    }
    if (type === 'king') {
      g.fillStyle = '#ffd35c'; g.strokeStyle = '#8a6410'; g.lineWidth = 1.5;
      const cy = -ry * 0.62, cw = rx * 0.75;
      g.beginPath(); g.moveTo(-cw, cy); g.lineTo(-cw, cy - r * 0.35); g.lineTo(-cw * 0.5, cy - r * 0.18);
      g.lineTo(0, cy - r * 0.45); g.lineTo(cw * 0.5, cy - r * 0.18); g.lineTo(cw, cy - r * 0.35); g.lineTo(cw, cy); g.closePath();
      g.fill(); g.stroke();
    }
    if (opts.band) { // headband behind the eyes, knot tails trailing behind
      const top = -ry * 0.36, bot = ry * 0.06, line = Math.max(1, size / 32);
      g.save(); body(); g.clip();
      g.fillStyle = opts.band; g.fillRect(-rx * 1.2, top, rx * 2.4, bot - top);
      g.strokeStyle = '#1e1530'; g.lineWidth = line;
      g.beginPath(); g.moveTo(-rx * 1.2, top); g.lineTo(rx * 1.2, top); g.moveTo(-rx * 1.2, bot); g.lineTo(rx * 1.2, bot); g.stroke();
      g.restore();
      const side = (opts.dx || 0) > 0.1 ? -1 : 1, kx = side * rx * 0.86, ky = (top + bot) / 2;
      g.fillStyle = opts.band; g.strokeStyle = '#1e1530'; g.lineWidth = line;
      for (const [tx, ty] of [[0.62, -0.26], [0.55, 0.3]]) {
        g.beginPath(); g.moveTo(kx, ky - r * 0.1);
        g.lineTo(kx + side * r * tx, ky + r * (ty - 0.12)); g.lineTo(kx + side * r * tx * 0.85, ky + r * (ty + 0.12));
        g.lineTo(kx, ky + r * 0.1); g.closePath(); g.fill(); g.stroke();
      }
    }
    // eyes, looking along the path
    const lx = (opts.dx || 1) * r * 0.06, ly = (opts.dy || 0) * r * 0.06;
    const ey = type === 'armored' ? ry * 0.12 : -ry * 0.08;
    for (const sx of [-1, 1]) {
      g.fillStyle = '#fff'; g.beginPath(); g.ellipse(sx * rx * 0.33, ey, r * 0.19, r * 0.22, 0, 0, 7); g.fill();
      g.fillStyle = '#1a1226'; g.beginPath(); g.arc(sx * rx * 0.33 + lx, ey + ly + r * 0.03, r * 0.1, 0, 7); g.fill();
    }
    if (opts.slowed) {
      g.globalAlpha = 0.85;
      g.strokeStyle = '#d4f4ff'; g.lineWidth = Math.max(1.2, size / 22);
      g.beginPath(); g.ellipse(0, ry * 0.2, rx * 1.15, ry * 0.95, 0, 0, 7); g.stroke();
    }
    g.restore();
    if (opts.hp != null && opts.hp < 100 && E.hpTotal >= 8) {
      const w = r * 1.8;
      g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(x - w / 2, y - r * 1.25, w, 3.5);
      g.fillStyle = opts.hp > 50 ? '#9be15d' : opts.hp > 25 ? '#ffd35c' : '#ff5c5c';
      g.fillRect(x - w / 2, y - r * 1.25, (w * opts.hp) / 100, 3.5);
    }
  }

  function hex(c) { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function mix(c, t, k) { const a = hex(c); return `rgb(${a.map((v) => Math.round(v + (t - v) * k)).join(',')})`; }
  function lighten(c, k) { return mix(c, 255, k); }
  function darken(c, k) { return mix(c, 0, k); }

  // Small standalone icon canvases for UI
  function towerIcon(type, skin, px) {
    const c = document.createElement('canvas');
    const dpr = window.devicePixelRatio || 1;
    c.width = c.height = px * dpr; c.style.width = c.style.height = px + 'px';
    const g = c.getContext('2d'); g.scale(dpr, dpr);
    tower(g, type, 0, px / 2, px / 2 - 1, skin, -0.6, px * 0.82, 0, { noBadge: true });
    return c;
  }
  function slimeIcon(type, px) {
    const c = document.createElement('canvas');
    const dpr = window.devicePixelRatio || 1;
    c.width = c.height = px * dpr; c.style.width = c.style.height = px + 'px';
    const g = c.getContext('2d'); g.scale(dpr, dpr);
    const scale = Math.min(px * 1.15, px * 0.42 / GD.ENEMIES[type].r);
    slime(g, type, px / 2, px / 2, scale, { id: 3 });
    return c;
  }

  window.Render = { T, W, H, ground, tower, slime, towerIcon, slimeIcon, roundRect, lighten, darken };
})();
