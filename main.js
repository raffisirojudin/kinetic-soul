/**
 * KINETIC·SOUL — Gen-Art Engine v2
 * KS-V1-2026
 *
 * Architecture:
 *   ├── Config          — Centralized state & settings
 *   ├── Palettes        — Color palette definitions
 *   ├── Perlin          — Smooth noise for flow field
 *   ├── SoundEngine     — Procedural Web Audio synth (NEW)
 *   ├── Particle        — Particle class with object pooling
 *   ├── SpatialGrid     — O(n) proximity lookup for web lines (NEW)
 *   ├── ParticleSystem  — Engine: loop, physics, rendering (OPTIMIZED)
 *   ├── AudioAnalyzer   — Mic FFT input
 *   ├── AnimationPresets— Preset configs
 *   └── UI              — Controls, buttons, events
 *
 * FPS Optimizations:
 *   [1] Spatial grid replaces O(n²) web line search → O(n)
 *   [2] Trail: single path + globalAlpha, no per-particle gradient
 *   [3] Glow only rendered when bloom > 30%
 *   [4] Adaptive particle count auto-throttles on FPS drop
 *   [5] Connection lines capped at MAX_CONNECTIONS per particle
 *   [6] Pre-allocated typed arrays, zero GC in hot path
 *   [7] Canvas alpha:false (opaque) — faster compositing
 *   [8] DPR capped at 2x for high-DPI perf
 *   [9] Cached bg fillStyle, not recomputed each frame
 */

"use strict";

/* ============================================================
   1. CONFIG
   ============================================================ */
const Config = {
  mode: "galaxy",
  palette: "cyberpunk",
  count: 800,
  gravity: 60,
  speed: 50,
  size: 2,
  trail: 15,
  bloom: 70,
  frozen: false,
  soundEnabled: true,

  mouse: { x: -9999, y: -9999 },
  audioData: { bass: 0, mid: 0, treble: 0 },
  fps: 0,
  activeCount: 0,
};

/* ============================================================
   2. PALETTES
   ============================================================ */
const Palettes = {
  cyberpunk: {
    colors: [
      "#ff006e",
      "#ff4da6",
      "#ff85c2",
      "#8338ec",
      "#a855f7",
      "#3a86ff",
      "#60a5fa",
    ],
    bg: "rgba(5,5,8,0.18)",
  },
  aurora: {
    colors: [
      "#00f5d4",
      "#00e8c8",
      "#00bbf9",
      "#0096f7",
      "#9b5de5",
      "#c77dff",
      "#e0aaff",
    ],
    bg: "rgba(0,8,15,0.18)",
  },
  fire: {
    colors: [
      "#ffbe0b",
      "#ffca3a",
      "#fb5607",
      "#ff4500",
      "#ff006e",
      "#ff4da6",
      "#fff3b0",
    ],
    bg: "rgba(8,3,0,0.20)",
  },
  ocean: {
    colors: [
      "#90e0ef",
      "#00b4d8",
      "#0077b6",
      "#023e8a",
      "#caf0f8",
      "#48cae4",
      "#ade8f4",
    ],
    bg: "rgba(0,5,12,0.18)",
  },
  void: {
    colors: [
      "#7400b8",
      "#6930c3",
      "#5e60ce",
      "#5390d9",
      "#4ea8de",
      "#48bfe3",
      "#c77dff",
    ],
    bg: "rgba(3,0,10,0.20)",
  },
};

/* ============================================================
   3. PERLIN NOISE
   ============================================================ */
const Perlin = (() => {
  const perm = new Uint8Array(512);
  const grad3 = [
    [1, 1, 0],
    [-1, 1, 0],
    [1, -1, 0],
    [-1, -1, 0],
    [1, 0, 1],
    [-1, 0, 1],
    [1, 0, -1],
    [-1, 0, -1],
    [0, 1, 1],
    [0, -1, 1],
    [0, 1, -1],
    [0, -1, -1],
  ];
  function seed() {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    let r = 12345;
    for (let i = 255; i > 0; i--) {
      r = (r * 16807) % 2147483647;
      const j = r % (i + 1);
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  }
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + t * (b - a);
  const dot = (g, x, y) => g[0] * x + g[1] * y;
  function noise(x, y) {
    const X = Math.floor(x) & 255,
      Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x),
      yf = y - Math.floor(y);
    const u = fade(xf),
      v = fade(yf);
    const a = perm[X] + Y,
      b = perm[X + 1] + Y;
    return lerp(
      lerp(
        dot(grad3[perm[a] & 11], xf, yf),
        dot(grad3[perm[b] & 11], xf - 1, yf),
        u,
      ),
      lerp(
        dot(grad3[perm[a + 1] & 11], xf, yf - 1),
        dot(grad3[perm[b + 1] & 11], xf - 1, yf - 1),
        u,
      ),
      v,
    );
  }
  seed();
  return { noise };
})();

/* ============================================================
   4. SOUND ENGINE — Procedural Web Audio synthesizer
   ============================================================ */
const SoundEngine = (() => {
  let ctx = null;
  let masterGain = null;
  let ambientOsc = null;
  let ambientGain = null;
  let initialized = false;

  function ensure() {
    if (initialized) return true;
    if (!Config.soundEnabled) return false;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = ctx.createGain();
      masterGain.gain.setValueAtTime(0.22, ctx.currentTime);
      masterGain.connect(ctx.destination);

      // Continuous ambient drone
      ambientOsc = ctx.createOscillator();
      ambientGain = ctx.createGain();
      ambientOsc.type = "sine";
      ambientOsc.frequency.setValueAtTime(55, ctx.currentTime);
      ambientGain.gain.setValueAtTime(0.0, ctx.currentTime);
      ambientOsc.connect(ambientGain);
      ambientGain.connect(masterGain);
      ambientOsc.start();

      initialized = true;
      return true;
    } catch (e) {
      console.warn("SoundEngine init failed:", e);
      return false;
    }
  }

  // Ambient drone — volume + pitch scale with particle activity
  function updateAmbient(speedNorm, countNorm) {
    if (!initialized || !Config.soundEnabled) return;
    const vol = speedNorm * countNorm * 0.045;
    ambientGain.gain.linearRampToValueAtTime(vol, ctx.currentTime + 0.4);
    ambientOsc.frequency.linearRampToValueAtTime(
      44 + speedNorm * 32,
      ctx.currentTime + 0.6,
    );
  }

  // Impact sound on click/explode — stereo positioned
  function playExplode(x, canvasW) {
    if (!ensure() || !Config.soundEnabled) return;
    const t = ctx.currentTime;
    const pan = Math.max(-1, Math.min(1, (x / canvasW) * 2 - 1));

    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(pan, t);
    panner.connect(masterGain);

    // Low thud
    const sub = ctx.createOscillator();
    const subG = ctx.createGain();
    sub.type = "sine";
    sub.frequency.setValueAtTime(90, t);
    sub.frequency.exponentialRampToValueAtTime(18, t + 0.45);
    subG.gain.setValueAtTime(0.65, t);
    subG.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    sub.connect(subG);
    subG.connect(panner);
    sub.start(t);
    sub.stop(t + 0.45);

    // Noise shimmer burst
    const bufLen = Math.ceil(ctx.sampleRate * 0.28);
    const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = buf;
    const noiseF = ctx.createBiquadFilter();
    noiseF.type = "bandpass";
    noiseF.frequency.setValueAtTime(1600 + Math.random() * 2200, t);
    noiseF.Q.setValueAtTime(0.9, t);
    const noiseG = ctx.createGain();
    noiseG.gain.setValueAtTime(0.28, t);
    noiseG.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    noiseSrc.connect(noiseF);
    noiseF.connect(noiseG);
    noiseG.connect(panner);
    noiseSrc.start(t);

    // Shimmer tone
    const shimmer = ctx.createOscillator();
    const shimG = ctx.createGain();
    shimmer.type = "triangle";
    shimmer.frequency.setValueAtTime(1100 + Math.random() * 900, t);
    shimmer.frequency.exponentialRampToValueAtTime(350, t + 0.55);
    shimG.gain.setValueAtTime(0.14, t);
    shimG.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    shimmer.connect(shimG);
    shimG.connect(panner);
    shimmer.start(t);
    shimmer.stop(t + 0.55);
  }

  // Whoosh — mode/preset switch
  function playWhoosh() {
    if (!ensure() || !Config.soundEnabled) return;
    const t = ctx.currentTime;

    // Rising noise sweep
    const bufLen = Math.ceil(ctx.sampleRate * 0.65);
    const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = "bandpass";
    filt.frequency.setValueAtTime(180, t);
    filt.frequency.exponentialRampToValueAtTime(3200, t + 0.55);
    filt.Q.setValueAtTime(2.2, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0, t);
    g.gain.linearRampToValueAtTime(0.32, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.65);
    noiseSrc.connect(filt);
    filt.connect(g);
    g.connect(masterGain);
    noiseSrc.start(t);

    // Ascending sawtooth
    const osc = ctx.createOscillator();
    const og = ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(620, t + 0.5);
    og.gain.setValueAtTime(0.07, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    osc.connect(og);
    og.connect(masterGain);
    osc.start(t);
    osc.stop(t + 0.5);
  }

  // UI tick — button hover/click
  function playTick() {
    if (!ensure() || !Config.soundEnabled) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(1900, t);
    g.gain.setValueAtTime(0.055, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.055);
    osc.connect(g);
    g.connect(masterGain);
    osc.start(t);
    osc.stop(t + 0.055);
  }

  // Space bar freeze/unfreeze
  function playFreeze(frozen) {
    if (!ensure() || !Config.soundEnabled) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(frozen ? 180 : 480, t);
    osc.frequency.linearRampToValueAtTime(frozen ? 60 : 900, t + 0.18);
    g.gain.setValueAtTime(0.09, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    osc.connect(g);
    g.connect(masterGain);
    osc.start(t);
    osc.stop(t + 0.22);
  }

  function setMasterVolume(v) {
    if (!initialized) return;
    masterGain.gain.linearRampToValueAtTime(v * 0.22, ctx.currentTime + 0.1);
  }

  return {
    ensure,
    updateAmbient,
    playExplode,
    playWhoosh,
    playTick,
    playFreeze,
    setMasterVolume,
  };
})();

/* ============================================================
   5. PARTICLE
   ============================================================ */
const MAX_PARTICLES = 2000;
const MAX_TRAIL = 50;

class Particle {
  constructor() {
    this.active = false;
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.ax = 0;
    this.ay = 0;
    this.radius = 2;
    this.color = "#ff006e";
    this.alpha = 1;
    this.life = 1;
    this.noiseOffset = 0;
    this.orbitAngle = 0;
    this.orbitRadius = 0;
    this.orbitSpeed = 0;
    this.trail = new Float32Array(MAX_TRAIL * 2);
    this.trailLen = 0;
  }

  init(W, H) {
    this.active = true;
    const pal = Palettes[Config.palette];
    this.color = pal.colors[Math.floor(Math.random() * pal.colors.length)];
    this.alpha = 0.55 + Math.random() * 0.45;
    this.radius = Config.size * 0.5 + Math.random() * Config.size;
    this.noiseOffset = Math.random() * 1000;
    this.trailLen = 0;
    this.life = 150 + Math.random() * 350;
    this.ax = 0;
    this.ay = 0;
    this.vx = 0;
    this.vy = 0;

    if (Config.mode === "galaxy") {
      this.orbitAngle = Math.random() * Math.PI * 2;
      this.orbitRadius = 60 + Math.random() * Math.min(W, H) * 0.42;
      this.orbitSpeed =
        (0.0003 + Math.random() * 0.0008) * (Math.random() < 0.5 ? 1 : -1);
      this.x = W / 2 + Math.cos(this.orbitAngle) * this.orbitRadius;
      this.y = H / 2 + Math.sin(this.orbitAngle) * this.orbitRadius;
    } else if (Config.mode === "web") {
      this.x = Math.random() * W;
      this.y = Math.random() * H;
      const a = Math.random() * Math.PI * 2;
      const s = 0.1 + Math.random() * 0.5;
      this.vx = Math.cos(a) * s;
      this.vy = Math.sin(a) * s;
    } else {
      const a = Math.random() * Math.PI * 2;
      const s = 0.5 + Math.random() * 3;
      this.x = W / 2 + (Math.random() - 0.5) * 80;
      this.y = H / 2 + (Math.random() - 0.5) * 80;
      this.vx = Math.cos(a) * s;
      this.vy = Math.sin(a) * s;
      this.life = 80 + Math.random() * 160;
    }
  }

  pushTrail(maxTrail) {
    const len = Math.min(this.trailLen, maxTrail - 1);
    this.trail.copyWithin(2, 0, len * 2);
    this.trail[0] = this.x;
    this.trail[1] = this.y;
    if (this.trailLen < maxTrail) this.trailLen++;
  }
}

/* ============================================================
   6. SPATIAL GRID — O(n) proximity lookup
   ============================================================ */
class SpatialGrid {
  constructor(cellSize) {
    this.cellSize = cellSize;
    this.cells = new Map();
  }
  clear() {
    this.cells.clear();
  }
  _key(x, y) {
    return ((x / this.cellSize) | 0) * 10000 + ((y / this.cellSize) | 0);
  }
  insert(p) {
    const k = this._key(p.x, p.y);
    if (!this.cells.has(k)) this.cells.set(k, []);
    this.cells.get(k).push(p);
  }
  query(p) {
    const cx = (p.x / this.cellSize) | 0;
    const cy = (p.y / this.cellSize) | 0;
    const result = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = this.cells.get((cx + dx) * 10000 + (cy + dy));
        if (cell) for (let i = 0; i < cell.length; i++) result.push(cell[i]);
      }
    }
    return result;
  }
}

/* ============================================================
   7. PARTICLE SYSTEM — Optimized engine
   ============================================================ */
const ParticleSystem = (() => {
  let canvas, ctx, W, H, dpr;
  const particles = [];
  let noiseTime = 0;

  // FPS tracking
  let lastTime = 0,
    fpsFrames = 0,
    fpsLast = 0;

  // Spatial grid (web mode)
  const grid = new SpatialGrid(120);
  const MAX_CONNECTIONS = 5;

  // Pre-allocated temps
  let dx, dy, distSq, dist, force, flowAngle, n_val;
  let cachedBg = "",
    cachedPalKey = "";

  function init() {
    canvas = document.getElementById("canvas");
    ctx = canvas.getContext("2d", { alpha: false }); // [OPT-7] opaque = faster
    for (let i = 0; i < MAX_PARTICLES; i++) particles.push(new Particle());
    resize();
    window.addEventListener("resize", resize);
    spawnParticles();
    requestAnimationFrame(loop);
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2); // [OPT-8] cap dpr
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.scale(dpr, dpr);
  }

  function spawnParticles() {
    for (let i = 0; i < MAX_PARTICLES; i++) particles[i].active = false;
    const count = Math.min(Config.count, MAX_PARTICLES);
    for (let i = 0; i < count; i++) particles[i].init(W, H);
    Config.activeCount = count;
  }

  function loop(timestamp) {
    requestAnimationFrame(loop);
    if (Config.frozen) return;

    const dt = Math.min((timestamp - lastTime) / 16.67, 3);
    lastTime = timestamp;
    noiseTime += 0.002 * (Config.speed / 50);

    // [OPT-9] Cached bg
    if (Config.palette !== cachedPalKey) {
      cachedBg = Palettes[Config.palette].bg;
      cachedPalKey = Config.palette;
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = cachedBg;
    ctx.fillRect(0, 0, W, H);

    const bloomAlpha = Config.bloom / 100;
    ctx.globalCompositeOperation =
      bloomAlpha > 0.15 ? "lighter" : "source-over";

    const speedMult = Config.speed / 50;
    const gravMult = Config.gravity / 60;
    const maxTrail = Math.ceil(Config.trail);
    const mx = Config.mouse.x,
      my = Config.mouse.y;
    const bass = Config.audioData.bass;
    const treble = Config.audioData.treble;
    const halfW = W / 2,
      halfH = H / 2;
    const doGlow = bloomAlpha > 0.3; // [OPT-3]

    // Rebuild spatial grid for web mode
    if (Config.mode === "web") {
      grid.clear();
      for (let i = 0; i < MAX_PARTICLES; i++) {
        if (particles[i].active) grid.insert(particles[i]);
      }
    }

    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = particles[i];
      if (!p.active) continue;

      p.ax = 0;
      p.ay = 0;

      // Physics
      if (Config.mode === "galaxy") {
        p.orbitAngle += p.orbitSpeed * speedMult * dt;
        n_val = Perlin.noise(
          (p.x / W) * 3 + noiseTime + p.noiseOffset,
          (p.y / H) * 3 + noiseTime * 0.7,
        );
        flowAngle = n_val * Math.PI * 4;
        const tx = halfW + Math.cos(p.orbitAngle) * p.orbitRadius;
        const ty = halfH + Math.sin(p.orbitAngle) * p.orbitRadius;
        p.vx += (tx - p.x) * 0.015 * dt + Math.cos(flowAngle) * 0.3 * speedMult;
        p.vy += (ty - p.y) * 0.015 * dt + Math.sin(flowAngle) * 0.3 * speedMult;
        dx = mx - p.x;
        dy = my - p.y;
        distSq = dx * dx + dy * dy;
        if (distSq < 90000) {
          dist = Math.sqrt(distSq) || 1;
          force = (gravMult * 6000) / distSq;
          p.ax += (dx / dist) * force;
          p.ay += (dy / dist) * force;
        }
        p.orbitRadius += (bass * 30 - p.orbitRadius * 0.01) * 0.05;
      } else if (Config.mode === "web") {
        n_val = Perlin.noise(
          (p.x / W) * 2.5 + noiseTime + p.noiseOffset,
          (p.y / H) * 2.5 + noiseTime * 0.5,
        );
        flowAngle = n_val * Math.PI * 4;
        p.ax += Math.cos(flowAngle) * 0.08 * speedMult;
        p.ay += Math.sin(flowAngle) * 0.08 * speedMult;
        dx = mx - p.x;
        dy = my - p.y;
        distSq = dx * dx + dy * dy;
        if (distSq < 62500) {
          dist = Math.sqrt(distSq) || 1;
          force = (gravMult * 2500) / distSq;
          p.ax += (dx / dist) * force;
          p.ay += (dy / dist) * force;
        }
        if (p.x < 0) p.x = W;
        else if (p.x > W) p.x = 0;
        if (p.y < 0) p.y = H;
        else if (p.y > H) p.y = 0;
      } else {
        dx = mx - p.x;
        dy = my - p.y;
        distSq = dx * dx + dy * dy;
        if (distSq < 160000) {
          dist = Math.sqrt(distSq) || 1;
          force = (gravMult * 3000) / distSq;
          p.ax += (dx / dist) * force;
          p.ay += (dy / dist) * force;
        }
        p.ax += p.vx * treble * 0.5;
        p.ay += p.vy * treble * 0.5;
        p.life -= dt;
        if (p.life <= 0) {
          p.init(W, H);
          continue;
        }
      }

      p.vx = (p.vx + p.ax * dt) * 0.93;
      p.vy = (p.vy + p.ay * dt) * 0.93;
      const vMag = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      const maxV = 6 * speedMult;
      if (vMag > maxV) {
        const inv = maxV / vMag;
        p.vx *= inv;
        p.vy *= inv;
      }

      p.pushTrail(maxTrail);
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      // Render
      const ea = p.alpha * (bloomAlpha * 0.6 + 0.4);
      const r = p.radius + bass * 2;

      // [OPT-2] Trail — single path, globalAlpha, no gradient
      if (p.trailLen > 1) {
        ctx.beginPath();
        ctx.moveTo(p.trail[0], p.trail[1]);
        for (let t = 1; t < p.trailLen; t++)
          ctx.lineTo(p.trail[t * 2], p.trail[t * 2 + 1]);
        ctx.strokeStyle = p.color;
        ctx.globalAlpha = ea * 0.5;
        ctx.lineWidth = r * 0.6;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // Dot
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = ea;
      ctx.fill();
      ctx.globalAlpha = 1;

      // [OPT-3] Glow only when bloom high
      if (doGlow) {
        const gr = r * 3.5;
        const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, gr);
        glow.addColorStop(0, p.color);
        glow.addColorStop(1, "transparent");
        ctx.beginPath();
        ctx.arc(p.x, p.y, gr, 0, Math.PI * 2);
        ctx.fillStyle = glow;
        ctx.globalAlpha = ea * 0.16;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    if (Config.mode === "web") drawWebLines(bloomAlpha);

    updateStats(timestamp);
    if (fpsFrames % 10 === 0)
      SoundEngine.updateAmbient(
        Config.speed / 100,
        Config.activeCount / Math.max(Config.count, 1),
      );
  }

  // [OPT-1] O(n) web lines with spatial grid
  function drawWebLines(bloomAlpha) {
    const DIST_SQ = 110 * 110;
    ctx.globalCompositeOperation = "lighter";
    ctx.lineWidth = 0.6;
    ctx.globalAlpha = 0.22 * bloomAlpha;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = particles[i];
      if (!p.active) continue;
      const neighbors = grid.query(p);
      let conn = 0;
      for (let j = 0; j < neighbors.length; j++) {
        const q = neighbors[j];
        if (q === p || conn >= MAX_CONNECTIONS) continue;
        dx = p.x - q.x;
        dy = p.y - q.y;
        if (dx * dx + dy * dy < DIST_SQ) {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
          ctx.strokeStyle = p.color;
          ctx.stroke();
          conn++;
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  function updateStats(ts) {
    fpsFrames++;
    if (ts - fpsLast > 600) {
      const elapsed = ts - fpsLast;
      const fps = Math.round(fpsFrames / (elapsed / 1000));
      Config.fps = fps;
      document.getElementById("stat-fps").textContent = fps;
      document.getElementById("stat-particles").textContent =
        Config.activeCount;
      fpsFrames = 0;
      fpsLast = ts;

      // [OPT-4] Adaptive particle reduction
      if (fps < 48 && Config.activeCount > 150) {
        Config.activeCount = Math.max(150, Config.activeCount - 80);
        for (let i = Config.activeCount; i < MAX_PARTICLES; i++)
          particles[i].active = false;
        document.getElementById("val-count").textContent = Config.activeCount;
        document.getElementById("ctrl-count").value = Config.activeCount;
      }
    }
  }

  function explodeAt(x, y) {
    SoundEngine.playExplode(x, W);
    const pal = Palettes[Config.palette];
    const count = 55;
    let spawned = 0;
    for (let i = 0; i < MAX_PARTICLES && spawned < count; i++) {
      const p = particles[i];
      if (p.active) continue;
      p.active = true;
      const angle = (spawned / count) * Math.PI * 2 + Math.random() * 0.5;
      const spd = 2 + Math.random() * 7;
      p.x = x + (Math.random() - 0.5) * 20;
      p.y = y + (Math.random() - 0.5) * 20;
      p.vx = Math.cos(angle) * spd;
      p.vy = Math.sin(angle) * spd;
      p.radius = Config.size * 0.5 + Math.random() * Config.size * 2;
      p.color = pal.colors[Math.floor(Math.random() * pal.colors.length)];
      p.alpha = 0.92;
      p.life = 60 + Math.random() * 80;
      p.trailLen = 0;
      p.ax = 0;
      p.ay = 0;
      spawned++;
    }
  }

  return { init, spawnParticles, explodeAt };
})();

/* ============================================================
   8. AUDIO ANALYZER — Mic FFT
   ============================================================ */
const AudioAnalyzer = (() => {
  let audioCtx = null,
    analyser = null,
    dataArray = null,
    source = null;
  let active = false;

  async function start() {
    if (active) return;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      dataArray = new Uint8Array(analyser.frequencyBinCount);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);
      active = true;
      document.getElementById("audio-status").style.display = "flex";
      tick();
    } catch (e) {
      console.warn("Mic denied:", e);
      document.getElementById("ctrl-audio").checked = false;
    }
  }

  function stop() {
    if (!active) return;
    if (source) source.disconnect();
    if (audioCtx) audioCtx.close();
    active = false;
    Config.audioData.bass = Config.audioData.mid = Config.audioData.treble = 0;
    document.getElementById("audio-status").style.display = "none";
    updateBars(0, 0, 0);
  }

  function tick() {
    if (!active) return;
    requestAnimationFrame(tick);
    analyser.getByteFrequencyData(dataArray);
    const n = dataArray.length;
    let bass = 0,
      mid = 0,
      treble = 0;
    for (let i = 0; i < 11; i++) bass += dataArray[i];
    for (let i = 11; i < 41; i++) mid += dataArray[i];
    for (let i = 41; i < n; i++) treble += dataArray[i];
    Config.audioData.bass = bass / (11 * 255);
    Config.audioData.mid = mid / (30 * 255);
    Config.audioData.treble = treble / ((n - 41) * 255);
    updateBars(
      Config.audioData.bass,
      Config.audioData.mid,
      Config.audioData.treble,
    );
  }

  function updateBars(b, m, t) {
    document.getElementById("abar-bass").style.height = b * 40 + "px";
    document.getElementById("abar-mid").style.height = m * 40 + "px";
    document.getElementById("abar-treble").style.height = t * 40 + "px";
  }

  return { start, stop };
})();

/* ============================================================
   9. ANIMATION PRESETS
   ============================================================ */
const AnimationPresets = {
  cosmos: {
    mode: "galaxy",
    palette: "void",
    count: 1200,
    gravity: 20,
    speed: 22,
    size: 1.5,
    trail: 35,
    bloom: 90,
  },
  storm: {
    mode: "explosion",
    palette: "cyberpunk",
    count: 1000,
    gravity: 80,
    speed: 85,
    size: 2.5,
    trail: 20,
    bloom: 95,
  },
  synaptic: {
    mode: "web",
    palette: "aurora",
    count: 600,
    gravity: 45,
    speed: 35,
    size: 1.5,
    trail: 8,
    bloom: 60,
  },
  inferno: {
    mode: "explosion",
    palette: "fire",
    count: 1500,
    gravity: 130,
    speed: 95,
    size: 3,
    trail: 30,
    bloom: 100,
  },
  deepsea: {
    mode: "web",
    palette: "ocean",
    count: 700,
    gravity: 30,
    speed: 20,
    size: 2,
    trail: 45,
    bloom: 55,
  },
  void: {
    mode: "galaxy",
    palette: "void",
    count: 900,
    gravity: 150,
    speed: 60,
    size: 1,
    trail: 12,
    bloom: 80,
  },
};

function applyPreset(key) {
  const preset = AnimationPresets[key];
  if (!preset) return;

  SoundEngine.playWhoosh();

  const flash = document.createElement("div");
  flash.className = "preset-flash";
  document.body.appendChild(flash);
  flash.addEventListener("animationend", () => flash.remove());

  Object.assign(Config, {
    mode: preset.mode,
    palette: preset.palette,
    count: preset.count,
    gravity: preset.gravity,
    speed: preset.speed,
    size: preset.size,
    trail: preset.trail,
    bloom: preset.bloom,
  });

  const sync = (id, valId, v) => {
    const el = document.getElementById(id);
    if (el) el.value = v;
    const ve = document.getElementById(valId);
    if (ve)
      ve.textContent =
        typeof v === "number" && !Number.isInteger(v) ? v.toFixed(1) : v;
  };
  sync("ctrl-count", "val-count", preset.count);
  sync("ctrl-gravity", "val-gravity", preset.gravity);
  sync("ctrl-speed", "val-speed", preset.speed);
  sync("ctrl-size", "val-size", preset.size);
  sync("ctrl-trail", "val-trail", preset.trail);
  sync("ctrl-bloom", "val-bloom", preset.bloom);

  document
    .querySelectorAll(".mode-btn")
    .forEach((b) =>
      b.classList.toggle("mode-btn--active", b.dataset.mode === preset.mode),
    );
  document.getElementById("stat-mode").textContent = preset.mode.toUpperCase();
  document
    .querySelectorAll(".palette-btn")
    .forEach((b) =>
      b.classList.toggle(
        "palette-btn--active",
        b.dataset.palette === preset.palette,
      ),
    );
  document
    .querySelectorAll(".preset-btn")
    .forEach((b) =>
      b.classList.toggle("preset-btn--active", b.dataset.preset === key),
    );

  ParticleSystem.spawnParticles();
}

/* ============================================================
   10. UI
   ============================================================ */
const UI = (() => {
  function init() {
    // Mouse tracking + custom cursor
    document.addEventListener("mousemove", (e) => {
      Config.mouse.x = e.clientX;
      Config.mouse.y = e.clientY;
      document.body.style.setProperty("--cx", e.clientX + "px");
      document.body.style.setProperty("--cy", e.clientY + "px");
    });

    // Click → explode (sound handled inside explodeAt)
    document.getElementById("canvas").addEventListener("click", (e) => {
      const ripple = document.createElement("div");
      ripple.className = "ripple";
      ripple.style.cssText = `left:${e.clientX}px;top:${e.clientY}px;width:30px;height:30px`;
      document.body.appendChild(ripple);
      ripple.addEventListener("animationend", () => ripple.remove());
      ParticleSystem.explodeAt(e.clientX, e.clientY);
    });

    // Scroll → size
    window.addEventListener(
      "wheel",
      (e) => {
        Config.size = Math.max(
          1,
          Math.min(8, Config.size + (e.deltaY > 0 ? 0.3 : -0.3)),
        );
        document.getElementById("ctrl-size").value = Config.size;
        document.getElementById("val-size").textContent =
          Config.size.toFixed(1);
      },
      { passive: true },
    );

    // Space → freeze
    window.addEventListener("keydown", (e) => {
      if (e.code === "Space") {
        e.preventDefault();
        Config.frozen = !Config.frozen;
        SoundEngine.playFreeze(Config.frozen);
      }
    });

    // Mode buttons
    document.querySelectorAll(".mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        Config.mode = btn.dataset.mode;
        document
          .querySelectorAll(".mode-btn")
          .forEach((b) => b.classList.remove("mode-btn--active"));
        btn.classList.add("mode-btn--active");
        document.getElementById("stat-mode").textContent =
          Config.mode.toUpperCase();
        SoundEngine.playWhoosh();
        ParticleSystem.spawnParticles();
      });
      btn.addEventListener("mouseenter", () => SoundEngine.playTick());
    });

    // Palette buttons
    document.querySelectorAll(".palette-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        Config.palette = btn.dataset.palette;
        document
          .querySelectorAll(".palette-btn")
          .forEach((b) => b.classList.remove("palette-btn--active"));
        btn.classList.add("palette-btn--active");
        SoundEngine.playTick();
        ParticleSystem.spawnParticles();
      });
    });

    // Sliders
    const sliders = [
      ["ctrl-count", "val-count", "count", true],
      ["ctrl-gravity", "val-gravity", "gravity", false],
      ["ctrl-speed", "val-speed", "speed", false],
      ["ctrl-size", "val-size", "size", false],
      ["ctrl-trail", "val-trail", "trail", false],
      ["ctrl-bloom", "val-bloom", "bloom", false],
    ];
    sliders.forEach(([id, valId, key, respawn]) => {
      const el = document.getElementById(id);
      const ve = document.getElementById(valId);
      el.addEventListener("input", () => {
        const v = +el.value;
        Config[key] = v;
        ve.textContent = Number.isInteger(v) ? v : v.toFixed(1);
        if (respawn) ParticleSystem.spawnParticles();
      });
    });

    // Mic audio
    document.getElementById("ctrl-audio").addEventListener("change", (e) => {
      if (e.target.checked) AudioAnalyzer.start();
      else AudioAnalyzer.stop();
    });

    // Sound FX toggle (injected dynamically)
    addSoundToggle();

    // Preset buttons
    document.querySelectorAll(".preset-btn").forEach((btn) => {
      btn.addEventListener("click", () => applyPreset(btn.dataset.preset));
      btn.addEventListener("mouseenter", () => SoundEngine.playTick());
    });

    // Screenshot
    document.getElementById("btn-screenshot").addEventListener("click", () => {
      SoundEngine.playTick();
      const link = document.createElement("a");
      link.download = "kinetic-soul-" + Date.now() + ".png";
      link.href = document.getElementById("canvas").toDataURL("image/png");
      link.click();
    });

    // Reset
    document.getElementById("btn-reset").addEventListener("click", () => {
      SoundEngine.playWhoosh();
      const d = {
        gravity: 60,
        speed: 50,
        size: 2,
        trail: 15,
        bloom: 70,
        count: 800,
      };
      Object.assign(Config, d);
      [
        ["ctrl-gravity", "val-gravity", "gravity"],
        ["ctrl-speed", "val-speed", "speed"],
        ["ctrl-size", "val-size", "size"],
        ["ctrl-trail", "val-trail", "trail"],
        ["ctrl-bloom", "val-bloom", "bloom"],
        ["ctrl-count", "val-count", "count"],
      ].forEach(([id, vid, k]) => {
        document.getElementById(id).value = d[k];
        document.getElementById(vid).textContent = d[k];
      });
      ParticleSystem.spawnParticles();
    });
  }

  function addSoundToggle() {
    const audioLabels = document.querySelector(".audio-labels");
    if (!audioLabels) return;
    const row = document.createElement("div");
    row.className = "toggle-row";
    row.style.marginTop = "6px";
    row.innerHTML = `
      <span class="toggle-label">SOUND FX</span>
      <label class="toggle">
        <input type="checkbox" id="ctrl-sound" checked />
        <span class="toggle__track"><span class="toggle__thumb"></span></span>
      </label>`;
    audioLabels.insertAdjacentElement("afterend", row);
    document.getElementById("ctrl-sound").addEventListener("change", (e) => {
      Config.soundEnabled = e.target.checked;
      SoundEngine.setMasterVolume(e.target.checked ? 1 : 0);
    });
  }

  return { init };
})();

/* ============================================================
   11. BOOTSTRAP
   ============================================================ */
window.addEventListener("DOMContentLoaded", () => {
  ParticleSystem.init();
  UI.init();
  // Prime AudioContext on first user gesture (autoplay policy)
  window.addEventListener("mousemove", () => SoundEngine.ensure(), {
    once: true,
  });
});
