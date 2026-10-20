// Canvas drawing: map ground, towers, slimes. All art is procedural (no image files).
(function () {
  const GD = window.GD;
  const T = 40; // pixels per tile at scale 1
  const W = GD.COLS * T, H = GD.ROWS * T;
  // players who ask their system for less motion get no squish, drop/pop or marching dashes
  const REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

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
    // keep only the current test field's ground (a big one is ~20 MB, and every size is a new map)
    if (mapId.startsWith('sandbox:')) for (const k in groundCache) if (k.startsWith('sandbox:')) delete groundCache[k];
    const map = GD.MAPS[mapId], th = map.theme;
    // the test field can be any size; every other map is COLS × ROWS
    const cols = map.cols || GD.COLS, rows = map.rows || GD.ROWS, W = cols * T, H = rows * T;
    const c = document.createElement('canvas');
    c.width = W * 2; c.height = H * 2;
    const g = c.getContext('2d');
    g.scale(2, 2);
    for (let x = 0; x < cols; x++) for (let y = 0; y < rows; y++) {
      g.fillStyle = th.ground[(x + y) % 2];
      g.fillRect(x * T, y * T, T, T);
    }
    const rand = rng(mapId.length * 977);
    const decos = Math.round((90 * cols * rows) / (GD.COLS * GD.ROWS)); // same density on any size
    for (let i = 0; i < decos; i++) {
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
    // path as a thick rounded polyline (the test field has none)
    const pts = map.path.map(([cx, cy]) => [(cx + 0.5) * T, (cy + 0.5) * T]);
    if (pts.length < 2) { groundCache[mapId] = c; return c; }
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
  // opts.path 'b': the tower took upgrade path B at its fork (Archer, Cannon, Frost, Sniper), which looks different from level 3
  function tower(g, type, level, x, y, skinId, angle, size, time, opts) {
    const skin = GD.SKINS[skinId] || GD.SKINS.skin_classic;
    const s = size / 40;
    const L = level || 0, t = time || 0;
    const B = !!(opts && opts.path === 'b') && L >= 2;
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
        // Quick Draw: bigger bow; path B Longbow: a long one
        const br = B ? (L >= 3 ? 14 : 10.5) : L >= 2 ? 11.5 : 10;
        g.strokeStyle = L >= 2 ? '#2a1708' : '#3d2610'; g.lineWidth = L >= 2 ? 3.2 : 2.6;
        g.beginPath(); g.arc(-3, 0, br, -1.15, 1.15); g.stroke();
        g.strokeStyle = '#eee'; g.lineWidth = 1;
        const ex = -3 + br * Math.cos(1.15), ey = br * Math.sin(1.15);
        g.beginPath(); g.moveTo(ex, -ey); g.lineTo(ex, ey); g.stroke();
        const arrows = L >= 3 && !B ? [-0.32, 0, 0.32] : [0]; // Eagle Eye: three arrows
        for (const off of arrows) {
          g.save(); g.rotate(off);
          g.strokeStyle = '#f5f0e0'; g.lineWidth = B ? 2.6 : 2;
          const tip = B && L >= 3 ? 16 : 13;
          g.beginPath(); g.moveTo(-1, 0); g.lineTo(tip, 0); g.stroke();
          if (B) { g.fillStyle = '#3a3f4a'; g.beginPath(); g.moveTo(tip + 4.5, 0); g.lineTo(tip - 1, -3.6); g.lineTo(tip - 1, 3.6); g.fill(); } // Bodkin Points: heavy dark heads
          else if (L >= 1) { g.fillStyle = '#c9d3df'; g.beginPath(); g.moveTo(16, 0); g.lineTo(12, -2.6); g.lineTo(12, 2.6); g.fill(); } // Sharp Arrows: metal tips
          g.restore();
        }
        if (L >= 3) { g.rotate(-a); g.fillStyle = B ? '#3f9fd1' : '#e0453a'; g.beginPath(); g.moveTo(-8, -9); g.quadraticCurveTo(-14, -15, -6, -16); g.quadraticCurveTo(-7, -12, -8, -9); g.fill(); } // feather
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
        if (B) { // path B: one wide barrel with blue concussion bands
          barrel(0, 13);
          g.fillStyle = '#5ab0ff'; g.fillRect(4, -6.5, 2, 13); g.fillRect(8.5, -6.5, 2, 13);
        } else if (L >= 2) { barrel(-4.5, 7); barrel(4.5, 7); } // Rapid Reload: twin barrels
        else barrel(0, L >= 1 ? 11 : 10);
        g.fillStyle = '#6a7386'; g.beginPath(); g.arc(-3, -3, 3, 0, 7); g.fill();
        if (B && L >= 3) { // Cluster Bombs: little bombs ready on the turret
          g.rotate(-a);
          for (const [bx, by] of [[-9, 9], [0, 11], [9, 9]]) {
            g.fillStyle = '#1a1d24'; g.beginPath(); g.arc(bx, by, 3.2, 0, 7); g.fill();
            g.fillStyle = '#ffd35c'; g.fillRect(bx - 0.6, by - 4.6, 1.2, 1.8);
          }
        }
        break;
      }
      case 'frost': {
        const r = L >= 3 ? 13.5 : 12;
        // path B (Brittle Ice → Shatter): violet, cracked ice
        g.fillStyle = B ? '#c7b8ff' : L >= 1 ? '#7fd2ff' : '#a8e6ff'; g.strokeStyle = B ? '#6a4fc0' : L >= 1 ? '#2a7fb8' : '#3f9fd1'; g.lineWidth = 2;
        if (L >= 3) { g.shadowColor = B ? '#e0d4ff' : '#bff0ff'; g.shadowBlur = 10; }
        g.beginPath();
        for (let i = 0; i < 6; i++) { const q = (i / 6) * Math.PI * 2 + Math.PI / 6; g.lineTo(Math.cos(q) * r, Math.sin(q) * r); }
        g.closePath(); g.fill(); g.stroke(); g.shadowBlur = 0;
        if (B) { // Brittle Ice: cracks; Shatter: loose shards around it
          g.strokeStyle = '#4b2f9e'; g.lineWidth = 1.2;
          for (const [x1, y1, x2, y2, x3, y3] of [[-r + 2, -3, -4, -1, -1, -6], [r - 3, 4, 3, 2, 1, 7], [-2, r - 2, 0, 3, 5, 5]]) {
            g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.lineTo(x3, y3); g.stroke();
          }
          if (L >= 3) {
            g.fillStyle = '#efe8ff';
            for (let i = 0; i < 5; i++) {
              const q = (i / 5) * Math.PI * 2 + t * 0.8, d = r + 4;
              g.beginPath(); g.moveTo(Math.cos(q) * (d + 3), Math.sin(q) * (d + 3)); g.lineTo(Math.cos(q + 0.12) * d, Math.sin(q + 0.12) * d); g.lineTo(Math.cos(q - 0.12) * d, Math.sin(q - 0.12) * d); g.fill();
            }
          }
        } else if (L >= 2) { // Frostbite: ice shards
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
        if (B) { // path B: Semi-Auto magazine, Twin Scopes a second scope
          g.fillStyle = '#1c2012'; g.fillRect(5, 2, 4, 6.5);
          g.fillStyle = '#111'; g.fillRect(2, -6.5, 8, 4); g.fillStyle = '#7fd3ff'; g.fillRect(9, -6, 1.5, 3);
          if (L >= 3) { g.fillStyle = '#111'; g.fillRect(11, -6.5, 7, 4); g.fillStyle = '#ff9a7f'; g.fillRect(17, -6, 1.5, 3); }
        } else {
          g.fillStyle = '#111'; g.fillRect(2, L >= 2 ? -7.5 : -6.5, L >= 2 ? 11 : 8, L >= 2 ? 5 : 4); // Bolt Action: bigger scope
          g.fillStyle = '#7fd3ff'; g.fillRect(L >= 2 ? 12 : 9, L >= 2 ? -7 : -6, 1.5, L >= 2 ? 4 : 3);
        }
        if (L >= 3 && !B) { g.strokeStyle = 'rgba(255,60,60,0.55)'; g.lineWidth = 1; g.beginPath(); g.moveTo(len, 0); g.lineTo(len + 14, 0); g.stroke(); } // laser
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
      case 'lantern': { // iron post and a glass lantern with a flickering flame
        const fl = 0.85 + 0.12 * Math.sin(t * 11) + 0.05 * Math.sin(t * 23 + 1);
        if (L >= 3) { // Lighthouse: a slowly sweeping beam
          g.save(); g.rotate(t * 1.2); g.fillStyle = 'rgba(255,236,170,0.22)';
          g.beginPath(); g.moveTo(0, -5); g.lineTo(20, -10); g.lineTo(20, 0); g.closePath(); g.fill(); g.restore();
        }
        const glowR = (L >= 1 ? 14 : 11) * fl;
        const glow = g.createRadialGradient(0, -5, 1, 0, -5, glowR);
        glow.addColorStop(0, 'rgba(255,220,120,0.8)'); glow.addColorStop(1, 'rgba(255,200,80,0)');
        g.fillStyle = glow; g.beginPath(); g.arc(0, -5, glowR, 0, 7); g.fill();
        g.fillStyle = '#2b2a38'; g.fillRect(-1.8, 1, 3.6, 10); roundRect(g, -7, 10, 14, 3.5, 1.5); g.fill(); // post and foot
        if (L >= 3) { g.fillStyle = '#e0453a'; g.fillRect(-1.8, 3, 3.6, 2.4); g.fillRect(-1.8, 7.5, 3.6, 2.4); } // red stripes
        g.fillStyle = 'rgba(255,236,170,0.55)'; g.strokeStyle = '#1f1d2a'; g.lineWidth = 1.6;
        roundRect(g, -5.5, -10, 11, 11.5, 2.5); g.fill(); g.stroke();
        g.fillStyle = L >= 3 ? '#e0453a' : '#1f1d2a'; roundRect(g, -7, -13.5, 14, 4, 1.8); g.fill(); // cap
        g.fillStyle = '#ffb02e'; g.beginPath(); g.moveTo(0, -8.5 - 1.5 * fl); g.quadraticCurveTo(3.4, -3, 0, -1.2); g.quadraticCurveTo(-3.4, -3, 0, -8.5 - 1.5 * fl); g.fill();
        g.fillStyle = '#fff3b8'; g.beginPath(); g.ellipse(0, -3.4, 1.3, 2.2, 0, 0, 7); g.fill();
        if (L >= 2) { g.strokeStyle = '#d6dee8'; g.lineWidth = 1.4; g.beginPath(); g.arc(0, -4.5, 8, 0, 7); g.stroke(); } // lens ring
        break;
      }
      case 'hex': { // carved stone totem with glowing eyes; runes circle it
        const glow = 0.6 + 0.4 * Math.sin(t * 4);
        if (L >= 3) { g.fillStyle = `rgba(190,90,255,${0.18 + 0.12 * glow})`; g.beginPath(); g.arc(0, 0, 15, 0, 7); g.fill(); } // aura
        if (L >= 2) { // two small side idols
          g.fillStyle = '#4b3766'; g.strokeStyle = '#1b1226'; g.lineWidth = 1.2;
          for (const sx of [-11.5, 11.5]) { roundRect(g, sx - 3, -3, 6, 13, 2); g.fill(); g.stroke(); g.fillStyle = '#ff6fe0'; g.fillRect(sx - 1, 0, 2, 2); g.fillStyle = '#4b3766'; }
        }
        g.fillStyle = '#3a2a4f'; g.strokeStyle = '#1b1226'; g.lineWidth = 1.8;
        roundRect(g, -8, -13, 16, 25, 4); g.fill(); g.stroke();
        g.fillStyle = '#54407a'; g.fillRect(-8, -1, 16, 2.5); g.fillRect(-8, 7, 16, 1.6); // carved bands
        g.shadowColor = '#ff4fd8'; g.shadowBlur = 6 + 6 * glow; g.fillStyle = '#ff6fe0';
        const er = L >= 1 ? 2.6 : 2;
        for (const ex of [-3.5, 3.5]) { g.beginPath(); g.arc(ex, -6.5, er, 0, 7); g.fill(); }
        g.shadowBlur = 0;
        g.strokeStyle = '#ff6fe0'; g.lineWidth = 1.2;
        g.beginPath(); g.moveTo(-4, 4); g.lineTo(-2, 5.8); g.lineTo(0, 4); g.lineTo(2, 5.8); g.lineTo(4, 4); g.stroke(); // jagged mouth
        if (L >= 3) { // gold horns
          g.fillStyle = '#f0b81c'; g.strokeStyle = '#8a6410'; g.lineWidth = 1;
          for (const sx of [-1, 1]) { g.beginPath(); g.moveTo(sx * 4, -12); g.quadraticCurveTo(sx * 12, -14, sx * 10, -19); g.quadraticCurveTo(sx * 8, -15, sx * 1.5, -12.5); g.closePath(); g.fill(); g.stroke(); }
        }
        g.save(); g.rotate(t * 0.8); g.fillStyle = 'rgba(214,140,255,0.85)'; // turning rune ring
        for (let i = 0; i < 6; i++) { const q = (i * Math.PI) / 3; g.fillRect(Math.cos(q) * 14.5 - 1.2, Math.sin(q) * 14.5 - 1.2, 2.4, 2.4); }
        g.restore();
        break;
      }
      case 'bramble': { // spiky bush; vine whips turn toward the target
        g.fillStyle = '#2f6b2a'; g.strokeStyle = '#163a14'; g.lineWidth = 1.4;
        g.beginPath();
        for (let i = 0; i < 14; i++) { const q = (i / 14) * Math.PI * 2, rr = i % 2 ? 7 : 12.5; g.lineTo(Math.cos(q) * rr, Math.sin(q) * rr); }
        g.closePath(); g.fill(); g.stroke();
        g.fillStyle = '#3f8a36'; g.beginPath(); g.arc(0, 0, 6, 0, 7); g.fill();
        if (L >= 1) { g.fillStyle = '#d23b3b'; for (let i = 0; i < 14; i += 2) { const q = (i / 14) * Math.PI * 2; g.beginPath(); g.arc(Math.cos(q) * 12.5, Math.sin(q) * 12.5, 1.4, 0, 7); g.fill(); } }
        const whips = L >= 3 ? 3 : L >= 2 ? 2 : 1;
        g.save(); g.rotate(a); g.strokeStyle = '#5aa845'; g.lineWidth = 2.4; g.lineCap = 'round';
        for (let w = 0; w < whips; w++) {
          g.save(); g.rotate((w - (whips - 1) / 2) * 0.5);
          g.beginPath(); g.moveTo(0, 0); g.bezierCurveTo(6, -5 + Math.sin(t * 6 + w) * 1.5, 10, 5, 16, 0); g.stroke();
          g.restore();
        }
        g.restore();
        if (L >= 3) { g.fillStyle = '#ff8fc8'; for (let i = 0; i < 5; i++) { const q = (i / 5) * Math.PI * 2; g.beginPath(); g.arc(Math.cos(q) * 2.6, Math.sin(q) * 2.6, 2, 0, 7); g.fill(); } g.fillStyle = '#ffd35c'; g.beginPath(); g.arc(0, 0, 1.6, 0, 7); g.fill(); }
        break;
      }
      case 'hatchery': { // straw nest with speckled eggs that wobble
        if (L >= 1) { // warm steam wisps
          g.strokeStyle = 'rgba(255,255,255,0.45)'; g.lineWidth = 1.3;
          for (let i = 0; i < 2; i++) { const q = (t * 0.6 + i / 2) % 1; g.globalAlpha = 1 - q; g.beginPath(); g.moveTo(-3 + i * 6, -6 - q * 8); g.quadraticCurveTo(-1 + i * 6, -9 - q * 8, -3 + i * 6, -12 - q * 8); g.stroke(); }
          g.globalAlpha = 1;
        }
        g.fillStyle = '#b8893f'; g.strokeStyle = '#6e4c1c'; g.lineWidth = 1.6;
        g.beginPath(); g.ellipse(0, 5, 13.5, 7.5, 0, 0, 7); g.fill(); g.stroke();
        g.strokeStyle = 'rgba(110,76,28,0.6)'; g.lineWidth = 1;
        for (let i = -2; i <= 2; i++) { g.beginPath(); g.arc(i * 5, 5, 6, 0.3, 2.8); g.stroke(); }
        const eggs = L >= 2 ? [[-6.5, 1, '#9be15d'], [0, -1, '#ff6fa8'], [6.5, 1, '#e8e2ff'], [-3.2, 4, '#ffd35c'], [3.2, 4, '#7fd2ff']]
          : L >= 1 ? [[-5.5, 1, '#9be15d'], [0, -1, '#ff6fa8'], [5.5, 1, '#e8e2ff']] : [[-3.5, 0, '#9be15d'], [3.5, 0, '#ff6fa8']];
        if (L >= 3) eggs.splice(1, 1, [0, -2, '#f0b81c']);
        eggs.forEach(([ex, ey, col], i) => {
          g.save(); g.translate(ex, ey); g.rotate(Math.sin(t * 3 + i * 1.7) * 0.15);
          g.fillStyle = col; g.strokeStyle = '#2b1d3a'; g.lineWidth = 1.1;
          g.beginPath(); g.ellipse(0, 0, 3.4, 4.4, 0, 0, 7); g.fill(); g.stroke();
          g.fillStyle = 'rgba(0,0,0,0.2)'; g.beginPath(); g.arc(-1, -1, 0.7, 0, 7); g.arc(1.2, 1, 0.6, 0, 7); g.fill();
          if (col === '#f0b81c') { g.fillStyle = '#ffd35c'; g.strokeStyle = '#8a6410'; g.beginPath(); g.moveTo(-2.5, -4); g.lineTo(-2.5, -6.5); g.lineTo(-1, -5.2); g.lineTo(0, -7); g.lineTo(1, -5.2); g.lineTo(2.5, -6.5); g.lineTo(2.5, -4); g.closePath(); g.fill(); g.stroke(); }
          g.restore();
        });
        break;
      }
      case 'basilisk': { // stone pedestal with a big reptile eye that follows the target
        if (L >= 2) { g.fillStyle = '#6b6e78'; for (const sx of [-8, 0, 8]) { g.beginPath(); g.moveTo(sx - 3, -8); g.lineTo(sx, -15); g.lineTo(sx + 3, -8); g.closePath(); g.fill(); } } // stone spikes
        g.fillStyle = '#7c7f8a'; g.strokeStyle = '#3d3f47'; g.lineWidth = 1.6;
        roundRect(g, -12, -9, 24, 19, 6); g.fill(); g.stroke();
        if (L >= 1) { g.strokeStyle = '#4f9a5a'; g.lineWidth = 1.2; for (let i = 0; i < 6; i++) { g.beginPath(); g.arc(-10 + i * 4, 8, 2, Math.PI, 0); g.stroke(); } } // scales
        const er = L >= 2 ? 9.5 : 8;
        g.fillStyle = '#f3e7a1'; g.strokeStyle = '#2b2b2b'; g.lineWidth = 1.4;
        g.beginPath(); g.ellipse(0, 0, er, er * 0.62, 0, 0, 7); g.fill(); g.stroke();
        const ix = Math.cos(a) * er * 0.28, iy = Math.sin(a) * er * 0.18;
        g.fillStyle = '#d9a514'; g.beginPath(); g.arc(ix, iy, er * 0.5, 0, 7); g.fill();
        g.fillStyle = '#111'; g.beginPath(); g.ellipse(ix, iy, 1.3, er * 0.42, 0, 0, 7); g.fill();
        if (L >= 3) { // crown of tiny swaying snakes
          for (let i = 0; i < 5; i++) {
            const q = -Math.PI * 0.85 + (i / 4) * Math.PI * 0.7, sway = Math.sin(t * 4 + i) * 0.12;
            const hx = Math.cos(q + sway) * 15, hy = Math.sin(q + sway) * 12.5;
            g.strokeStyle = '#3f8a36'; g.lineWidth = 1.8; g.beginPath(); g.moveTo(Math.cos(q) * 10, Math.sin(q) * 8); g.lineTo(hx, hy); g.stroke();
            g.fillStyle = '#5aa845'; g.beginPath(); g.arc(hx, hy, 2, 0, 7); g.fill();
          }
        }
        break;
      }
      case 'stormjar': { // glass jar with a storm cloud; the yellow fill shows stored charges
        const st = GD.towerStats('stormjar', L);
        const fill = opts && opts.extra != null ? Math.min(1, opts.extra / st.charges) : 0.6;
        const h = L >= 1 ? 22 : 19, top = -h / 2 - 1;
        g.save(); roundRect(g, -9, top + 3, 18, h, 6); g.clip();
        g.fillStyle = 'rgba(110,180,255,0.5)'; g.fillRect(-10, top, 20, h + 4);
        g.fillStyle = 'rgba(255,226,90,0.65)'; g.fillRect(-10, top + 3 + h * (1 - fill), 20, h * fill + 1);
        g.restore();
        g.strokeStyle = '#2a5f8a'; g.lineWidth = 1.8; roundRect(g, -9, top + 3, 18, h, 6); g.stroke();
        g.fillStyle = 'rgba(255,255,255,0.45)'; g.fillRect(-7, top + 6, 2, h - 8); // glass shine
        g.fillStyle = L >= 3 ? '#3d3658' : '#5d6d8c'; // the storm cloud
        for (const [cx, cy, cr] of [[-3, -1, 3.4], [1.5, -2.5, 3.8], [4.5, 0, 2.8]]) { g.beginPath(); g.arc(cx, cy, cr, 0, 7); g.fill(); }
        if (fill > 0.05) { // crackle
          g.strokeStyle = L >= 3 ? `rgba(220,190,255,${0.5 + 0.5 * Math.sin(t * 17)})` : `rgba(255,230,90,${0.5 + 0.5 * Math.sin(t * 17)})`; g.lineWidth = 1.3;
          g.beginPath(); g.moveTo(-1, 1); g.lineTo(1.5, 4); g.lineTo(-0.5, 5); g.lineTo(2, 8); g.stroke();
        }
        if (L >= 2) { g.strokeStyle = '#c8793a'; g.lineWidth = 1.5; for (const yy of [top + 8, top + 13, top + 18]) { g.beginPath(); g.moveTo(-9, yy); g.lineTo(9, yy + 2.5); g.stroke(); } } // copper coil
        g.fillStyle = L >= 3 ? '#f0b81c' : '#a0703c'; g.strokeStyle = '#4a321a'; g.lineWidth = 1;
        roundRect(g, -6, top - 1, 12, 5, 2); g.fill(); g.stroke(); // cork / lid
        break;
      }
      case 'ballista': { // turntable with a big crossbow, aimed like the Archer
        g.fillStyle = '#7a5530'; g.strokeStyle = '#4a321a'; g.lineWidth = 2;
        g.beginPath(); g.arc(0, 0, 11, 0, 7); g.fill(); g.stroke();
        if (L >= 3) { g.fillStyle = '#5a5f6b'; for (const sy of [-7, 7]) { g.beginPath(); g.arc(-7, sy, 3, 0, 7); g.fill(); } } // winch drums
        g.rotate(a);
        g.strokeStyle = L >= 2 ? '#3d2a16' : '#5a3d1f'; g.lineWidth = L >= 2 ? 3.4 : 2.8;
        g.beginPath(); g.moveTo(1, -14); g.quadraticCurveTo(8, 0, 1, 14); g.stroke(); // bow limbs
        if (L >= 2) { g.fillStyle = '#9aa3ad'; g.fillRect(2.5, -10, 2.5, 2.5); g.fillRect(2.5, 7.5, 2.5, 2.5); } // iron bands
        g.strokeStyle = '#eee'; g.lineWidth = 1; g.beginPath(); g.moveTo(1, -14); g.lineTo(-5, 0); g.lineTo(1, 14); g.stroke(); // string
        g.fillStyle = '#4a321a'; g.fillRect(-7, -2, 14, 4); // stock
        const bl = L >= 1 ? 19 : 16;
        g.strokeStyle = '#2a2018'; g.lineWidth = 2.2; g.beginPath(); g.moveTo(-5, 0); g.lineTo(bl, 0); g.stroke();
        g.fillStyle = L >= 3 ? '#f0b81c' : L >= 1 ? '#c9d3df' : '#2a2018';
        g.beginPath(); g.moveTo(bl + 4, 0); g.lineTo(bl - 1, -3); g.lineTo(bl - 1, 3); g.closePath(); g.fill();
        break;
      }
      case 'drake': { // stone pedestal with a small dragon head that turns to its target
        g.fillStyle = '#8a8d96'; g.strokeStyle = '#4a4c54'; g.lineWidth = 1.6;
        g.beginPath(); g.arc(0, 0, 10.5, 0, 7); g.fill(); g.stroke();
        g.rotate(a);
        if (L >= 1) { g.fillStyle = '#2f7a3a'; for (const sy of [-1, 1]) { g.beginPath(); g.moveTo(-3, sy * 4); g.lineTo(-11, sy * 13); g.lineTo(-6, sy * 6); g.lineTo(-12, sy * 8); g.closePath(); g.fill(); } } // wings
        g.fillStyle = L >= 3 ? '#f0b81c' : L >= 2 ? '#7fd2ff' : '#e8e0c8'; // horns
        for (const sy of [-1, 1]) { g.beginPath(); g.moveTo(-3, sy * 4); g.lineTo(-10, sy * 7); g.lineTo(-2, sy * 1.5); g.closePath(); g.fill(); }
        if (L >= 3) { g.fillStyle = '#f0b81c'; for (let i = 0; i < 3; i++) { g.beginPath(); g.moveTo(-5 + i * 3, -1); g.lineTo(-3.5 + i * 3, -5.5); g.lineTo(-2 + i * 3, -1); g.fill(); } } // crest
        g.fillStyle = '#4fae5a'; g.strokeStyle = '#1f5a2a'; g.lineWidth = 1.4;
        g.beginPath(); g.ellipse(1, 0, 8.5, 6.5, 0, 0, 7); g.fill(); g.stroke(); // head
        g.beginPath(); g.ellipse(9.5, 0, 5.5, 4, 0, 0, 7); g.fill(); g.stroke(); // snout
        g.fillStyle = '#1f5a2a'; g.beginPath(); g.arc(12.5, -1.8, 0.8, 0, 7); g.arc(12.5, 1.8, 0.8, 0, 7); g.fill(); // nostrils
        g.fillStyle = '#ffd35c'; g.beginPath(); g.arc(2.5, -3, 1.8, 0, 7); g.arc(2.5, 3, 1.8, 0, 7); g.fill();
        g.fillStyle = '#111'; g.fillRect(2.2, -4.2, 0.8, 2.4); g.fillRect(2.2, 1.8, 0.8, 2.4); // slit pupils
        if (L >= 2) { g.fillStyle = `rgba(120,200,255,${0.6 + 0.3 * Math.sin(t * 8)})`; g.beginPath(); g.arc(15, 0, 1.8, 0, 7); g.fill(); } // blue mouth glow
        if (L >= 3) { g.rotate(-a); g.fillStyle = 'rgba(200,200,210,0.5)'; for (let i = 0; i < 2; i++) { const q = (t * 0.8 + i / 2) % 1; g.globalAlpha = 1 - q; g.beginPath(); g.arc(-2 + i * 4, -8 - q * 9, 2 + q * 2, 0, 7); g.fill(); } g.globalAlpha = 1; } // smoke
        break;
      }
      case 'goldspitter': { // squat brass pot with a coin slot and a flared spout
        const body = L >= 3 ? '#f0c23a' : '#c9963a';
        if (L >= 3) { g.fillStyle = '#ffd35c'; g.strokeStyle = '#8a6410'; g.lineWidth = 0.8; for (const [cx, cy] of [[-9, 10], [-5, 11.5], [8, 10.5], [4, 12]]) { g.beginPath(); g.ellipse(cx, cy, 3, 1.6, 0, 0, 7); g.fill(); g.stroke(); } } // coin pile
        g.save(); g.rotate(a);
        g.fillStyle = body; g.strokeStyle = '#6b4a12'; g.lineWidth = 1.6;
        const spout = (rot, sc) => { g.save(); g.rotate(rot); g.scale(sc, sc); g.beginPath(); g.moveTo(5, -3.5); g.lineTo(16, -6.5); g.lineTo(16, 6.5); g.lineTo(5, 3.5); g.closePath(); g.fill(); g.stroke(); g.restore(); };
        if (L >= 2) spout(0.65, 0.75); // Ricochet: a second spout
        spout(0, 1);
        g.restore();
        g.fillStyle = body; g.strokeStyle = '#6b4a12'; g.lineWidth = 1.8;
        g.beginPath(); g.arc(0, 1, 10, 0, 7); g.fill(); g.stroke();
        g.fillStyle = '#2b1d00'; roundRect(g, -4.5, -8, 9, 2.4, 1); g.fill(); // coin slot
        g.fillStyle = 'rgba(255,255,255,0.35)'; g.beginPath(); g.ellipse(-4, -2, 2.5, 4, 0.5, 0, 7); g.fill();
        if (L >= 1) { g.fillStyle = '#fff7c2'; const gl = 0.6 + 0.4 * Math.sin(t * 5); g.globalAlpha = gl; g.beginPath(); g.moveTo(4, -4); g.lineTo(5, -2); g.lineTo(7, -1); g.lineTo(5, 0); g.lineTo(4, 2); g.lineTo(3, 0); g.lineTo(1, -1); g.lineTo(3, -2); g.closePath(); g.fill(); g.globalAlpha = 1; } // glint
        break;
      }
      case 'sapling': { // soil mound and a young tree that grows with its growth (opts.extra)
        const grow = opts && opts.extra != null ? opts.extra : 0, k2 = Math.min(1, grow / 12);
        if (L >= 1) { g.strokeStyle = '#5a3d1f'; g.lineWidth = 1.4; for (const [rx, ry] of [[-14, 9], [13, 10], [-11, 13], [10, 13.5]]) { g.beginPath(); g.moveTo(0, 7); g.quadraticCurveTo(rx * 0.5, ry, rx, ry); g.stroke(); } } // roots
        g.fillStyle = '#6b4a2b'; g.beginPath(); g.ellipse(0, 8, 11, 5, 0, 0, 7); g.fill();
        const h = 6 + 11 * k2;
        g.strokeStyle = L >= 2 ? '#9aa3ad' : '#6b4a2b'; g.lineWidth = 2 + 2.5 * k2; g.lineCap = 'round';
        g.beginPath(); g.moveTo(0, 7); g.lineTo(0, 7 - h); g.stroke();
        if (L >= 3) { // Ancient Oak: big round canopy with golden blossoms
          g.fillStyle = '#3f8a36'; g.strokeStyle = '#1f5a2a'; g.lineWidth = 1.4;
          g.beginPath(); g.arc(0, 7 - h - 3, 8 + 3 * k2, 0, 7); g.fill(); g.stroke();
          g.fillStyle = '#ffd35c'; for (let i = 0; i < 5; i++) { const q = i * 1.26; g.beginPath(); g.arc(Math.cos(q) * 5, 7 - h - 3 + Math.sin(q) * 5, 1.4, 0, 7); g.fill(); }
        } else {
          const leaves = 2 + Math.round(grow / 1.5);
          g.fillStyle = '#5ab84a'; g.strokeStyle = '#2a6a22'; g.lineWidth = 1;
          for (let i = 0; i < leaves; i++) {
            const ly = 7 - h + (i / Math.max(1, leaves - 1)) * (h - 4), side = i % 2 ? 1 : -1, sway = Math.sin(t * 3 + i) * 0.15;
            g.beginPath(); g.ellipse(side * 3.5, ly, 3.6, 1.8, side * 0.5 + sway, 0, 7); g.fill(); g.stroke();
          }
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
  // opts.unseen: a ghost none of your towers can see, so it gets a dashed pink ring and a crossed-out eye
  // opts.slowed: 1 = Frost ring, 2 = rooted by vines; opts.lit: a ghost in a Glow Lantern's light
  function slime(g, type, x, y, size, opts) {
    opts = opts || {};
    const E = GD.ENEMIES[type];
    const r = E.r * size;
    const t = opts.time || 0, id = opts.id || 0, flash = opts.flash || 0;
    const wob = Math.sin(t * 9 + id * 1.7) * 0.09 + (REDUCED ? 0 : flash * 0.14);
    const rx = r * (1 + wob), ry = r * (1 - wob);
    g.save();
    g.translate(x, y + r * 0.1);
    if (E.ghost) g.globalAlpha = opts.lit ? 0.92 : 0.5 + 0.12 * Math.sin(t * 5 + id); // ghosts shimmer (solid in lantern light)
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
    if (opts.slowed === 2) { // rooted by a Bramble Snare: thorny vine loops around the base
      g.globalAlpha = 1;
      g.strokeStyle = '#3f8a36'; g.lineWidth = Math.max(1.4, size / 20);
      for (const [cx, w] of [[-0.45, 0.55], [0.1, 0.6], [0.6, 0.5]]) { g.beginPath(); g.ellipse(cx * rx, ry * 0.72, rx * w, ry * 0.32, 0, Math.PI * 0.95, Math.PI * 2.05); g.stroke(); }
      g.fillStyle = '#d23b3b';
      for (const cx of [-0.7, 0, 0.7]) { g.beginPath(); g.arc(cx * rx, ry * 0.45, Math.max(1, size / 40), 0, 7); g.fill(); }
    } else if (opts.slowed) {
      g.globalAlpha = 0.85;
      g.strokeStyle = '#d4f4ff'; g.lineWidth = Math.max(1.2, size / 22);
      g.beginPath(); g.ellipse(0, ry * 0.2, rx * 1.15, ry * 0.95, 0, 0, 7); g.stroke();
    }
    if (opts.lit) { // a ghost in a Glow Lantern's light: thin gold outline
      g.globalAlpha = 1; g.strokeStyle = '#ffd35c'; g.lineWidth = Math.max(1, size / 32); body(); g.stroke();
    }
    g.restore();
    if (opts.unseen) {
      g.save();
      g.strokeStyle = '#ff6fa8'; g.lineWidth = Math.max(1.5, size / 24);
      g.setLineDash([size / 10, size / 13]); g.lineDashOffset = REDUCED ? 0 : -t * size * 0.4;
      g.beginPath(); g.ellipse(x, y + r * 0.15, r * 1.35, r * 1.1, 0, 0, 7); g.stroke();
      g.setLineDash([]);
      const ex = x, ey = y - r * 1.45, ew = r * 0.62;
      g.beginPath(); g.moveTo(ex - ew, ey);
      g.quadraticCurveTo(ex, ey - ew * 0.95, ex + ew, ey); g.quadraticCurveTo(ex, ey + ew * 0.95, ex - ew, ey); g.closePath();
      g.fillStyle = '#fff'; g.fill(); g.strokeStyle = '#1e1530'; g.lineWidth = Math.max(1, size / 34); g.stroke();
      g.fillStyle = '#1e1530'; g.beginPath(); g.arc(ex, ey, ew * 0.3, 0, 7); g.fill();
      g.strokeStyle = '#ff6fa8'; g.lineWidth = Math.max(1.5, size / 22); g.lineCap = 'round';
      g.beginPath(); g.moveTo(ex - ew * 0.85, ey + ew * 0.6); g.lineTo(ex + ew * 0.85, ey - ew * 0.6); g.stroke();
      g.restore();
    }
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

  window.Render = { T, W, H, ground, tower, slime, towerIcon, slimeIcon, roundRect, lighten, darken, reducedMotion: REDUCED };
})();
