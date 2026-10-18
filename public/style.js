/* Look & feel — the backdrop, the ambient bed, the little click sounds, and the snow
   a click throws.

   Its settings live under their own localStorage key on purpose: app.js keeps a copy
   of devchat.prefs.v1 in memory and writes the whole object back, so a value added in
   there can be silently reverted by a chat page that loaded before you changed it.

   No sound file ships with the site. Every one is synthesised, so nothing has to be
   downloaded or licensed. A visitor who wants their own track picks it from disk and
   it is decoded in the browser, this visit only.

   A picture picked from disk is the one thing here that outlives the visit: it is
   shrunk and re-encoded before it goes into localStorage, and never leaves this
   browser. */
window.Style = (() => {
  'use strict';

  const LOOK_KEY = 'devchat.look.v1';
  const BACKDROPS = [
    ['aurora', 'Aurora', 'the drifting colour wash the site ships with'],
    ['grid', 'Grid', 'the grid, nothing else'],
    ['plain', 'Plain', 'a flat background'],
    ['image', 'Picture', 'a picture you own, dimmed for reading']
  ];
  const BEDS = [
    ['none', 'Off'],
    ['drone', 'Drone', 'a low chord, breathing'],
    ['rain', 'Rain', 'filtered noise'],
    ['keys', 'Keys', 'slow notes with echo'],
    ['own', 'Your file', 'a track you pick, this visit only']
  ];
  const DEFAULTS = {
    bg: 'aurora', image: '', file: '', dim: 0,
    ambient: 'none', ambientVol: 25,
    cue: true, cueVol: 45,
    snow: false, snowDensity: 55
  };

  const MARK = `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 17.5c3-5.5 5-5.5 8-2s5 1 8-2"/>
    <path d="M5.5 8.5A6.5 6.5 0 0 1 18 6.2"/>
    <circle cx="12" cy="12.4" r="1.5"/>
  </svg>`;

  function clamp(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  // Quotes, parens and angle brackets are excluded rather than escaped, because this
  // ends up inside url("…") in a stylesheet and a broken-out character there is a way
  // to reach a host nobody typed.
  function safeImage(value) {
    const url = String(value || '').trim();
    return /^https:\/\/[A-Za-z0-9.\-_%~!?*'+,;=&#/@:]{4,400}$/.test(url) ? url : '';
  }

  // A backdrop taken from disk arrives as a data: url, which carries the same risk in
  // the same place, so it gets the same kind of check: base64 alphabet and nothing
  // else. The length cap is the localStorage budget — one origin holds about 5 MB,
  // and a re-encoded 1440px picture lands under 1 MB.
  const PICTURE_EDGE = 1440;
  const PICTURE_BUDGET = 1000000;

  function safeFile(value) {
    const url = String(value || '').trim();
    return /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(url)
      && url.length <= PICTURE_BUDGET ? url : '';
  }

  function read() {
    let raw = {};
    try { raw = JSON.parse(localStorage.getItem(LOOK_KEY) || '{}') || {}; } catch { raw = {}; }
    return {
      bg: BACKDROPS.some(([id]) => id === raw.bg) ? raw.bg : DEFAULTS.bg,
      image: safeImage(raw.image),
      file: safeFile(raw.file),
      dim: clamp(raw.dim, 0, 80, DEFAULTS.dim),
      ambient: BEDS.some(([id]) => id === raw.ambient) ? raw.ambient : DEFAULTS.ambient,
      ambientVol: clamp(raw.ambientVol, 0, 100, DEFAULTS.ambientVol),
      cue: raw.cue !== false,
      cueVol: clamp(raw.cueVol, 0, 100, DEFAULTS.cueVol),
      snow: raw.snow === true,
      snowDensity: clamp(raw.snowDensity, 10, 100, DEFAULTS.snowDensity)
    };
  }

  let look = read();

  // False when the browser refused the write — private mode, or a picture over the
  // quota. The setting still holds for this visit either way.
  function save() {
    try { localStorage.setItem(LOOK_KEY, JSON.stringify(look)); return true; } catch { return false; }
  }

  /* ---------------------------------------------------------------- backdrop */

  function applyBackdrop() {
    const root = document.documentElement;
    root.dataset.bg = look.bg;
    root.style.setProperty('--look-dim', `${look.dim}%`);
    // A typed address wins over a stored file, so clearing the box brings the picture
    // that is still kept back rather than hiding it somewhere nobody can find.
    const url = look.bg === 'image' ? (look.image || look.file) : '';
    root.style.setProperty('--look-image', url ? `url("${url}")` : 'none');
  }

  /* ------------------------------------------------ a picture from this device */

  function readAsDataUrl(file) {
    return new Promise((done, fail) => {
      const reader = new FileReader();
      reader.onload = () => done(String(reader.result));
      reader.onerror = () => fail(reader.error || new Error('unreadable'));
      reader.readAsDataURL(file);
    });
  }

  function loadImage(src) {
    return new Promise((done, fail) => {
      const img = new Image();
      img.onload = () => done(img);
      img.onerror = () => fail(new Error('unreadable'));
      img.src = src;
    });
  }

  /* Shrunk and re-encoded before it is stored, because a phone photo is several
     megabytes and the origin's whole localStorage budget is about five. The file is
     read as a data: url rather than a blob: one — img-src allows data: and not blob:. */
  async function chooseBackdrop(file) {
    if (!file) return;
    setPictureNote('Reading…');
    try {
      const img = await loadImage(await readAsDataUrl(file));
      const edge = Math.max(img.naturalWidth, img.naturalHeight);
      if (!edge) throw new Error('empty picture');
      const scale = Math.min(1, PICTURE_EDGE / edge);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const paint = canvas.getContext('2d');
      // JPEG carries no alpha, so a transparent picture is laid over the page's own
      // colour rather than over black.
      paint.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#000';
      paint.fillRect(0, 0, canvas.width, canvas.height);
      paint.drawImage(img, 0, 0, canvas.width, canvas.height);
      const kept = safeFile(canvas.toDataURL('image/jpeg', 0.82));
      if (!kept) {
        setPictureNote('Even shrunk, that picture is too detailed to keep. Try a smaller one.');
        return;
      }
      look.file = kept;
      const stored = save();
      applyBackdrop();
      sync();
      if (!stored) setPictureNote('This browser will not hold a picture that size — it lasts for this visit only.');
    } catch {
      setPictureNote('That file could not be read as a picture.');
    }
  }

  /* ------------------------------------------------------------------- audio */

  let ctx = null;
  let out = null;
  let bedStop = null;
  let bedGain = null;
  let ownBuffer = null;

  // A context created before a gesture starts suspended and stays there, so this is
  // called from the first pointerdown rather than at load.
  function audio() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    try { ctx = new Ctor(); } catch { return null; }
    out = ctx.createGain();
    out.gain.value = 1;
    out.connect(ctx.destination);
    return ctx;
  }

  function blip({ at = 0, from = 880, to = 0, type = 'sine', dur = 0.1, vol = 0.2 }) {
    const c = audio();
    if (!c || vol <= 0) return;
    const t0 = c.currentTime + at;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(24, to), t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + Math.min(0.02, dur * 0.3));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(out);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  function noiseBuffer(c, seconds) {
    const frames = Math.ceil(c.sampleRate * seconds);
    const buf = c.createBuffer(1, frames, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  function hiss({ at = 0, from = 420, to = 2600, dur = 0.26, q = 0.9, vol = 0.12 }) {
    const c = audio();
    if (!c || vol <= 0) return;
    const t0 = c.currentTime + at;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c, dur + 0.05);
    const band = c.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = q;
    band.frequency.setValueAtTime(from, t0);
    band.frequency.exponentialRampToValueAtTime(Math.max(60, to), t0 + dur);
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + dur * 0.35);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(band).connect(gain).connect(out);
    src.start(t0);
    src.stop(t0 + dur + 0.1);
  }

  const CUES = {
    click: (v) => {
      blip({ from: 1180, to: 700, type: 'triangle', dur: 0.05, vol: v * 0.14 });
    },
    send: (v) => {
      hiss({ from: 380, to: 2700, dur: 0.26, vol: v * 0.09 });
      blip({ from: 300, to: 620, dur: 0.18, vol: v * 0.12 });
    },
    done: (v) => {
      blip({ from: 523.25, dur: 0.5, vol: v * 0.11 });
      blip({ at: 0.11, from: 783.99, dur: 0.6, vol: v * 0.09 });
    },
    error: (v) => {
      blip({ from: 196, to: 150, type: 'sawtooth', dur: 0.2, vol: v * 0.1 });
      blip({ at: 0.16, from: 147, to: 110, type: 'sawtooth', dur: 0.26, vol: v * 0.09 });
    }
  };

  let lastClick = 0;

  function play(name) {
    if (!look.cue || !CUES[name]) return;
    if (name === 'click') {
      // Dragging a slider is a hundred pointer events; that is a machine gun, not a click.
      if (Date.now() - lastClick < 60) return;
      lastClick = Date.now();
    }
    CUES[name](look.cueVol / 100);
  }

  function startDrone(g) {
    const c = ctx;
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 320;
    filter.Q.value = 0.7;
    filter.connect(g);
    const lfo = c.createOscillator();
    lfo.frequency.value = 0.05;
    const lfoDepth = c.createGain();
    lfoDepth.gain.value = 130;
    lfo.connect(lfoDepth).connect(filter.frequency);
    lfo.start();
    const parts = [[55, 'triangle', 0.5], [82.5, 'sine', 0.3], [110, 'sine', 0.18]]
      .map(([freq, type, level]) => {
        const osc = c.createOscillator();
        osc.type = type;
        osc.frequency.value = freq;
        const level2 = c.createGain();
        level2.gain.value = level;
        osc.connect(level2).connect(filter);
        osc.start();
        return osc;
      });
    return () => {
      for (const node of [...parts, lfo]) {
        try { node.stop(); } catch { /* already stopped */ }
      }
    };
  }

  function startRain(g) {
    const c = ctx;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c, 2.5);
    src.loop = true;
    const band = c.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1100;
    band.Q.value = 0.5;
    const soft = c.createBiquadFilter();
    soft.type = 'highpass';
    soft.frequency.value = 220;
    // Two slow, unrelated modulations: the bed never repeats itself exactly.
    const lfo = c.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoDepth = c.createGain();
    lfoDepth.gain.value = 380;
    lfo.connect(lfoDepth).connect(band.frequency);
    lfo.start();
    const swell = c.createGain();
    swell.gain.value = 0.8;
    const lfo2 = c.createOscillator();
    lfo2.frequency.value = 0.13;
    const lfo2Depth = c.createGain();
    lfo2Depth.gain.value = 0.22;
    lfo2.connect(lfo2Depth).connect(swell.gain);
    lfo2.start();
    src.connect(band).connect(soft).connect(swell).connect(g);
    src.start();
    return () => {
      try { src.stop(); } catch { /* already stopped */ }
      for (const node of [lfo, lfo2]) {
        try { node.stop(); } catch { /* already stopped */ }
      }
    };
  }

  const SCALE = [146.83, 174.61, 196, 220, 261.63, 293.66, 349.23, 440];

  function startKeys(g) {
    const c = ctx;
    const echo = c.createDelay(1.5);
    echo.delayTime.value = 0.38;
    const feedback = c.createGain();
    feedback.gain.value = 0.34;
    const wet = c.createGain();
    wet.gain.value = 0.45;
    echo.connect(feedback).connect(echo);
    echo.connect(wet).connect(g);
    let step = 0;
    const timer = setInterval(() => {
      if (document.hidden || c.state !== 'running') return;
      step += 1;
      // Most steps are silence. A note on every one would be a metronome, not a bed.
      if (step % 2 === 1 && Math.random() < 0.55) return;
      const freq = SCALE[Math.floor(Math.random() * SCALE.length)];
      const t0 = c.currentTime + 0.02;
      const osc = c.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const gain = c.createGain();
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.5, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.5);
      osc.connect(gain);
      gain.connect(g);
      gain.connect(echo);
      osc.start(t0);
      osc.stop(t0 + 1.6);
    }, 1300);
    return () => clearInterval(timer);
  }

  function startOwn(g) {
    if (!ownBuffer) return null;
    const c = ctx;
    const src = c.createBufferSource();
    src.buffer = ownBuffer;
    src.loop = true;
    src.connect(g);
    src.start();
    return () => {
      try { src.stop(); } catch { /* already stopped */ }
    };
  }

  const STARTERS = { drone: startDrone, rain: startRain, keys: startKeys, own: startOwn };

  function stopBed() {
    if (bedStop) {
      try { bedStop(); } catch { /* already stopped */ }
    }
    if (bedGain) {
      try { bedGain.disconnect(); } catch { /* never connected */ }
    }
    bedStop = null;
    bedGain = null;
  }

  function bedVolume() {
    // 'own' is a whole track the listener chose, so it gets the fuller range; a
    // synthesised bed is meant to sit under the page, not in front of it.
    const headroom = look.ambient === 'own' ? 0.85 : 0.3;
    return Math.max(0.0002, (look.ambientVol / 100) * headroom);
  }

  // A level change has to cancel the ramp already in flight, because a gain being
  // automated ignores a direct .value write until that ramp finishes — moving the
  // slider to 0 would otherwise carry on getting louder.
  function setBedVolume(ramp) {
    if (!bedGain) return;
    const p = bedGain.gain;
    const now = ctx.currentTime;
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    p.exponentialRampToValueAtTime(bedVolume(), now + ramp);
  }

  function startBed() {
    stopBed();
    const starter = STARTERS[look.ambient];
    if (!starter || look.ambient === 'none' || !audio()) return;
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    g.connect(out);
    let stop = null;
    try { stop = starter(g); } catch { stop = null; }
    if (!stop) {
      g.disconnect();
      if (look.ambient === 'own') setOwnNote('Pick a track below — nothing is uploaded anywhere.');
      return;
    }
    g.gain.exponentialRampToValueAtTime(bedVolume(), ctx.currentTime + 1.4);
    bedGain = g;
    bedStop = stop;
    setOwnNote(look.ambient === 'own' ? 'Playing this visit only.' : '');
  }

  function refreshBed() {
    if (look.ambient === 'none') {
      stopBed();
      return;
    }
    if (!bedGain) startBed();
    else setBedVolume(0.25);
  }

  async function loadOwn(file) {
    const c = audio();
    if (!c || !file) return;
    if (c.state === 'suspended') {
      try { await c.resume(); } catch { /* the gesture may not have counted */ }
    }
    setOwnNote('Decoding…');
    try {
      ownBuffer = await c.decodeAudioData(await file.arrayBuffer());
      look.ambient = 'own';
      save();
      startBed();
      sync();
    } catch {
      setOwnNote('That file could not be decoded — a browser-supported audio format only.');
    }
  }

  /* ------------------------------------------------------- snow under the cursor */

  // One click throws a ring of flakes and gravity takes each of them over a moment
  // later — that handover is what reads as a shatter rather than a circle of dots.
  // Dragging sheds flakes along the path the pointer came by.
  //
  // A flake is drawn once into a sprite and blitted after that. Six arms with branch
  // ticks is eighteen sub-paths, and re-stroking that for every live flake on every
  // frame is the difference between a treat and a laptop fan.

  const FLAKE_EDGE = 72;
  const FLAKE_LIMIT = 140;
  const flakes = [];
  let layer = null;
  let paint = null;
  let sprites = null;
  let spriteKey = '';
  let raf = 0;
  let lastFrame = 0;
  let drag = null;

  function flakeSprite(color) {
    const c = document.createElement('canvas');
    c.width = FLAKE_EDGE;
    c.height = FLAKE_EDGE;
    const g = c.getContext('2d');
    g.translate(FLAKE_EDGE / 2, FLAKE_EDGE / 2);
    g.strokeStyle = color;
    g.lineWidth = 3.4;
    g.lineCap = 'round';
    const r = FLAKE_EDGE / 2 - 6;
    g.beginPath();
    for (let arm = 0; arm < 6; arm += 1) {
      const a = (Math.PI / 3) * arm;
      const ox = Math.cos(a);
      const oy = Math.sin(a);
      g.moveTo(0, 0);
      g.lineTo(ox * r, oy * r);
      const bx = ox * r * 0.56;
      const by = oy * r * 0.56;
      for (const side of [-1, 1]) {
        const t = a + side * 0.62;
        g.moveTo(bx, by);
        g.lineTo(bx + Math.cos(t) * r * 0.3, by + Math.sin(t) * r * 0.3);
      }
    }
    g.stroke();
    return c;
  }

  function flakeSprites() {
    const cs = getComputedStyle(document.documentElement);
    const pick = (name, fallback) => String(cs.getPropertyValue(name)).trim() || fallback;
    const palette = [pick('--accent', '#34e2c8'), pick('--accent-2', '#8b5cf6'), pick('--text', '#e9f7f5')];
    // A cached flake keeps the colour it was drawn with, so the palette itself has to
    // be the cache key — the theme button can change it under this.
    const key = palette.join('|');
    if (!sprites || key !== spriteKey) {
      sprites = palette.map((color) => flakeSprite(color));
      spriteKey = key;
    }
    return sprites;
  }

  function sizeLayer() {
    if (!layer) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(window.innerWidth * dpr));
    const h = Math.max(1, Math.round(window.innerHeight * dpr));
    if (layer.width !== w || layer.height !== h) {
      layer.width = w;
      layer.height = h;
    }
    paint.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // The canvas is not in the document until the first click that needs it, so a
  // visitor who never turns this on never carries an empty full-screen layer.
  function ensureLayer() {
    if (layer) return true;
    const canvas = document.createElement('canvas');
    canvas.className = 'weather-layer';
    canvas.setAttribute('aria-hidden', 'true');
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    layer = canvas;
    paint = ctx;
    document.body.appendChild(canvas);
    sizeLayer();
    window.addEventListener('resize', sizeLayer);
    return true;
  }

  function addFlake(x, y, vx, vy, r) {
    if (flakes.length >= FLAKE_LIMIT) return;
    const set = flakeSprites();
    flakes.push({
      x, y, vx, vy, r,
      rot: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.045,
      age: 0,
      span: 1.5 + Math.random() * 1.7,
      sway: 0.25 + Math.random() * 0.55,
      phase: Math.random() * 6.283,
      sprite: set[(Math.random() * set.length) | 0]
    });
  }

  function burst(x, y) {
    if (!look.snow || !ensureLayer()) return;
    const count = 8 + Math.round(look.snowDensity / 7);
    for (let i = 0; i < count; i += 1) {
      const a = (Math.PI * 2 * i) / count + Math.random() * 0.6;
      const speed = 1.8 + Math.random() * 3.6;
      addFlake(x, y, Math.cos(a) * speed, Math.sin(a) * speed - 1.1, 4 + Math.random() * 7);
    }
    wake();
  }

  // Density is the gap between flakes rather than a count per move, so a slow drag
  // sheds a few and a fast flick sheds a ribbon without the total running away.
  function shed(x, y, dx, dy, step) {
    addFlake(x, y, dx / step * 0.75 + (Math.random() - 0.5), dy / step * 0.75 + Math.random() * 0.7,
      3.5 + Math.random() * 6);
    wake();
  }

  function wake() {
    if (raf) return;
    lastFrame = 0;
    raf = requestAnimationFrame(frame);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    // Clamped, because the first frame after a tab was in the background reports the
    // whole gap since the last one and every flake would teleport off screen.
    const dt = Math.min(3, lastFrame ? (now - lastFrame) / 16.667 : 1);
    lastFrame = now;
    const h = window.innerHeight;
    paint.clearRect(0, 0, window.innerWidth, h);
    for (let i = flakes.length - 1; i >= 0; i -= 1) {
      const f = flakes[i];
      f.age += dt / 60;
      if (f.age >= f.span || f.y > h + 40) {
        flakes.splice(i, 1);
        continue;
      }
      f.vy += 0.055 * dt;
      f.vx *= 1 - Math.min(0.05, 0.012 * dt);
      f.x += (f.vx + Math.cos(f.phase + f.age * f.sway) * 0.35) * dt;
      f.y += f.vy * dt;
      f.rot += f.spin * dt;
      paint.save();
      paint.globalAlpha = Math.min(1, (f.span - f.age) / (f.span * 0.35));
      paint.translate(f.x, f.y);
      paint.rotate(f.rot);
      paint.drawImage(f.sprite, -f.r, -f.r, f.r * 2, f.r * 2);
      paint.restore();
    }
    if (!flakes.length) {
      // Nothing alive means nothing to animate: the loop stops rather than redrawing
      // an empty screen for the rest of the visit.
      cancelAnimationFrame(raf);
      raf = 0;
      lastFrame = 0;
    }
  }

  function stopSnow() {
    flakes.length = 0;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    lastFrame = 0;
    if (paint) paint.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }

  function armSnow() {
    window.addEventListener('pointerdown', (event) => {
      if (!look.snow || event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY, gap: 0 };
      burst(event.clientX, event.clientY);
    });
    window.addEventListener('pointermove', (event) => {
      if (!drag) return;
      // A pointer that left the window never reported its release.
      if (!look.snow || event.buttons === 0) { drag = null; return; }
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      drag.x = event.clientX;
      drag.y = event.clientY;
      const step = Math.max(5, 32 - Math.round(look.snowDensity / 3.5));
      drag.gap += Math.hypot(dx, dy);
      while (drag.gap >= step) {
        drag.gap -= step;
        shed(event.clientX, event.clientY, dx, dy, step);
      }
    });
    const release = () => { drag = null; };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
  }

  /* -------------------------------------------------------------- the trigger */

  let trigger = null;
  let panel = null;
  let open = false;

  function mount() {
    const anchor = document.getElementById('themeBtn');
    if (!anchor || !anchor.parentNode || document.getElementById('lookBtn')) return;
    trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'btn btn-ghost look-trigger';
    trigger.id = 'lookBtn';
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', 'Look and feel');
    trigger.title = 'Look & feel';
    trigger.innerHTML = `${MARK}<span>Look</span>`;
    trigger.addEventListener('click', toggle);
    anchor.parentNode.insertBefore(trigger, anchor.nextSibling);
  }

  function markup() {
    const bg = BACKDROPS.map(([id, label]) => `
      <label class="lf-opt">
        <input type="radio" name="lfBg" value="${id}" data-look-silent>
        <span>${label}</span>
      </label>`).join('');
    const beds = BEDS.map(([id, label]) => `
      <label class="lf-opt">
        <input type="radio" name="lfBed" value="${id}" data-look-silent>
        <span>${label}</span>
      </label>`).join('');
    return `
      <div class="lf-head">
        <h2>Look &amp; feel</h2>
        <button type="button" class="icon-btn" data-lf="close" data-look-silent aria-label="Close">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <p class="lf-legend">Background</p>
      <div class="lf-opts">${bg}</div>
      <div class="lf-picture" data-lf="picture">
        <label class="lf-field">
          <span>Picture address (https)</span>
          <input type="url" data-lf="image" data-look-silent placeholder="https://…/wallpaper.jpg"
                 autocapitalize="none" spellcheck="false">
        </label>
        <div class="lf-file">
          <button type="button" class="btn btn-ghost" data-lf="pick">From this device</button>
          <button type="button" class="btn btn-ghost" data-lf="clearFile" hidden>Remove</button>
        </div>
        <label class="lf-slider">
          <span>Dim for reading <b data-lf="dimVal">0%</b></span>
          <input type="range" min="0" max="80" step="5" data-lf="dim" data-look-silent>
        </label>
        <p class="lf-note" data-lf="fileNote"></p>
      </div>
      <p class="lf-legend">Ambient sound</p>
      <div class="lf-opts">${beds}</div>
      <label class="lf-slider">
        <span>Level <b data-lf="ambientVal">25%</b></span>
        <input type="range" min="0" max="100" step="5" data-lf="ambientVol" data-look-silent>
      </label>
      <p class="lf-note" data-lf="ownNote"></p>
      <p class="lf-legend">Interface sounds</p>
      <label class="lf-opt lf-toggle">
        <input type="checkbox" data-lf="cue" data-look-silent>
        <span>Clicks, sends and finished answers</span>
      </label>
      <label class="lf-slider">
        <span>Level <b data-lf="cueVal">45%</b></span>
        <input type="range" min="0" max="100" step="5" data-lf="cueVol" data-look-silent>
      </label>
      <p class="lf-legend">Cursor</p>
      <label class="lf-opt lf-toggle">
        <input type="checkbox" data-lf="snow" data-look-silent>
        <span>Snow from clicks and drags</span>
      </label>
      <label class="lf-slider">
        <span>How much <b data-lf="snowVal">55%</b></span>
        <input type="range" min="10" max="100" step="5" data-lf="snowDensity" data-look-silent>
      </label>
      <div class="lf-foot">
        <button type="button" class="btn btn-ghost" data-lf="test" data-look-silent>Test</button>
        <button type="button" class="btn btn-ghost" data-lf="reset" data-look-silent>Reset</button>
      </div>`;
  }

  function build() {
    panel = document.createElement('section');
    panel.className = 'lf';
    panel.id = 'lookPanel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Look and feel');
    panel.hidden = true;
    panel.innerHTML = markup();
    document.body.appendChild(panel);

    const own = document.createElement('input');
    own.type = 'file';
    own.accept = 'audio/*';
    own.id = 'lookFile';
    own.hidden = true;
    own.addEventListener('change', () => loadOwn(own.files?.[0]));
    document.body.appendChild(own);

    const pic = document.createElement('input');
    pic.type = 'file';
    pic.accept = 'image/*';
    pic.id = 'lookPicture';
    pic.hidden = true;
    pic.addEventListener('change', () => {
      const file = pic.files?.[0];
      // Cleared first, so choosing the same picture twice counts as a new choice.
      pic.value = '';
      chooseBackdrop(file);
    });
    document.body.appendChild(pic);

    panel.addEventListener('click', (event) => {
      const act = event.target.closest('[data-lf]');
      if (!act) return;
      if (act.dataset.lf === 'close') toggle();
      if (act.dataset.lf === 'pick') document.getElementById('lookPicture').click();
      if (act.dataset.lf === 'clearFile') {
        look.file = '';
        save();
        applyBackdrop();
        sync();
      }
      if (act.dataset.lf === 'test') {
        play('click');
        play('send');
        play('done');
      }
      if (act.dataset.lf === 'reset') {
        look = { ...DEFAULTS };
        save();
        applyBackdrop();
        stopBed();
        stopSnow();
        toggle(true);
        sync();
      }
    });

    panel.addEventListener('change', (event) => {
      const input = event.target;
      if (input.name === 'lfBg') {
        look.bg = input.value;
        save();
        applyBackdrop();
        sync();
        return;
      }
      if (input.name === 'lfBed') {
        look.ambient = input.value;
        save();
        if (look.ambient === 'own' && !ownBuffer) {
          document.getElementById('lookFile').click();
          sync();
          return;
        }
        startBed();
        sync();
      }
      if (input.dataset.lf === 'image') {
        const url = safeImage(input.value);
        look.image = url;
        save();
        applyBackdrop();
        sync();
        // Pasting a data: url here is a natural mistake now the file goes into storage
        // as one, and the silent refusal above would look like a broken box.
        if (!url && input.value.trim()) {
          setPictureNote('That address was refused. A picture from this device goes through the button above.');
        }
      }
      if (input.dataset.lf === 'cue') {
        look.cue = input.checked;
        save();
        if (look.cue) play('click');
      }
      if (input.dataset.lf === 'snow') {
        look.snow = input.checked;
        save();
        if (!look.snow) {
          stopSnow();
        } else {
          // Better to show it working here than to leave them wondering whether the
          // tick did anything at all.
          const box = input.getBoundingClientRect();
          burst(box.left + box.width / 2, box.top + box.height / 2);
        }
      }
    });

    panel.addEventListener('input', (event) => {
      const input = event.target;
      if (input.dataset.lf === 'dim') {
        look.dim = clamp(input.value, 0, 80, 0);
        applyBackdrop();
        panel.querySelector('[data-lf="dimVal"]').textContent = `${look.dim}%`;
        save();
      }
      if (input.dataset.lf === 'ambientVol') {
        look.ambientVol = clamp(input.value, 0, 100, 25);
        panel.querySelector('[data-lf="ambientVal"]').textContent = `${look.ambientVol}%`;
        setBedVolume(0.12);
        save();
      }
      if (input.dataset.lf === 'cueVol') {
        look.cueVol = clamp(input.value, 0, 100, 45);
        panel.querySelector('[data-lf="cueVal"]').textContent = `${look.cueVol}%`;
        save();
      }
      if (input.dataset.lf === 'snowDensity') {
        look.snowDensity = clamp(input.value, 10, 100, 55);
        panel.querySelector('[data-lf="snowVal"]').textContent = `${look.snowDensity}%`;
        save();
      }
    });
  }

  function setOwnNote(text) {
    const note = panel?.querySelector('[data-lf="ownNote"]');
    if (note) note.textContent = text || '';
  }

  function setPictureNote(text) {
    const note = panel?.querySelector('[data-lf="fileNote"]');
    if (note) note.textContent = text || '';
  }

  // Keep the controls showing what is stored, and show the picture row only when a
  // picture is the chosen background.
  function sync() {
    if (!panel) return;
    for (const input of panel.querySelectorAll('[name="lfBg"]')) input.checked = input.value === look.bg;
    for (const input of panel.querySelectorAll('[name="lfBed"]')) input.checked = input.value === look.ambient;
    panel.querySelector('[data-lf="image"]').value = look.image;
    panel.querySelector('[data-lf="dim"]').value = String(look.dim);
    panel.querySelector('[data-lf="dimVal"]').textContent = `${look.dim}%`;
    panel.querySelector('[data-lf="ambientVol"]').value = String(look.ambientVol);
    panel.querySelector('[data-lf="ambientVal"]').textContent = `${look.ambientVol}%`;
    panel.querySelector('[data-lf="cue"]').checked = look.cue;
    panel.querySelector('[data-lf="cueVol"]').value = String(look.cueVol);
    panel.querySelector('[data-lf="cueVal"]').textContent = `${look.cueVol}%`;
    panel.querySelector('[data-lf="snow"]').checked = look.snow;
    panel.querySelector('[data-lf="snowDensity"]').value = String(look.snowDensity);
    panel.querySelector('[data-lf="snowVal"]').textContent = `${look.snowDensity}%`;
    panel.querySelector('[data-lf="picture"]').hidden = look.bg !== 'image';
    panel.querySelector('[data-lf="clearFile"]').hidden = !look.file;
    setPictureNote(look.file ? 'Kept in this browser only, and shown whenever the address box is empty.' : '');
    setOwnNote(look.ambient === 'own' && !ownBuffer
      ? 'Pick a track below — nothing is uploaded anywhere.'
      : look.ambient === 'own' ? 'Playing this visit only.' : '');
  }

  function toggle(force) {
    if (!panel) build();
    open = typeof force === 'boolean' ? force : !open;
    panel.hidden = !open;
    if (open) {
      sync();
      panel.querySelector('input[name="lfBg"]:checked')?.focus();
    } else if (document.activeElement && panel.contains(document.activeElement)) {
      trigger.focus();
    }
    trigger.setAttribute('aria-expanded', String(open));
  }

  /* ------------------------------------------------------------------- boot */

  function armGestures() {
    // A bed stored from an earlier visit cannot start until the browser believes the
    // visitor chose to, so this fires once, on the first real interaction. Picking a
    // bed inside the panel already happens inside a gesture handler.
    const start = () => {
      document.removeEventListener('pointerdown', start);
      document.removeEventListener('keydown', start);
      if (audio()) refreshBed();
    };
    document.addEventListener('pointerdown', start);
    document.addEventListener('keydown', start);
  }

  applyBackdrop();
  mount();
  armGestures();
  armSnow();

  document.addEventListener('pointerdown', (event) => {
    const hit = event.target.closest('button, [role="tab"], .ov-provider');
    if (!hit || hit.disabled || hit.closest('[data-look-silent]')) return;
    play('click');
  });

  // Outside the panel closes it. On keypress that would be wrong — typing into the
  // picture address box is a keystroke, and Tab has to move through the controls
  // rather than vanish the dialog.
  document.addEventListener('pointerdown', (event) => {
    if (!open || panel?.contains(event.target)) return;
    if (trigger === event.target || trigger?.contains(event.target)) return;
    toggle(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open) toggle(false);
  });

  return {
    play,
    apply: applyBackdrop,
    get settings() { return { ...look }; },
    open: () => toggle(true)
  };
})();
