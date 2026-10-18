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
  function tower(g, type, level, x, y, skinId, angle, size, time) {
    const skin = GD.SKINS[skinId] || GD.SKINS.skin_classic;
    const s = size / 40;
    g.save();
    g.translate(x, y); g.scale(s, s);
    g.fillStyle = 'rgba(0,0,0,0.22)';
    g.beginPath(); g.ellipse(1, 14, 16, 5, 0, 0, 7); g.fill();
    if (skin.glow) { g.shadowColor = skin.trim; g.shadowBlur = 10; }
    roundRect(g, -16, -16, 32, 32, 8);
    g.fillStyle = skin.base; g.fill();
    g.lineWidth = 2.5; g.strokeStyle = skin.trim; g.stroke();
    g.shadowBlur = 0;
    const a = angle || 0;
    switch (type) {
      case 'archer':
        g.fillStyle = '#b57c45'; g.beginPath(); g.arc(0, 0, 10, 0, 7); g.fill();
        g.strokeStyle = '#7a4d24'; g.lineWidth = 2; g.stroke();
        g.rotate(a);
        g.strokeStyle = '#3d2610'; g.lineWidth = 2.6;
        g.beginPath(); g.arc(-3, 0, 10, -1.15, 1.15); g.stroke();
        g.strokeStyle = '#eee'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(-3 + 10 * Math.cos(1.15), -10 * Math.sin(1.15)); g.lineTo(-3 + 10 * Math.cos(1.15), 10 * Math.sin(1.15)); g.stroke();
        g.strokeStyle = '#f5f0e0'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(-1, 0); g.lineTo(13, 0); g.stroke();
        break;
      case 'cannon':
        g.fillStyle = '#454c5c'; g.beginPath(); g.arc(0, 0, 11, 0, 7); g.fill();
        g.rotate(a);
        g.fillStyle = '#2a2f3a'; roundRect(g, -2, -5, 18, 10, 3); g.fill();
        g.fillStyle = '#1a1d24'; g.fillRect(13, -6, 4, 12);
        g.fillStyle = '#6a7386'; g.beginPath(); g.arc(-3, -3, 3, 0, 7); g.fill();
        break;
      case 'frost': {
        g.fillStyle = '#a8e6ff'; g.strokeStyle = '#3f9fd1'; g.lineWidth = 2;
        g.beginPath();
        for (let i = 0; i < 6; i++) { const t = (i / 6) * Math.PI * 2 + Math.PI / 6; g.lineTo(Math.cos(t) * 12, Math.sin(t) * 12); }
        g.closePath(); g.fill(); g.stroke();
        g.strokeStyle = '#ffffff'; g.lineWidth = 1.6;
        for (let i = 0; i < 3; i++) { const t = (i / 3) * Math.PI + (time || 0) * 0.6; g.beginPath(); g.moveTo(Math.cos(t) * 8, Math.sin(t) * 8); g.lineTo(-Math.cos(t) * 8, -Math.sin(t) * 8); g.stroke(); }
        break;
      }
      case 'sniper':
        g.fillStyle = '#66753f'; g.beginPath(); g.arc(0, 0, 9, 0, 7); g.fill();
        g.strokeStyle = '#3e4825'; g.lineWidth = 2; g.stroke();
        g.rotate(a);
        g.fillStyle = '#262b19'; g.fillRect(-2, -2.5, 21, 5);
        g.fillStyle = '#111'; g.fillRect(2, -6.5, 8, 4);
        g.fillStyle = '#7fd3ff'; g.fillRect(9, -6, 1.5, 3);
        break;
      case 'tesla': {
        g.fillStyle = '#4a4f66'; g.beginPath(); g.arc(0, 0, 11, 0, 7); g.fill();
        g.strokeStyle = '#c99a3a'; g.lineWidth = 2;
        for (const r of [8.5, 6]) { g.beginPath(); g.arc(0, 0, r, 0, 7); g.stroke(); }
        const p = 0.7 + 0.3 * Math.sin((time || 0) * 9);
        g.shadowColor = '#ffe766'; g.shadowBlur = 10 * p;
        g.fillStyle = '#fff3a0'; g.beginPath(); g.arc(0, 0, 4.2, 0, 7); g.fill();
        g.shadowBlur = 0;
        break;
      }
      case 'mine':
        g.fillStyle = '#7d5532'; roundRect(g, -12, -10, 24, 20, 4); g.fill();
        g.fillStyle = '#2b1a0e'; g.beginPath(); g.moveTo(-7, 10); g.lineTo(-7, 0); g.arc(0, 0, 7, Math.PI, 0); g.lineTo(7, 10); g.fill();
        g.fillStyle = '#ffd34d';
        for (const [px, py, pr] of [[-3, 6, 2.6], [3, 7, 2.2], [0, 3, 2]]) { g.beginPath(); g.arc(px, py, pr, 0, 7); g.fill(); }
        g.strokeStyle = '#d9d2c5'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(5, -14); g.lineTo(13, -6); g.stroke();
        break;
    }
    g.restore();
    if (level > 0) {
      g.save(); g.translate(x, y); g.scale(s, s);
      for (let i = 0; i < level; i++) {
        g.fillStyle = '#ffd35c'; g.strokeStyle = '#2b1d00'; g.lineWidth = 1;
        g.beginPath(); g.arc(-8 + i * 8, 15, 3, 0, 7); g.fill(); g.stroke();
      }
      g.restore();
    }
  }

  // Draw a slime centred at (x,y) px.
  function slime(g, type, x, y, size, opts) {
    opts = opts || {};
    const E = GD.ENEMIES[type];
    const r = E.r * size;
    const t = opts.time || 0, id = opts.id || 0;
    const wob = Math.sin(t * 9 + id * 1.7) * 0.09;
    const rx = r * (1 + wob), ry = r * (1 - wob);
    g.save();
    g.translate(x, y + r * 0.1);
    if (E.ghost) g.globalAlpha = 0.55;
    g.fillStyle = 'rgba(0,0,0,0.22)';
    g.beginPath(); g.ellipse(0, ry * 0.85, rx * 0.95, ry * 0.3, 0, 0, 7); g.fill();
    // body: flat-bottomed dome
    g.beginPath();
    g.moveTo(-rx, ry * 0.7);
    g.bezierCurveTo(-rx * 1.05, -ry * 0.9, rx * 1.05, -ry * 0.9, rx, ry * 0.7);
    g.quadraticCurveTo(0, ry * 1.05, -rx, ry * 0.7);
    const grad = g.createRadialGradient(-rx * 0.35, -ry * 0.35, r * 0.1, 0, 0, r * 1.3);
    grad.addColorStop(0, lighten(E.color, 0.45));
    grad.addColorStop(0.55, E.color);
    grad.addColorStop(1, darken(E.color, 0.35));
    g.fillStyle = grad; g.fill();
    g.lineWidth = Math.max(1, size / 30); g.strokeStyle = darken(E.color, 0.55); g.stroke();
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
    tower(g, type, 0, px / 2, px / 2 - 1, skin, -0.6, px * 0.82, 0);
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
