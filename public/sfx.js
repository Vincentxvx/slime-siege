// Tiny synthesized sound effects (Web Audio, no files). Mute state is remembered per browser.
(function () {
  let ctx = null, master = null;
  let muted = false;
  try { muted = localStorage.getItem('ss_muted') === '1'; } catch (_) { /* ignore */ }
  const last = {};

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
    return ctx;
  }
  // Browsers only allow audio after a user gesture
  window.addEventListener('pointerdown', () => { const c = ensure(); if (c && c.state === 'suspended') c.resume(); }, { capture: true });

  function tone(freq, dur, type, vol, slideTo, delay) {
    const t = ctx.currentTime + (delay || 0);
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(vol || 0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(dur, vol, filterFreq) {
    const t = ctx.currentTime;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = buf; f.type = 'lowpass'; f.frequency.value = filterFreq || 1200;
    g.gain.value = vol || 0.3;
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t);
  }

  const SOUNDS = {
    arrow: () => tone(900, 0.05, 'triangle', 0.08, 500),
    shot: () => { noise(0.08, 0.18, 3000); tone(220, 0.08, 'square', 0.06, 90); },
    boom: () => { noise(0.3, 0.3, 700); tone(120, 0.25, 'sine', 0.25, 40); },
    zap: () => tone(1400, 0.09, 'sawtooth', 0.06, 300),
    pulse: () => tone(600, 0.25, 'sine', 0.07, 1200),
    pop: () => tone(500 + Math.random() * 300, 0.07, 'sine', 0.12, 1200),
    coin: () => { tone(988, 0.08, 'square', 0.07); tone(1319, 0.18, 'square', 0.07, null, 0.07); },
    place: () => { tone(180, 0.12, 'triangle', 0.25, 90); noise(0.06, 0.12, 900); },
    upgrade: () => { tone(523, 0.08, 'triangle', 0.15); tone(784, 0.14, 'triangle', 0.15, null, 0.08); },
    sell: () => tone(700, 0.15, 'triangle', 0.12, 300),
    send: () => tone(300, 0.12, 'square', 0.08, 600),
    incoming: () => { tone(440, 0.12, 'square', 0.08); tone(330, 0.18, 'square', 0.08, null, 0.13); },
    leak: () => tone(140, 0.25, 'sawtooth', 0.18, 70),
    error: () => tone(160, 0.12, 'square', 0.08),
    emote: () => tone(1046, 0.08, 'sine', 0.12, 1568),
    round: () => { tone(392, 0.1, 'triangle', 0.12); tone(523, 0.16, 'triangle', 0.12, null, 0.1); },
    win: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.22, 'triangle', 0.18, null, i * 0.12)),
    lose: () => [392, 330, 262, 196].forEach((f, i) => tone(f, 0.28, 'triangle', 0.16, null, i * 0.15)),
    start: () => [262, 392].forEach((f, i) => tone(f, 0.15, 'square', 0.08, null, i * 0.12)),
  };
  // Minimum gap per sound so a big wave doesn't become noise
  const GAP = { arrow: 0.06, shot: 0.08, boom: 0.09, zap: 0.08, pulse: 0.2, pop: 0.045, coin: 0.15, leak: 0.25 };

  function play(name) {
    if (muted || !SOUNDS[name]) return;
    const c = ensure();
    if (!c || c.state !== 'running') return;
    const now = c.currentTime;
    if (now - (last[name] || 0) < (GAP[name] || 0.03)) return;
    last[name] = now;
    try { SOUNDS[name](); } catch (_) { /* ignore */ }
  }

  function setMuted(m) {
    muted = m;
    try { localStorage.setItem('ss_muted', m ? '1' : '0'); } catch (_) { /* ignore */ }
    document.querySelectorAll('[data-mute]').forEach((b) => { b.textContent = m ? 'Sound off' : 'Sound on'; b.setAttribute('aria-pressed', String(!m)); });
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mute]');
    if (b) setMuted(!muted);
  });
  document.addEventListener('DOMContentLoaded', () => setMuted(muted));

  window.Sfx = { play, setMuted, isMuted: () => muted };
})();
