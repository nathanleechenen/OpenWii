import { consumeLaunchSplash } from '../../core/splash.js';

// Carry the menu's launch banner across the navigation, then fade it out.
consumeLaunchSplash();
import { createPlayersChannel } from './input.js';
import {
  Range, FIELD_W, FIELD_H, ROUND_MS, GOLD_POINTS, BOMB_PENALTY, MAX_PLAYERS,
  balloonPoints,
} from './logic.js';

/**
 * Shooting Range — renderer. A sunny Wii Play meadow filling the whole
 * screen: blue sky, drifting clouds, rolling grass, targets popping over
 * the field. The crosshair trails sparkle dust; A fires. Two players share
 * the field, each with their own phone, crosshair and score — first shot
 * takes the target. All rules live in logic.js; this file only draws.
 */

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d');

const range = new Range({ onEvent: handleEvent });

// Per-player look. P1 keeps the original red reticle.
const PLAYERS = [
  { name: 'P1', color: '#e2483d', pop: '#ff8a80', trail: '#ffd2cc' },
  { name: 'P2', color: '#2f7de1', pop: '#8cc2ff', trail: '#bfe6ff' },
];
const REMATCH_LOCK_MS = 1200;       // ignore trigger-mashing right after the buzzer
let phase = 'lobby';                // lobby | running | results
let ready = [false, false];         // who has pressed A in the lobby
let connected = [false, false];     // which phones are paired
let doneAt = 0;

// Screen mapping: the FIELD (1.6×1) COVERS the window — full bleed, the
// overflow cropped evenly, so the meadow always fills every pixel.
let view = { x: 0, y: 0, w: 1, h: 1, s: 1 };
let backdrop = null;                 // pre-rendered sky + grass + trees
function layout() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio, 2);
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const s = Math.max(w / FIELD_W, h / FIELD_H);
  view = { x: (w - FIELD_W * s) / 2, y: (h - FIELD_H * s) / 2, w, h, s };
  backdrop = makeBackdrop(w, h);
}
window.addEventListener('resize', layout);

const fx = (x) => view.x + x * view.s;             // field → screen
const fy = (y) => view.y + y * view.s;
const toField = (px, py) => ({                     // pointer [0,1] → field
  x: (px * view.w - view.x) / view.s,
  y: (py * view.h - view.y) / view.s,
});

// ── The meadow, pre-rendered once per resize ───────────────────────────────
const HORIZON = 0.64;                // field y where grass meets sky
function makeBackdrop(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');

  // Sky.
  const sky = g.createLinearGradient(0, 0, 0, fy(HORIZON));
  sky.addColorStop(0, '#4f9de8');
  sky.addColorStop(0.6, '#7cc0f0');
  sky.addColorStop(1, '#c8e9fb');
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);

  // Rolling grass: three bands, each a gentle arc, darker toward the front.
  const bands = [
    { y: HORIZON, bulge: 0.035, c0: '#8fd45e', c1: '#6dbb45' },
    { y: HORIZON + 0.11, bulge: 0.03, c0: '#6ec24c', c1: '#57ad3c' },
    { y: HORIZON + 0.23, bulge: 0.025, c0: '#5bb23e', c1: '#459c31' },
  ];
  for (const b of bands) {
    const top = fy(b.y);
    const grad = g.createLinearGradient(0, top, 0, h);
    grad.addColorStop(0, b.c0);
    grad.addColorStop(1, b.c1);
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(-2, top + view.s * b.bulge);
    g.quadraticCurveTo(w / 2, top - view.s * b.bulge, w + 2, top + view.s * b.bulge);
    g.lineTo(w + 2, h + 2);
    g.lineTo(-2, h + 2);
    g.closePath();
    g.fill();
    // Sparse darker tufts INSIDE the band body, never along the seam.
    g.strokeStyle = 'rgba(30, 80, 20, 0.10)';
    g.lineWidth = 2;
    for (let x = ((top | 0) % 13); x < w; x += 13) {
      const yy = top + view.s * (b.bulge + 0.03) + ((x * 7919) % 97) / 97 * view.s * 0.06;
      g.beginPath();
      g.moveTo(x, yy + 5);
      g.lineTo(x + 1, yy - 4);
      g.stroke();
    }
  }

  // Dirt strip at the very front, like the range's foreground.
  const dirtTop = fy(HORIZON + 0.31);
  const dirt = g.createLinearGradient(0, dirtTop, 0, h);
  dirt.addColorStop(0, '#9a6c42');
  dirt.addColorStop(1, '#7c5433');
  g.fillStyle = dirt;
  g.beginPath();
  g.moveTo(-2, dirtTop + view.s * 0.02);
  g.quadraticCurveTo(w / 2, dirtTop - view.s * 0.02, w + 2, dirtTop + view.s * 0.02);
  g.lineTo(w + 2, h + 2);
  g.lineTo(-2, h + 2);
  g.closePath();
  g.fill();

  // A bushy tree at each side of the horizon.
  const tree = (cx, scale) => {
    const ty = fy(HORIZON + 0.045);   // planted in the grass, not floating
    g.fillStyle = '#6b4a2c';
    g.fillRect(cx - 5 * scale, ty - 34 * scale, 10 * scale, 36 * scale);
    for (const [dx, dy, r, col] of [
      [0, -52, 30, '#3f8f34'], [-24, -40, 22, '#4a9c3d'], [24, -40, 22, '#357f2c'],
      [-10, -62, 20, '#4a9c3d'], [12, -60, 19, '#3f8f34'],
    ]) {
      g.fillStyle = col;
      g.beginPath();
      g.arc(cx + dx * scale, ty + dy * scale, r * scale, 0, Math.PI * 2);
      g.fill();
    }
  };
  tree(fx(0.09), view.s / 700);
  tree(fx(1.52), view.s / 800);
  void 0;

  return c;
}

// ── Clouds: puffy clusters drifting across the sky ─────────────────────────
const clouds = [];
for (let i = 0; i < 6; i += 1) {
  clouds.push({
    x: Math.random() * 1.8 - 0.1,
    y: 0.06 + Math.random() * 0.34,
    s: 0.5 + Math.random() * 0.8,
    v: 0.006 + Math.random() * 0.008,
  });
}
function drawCloud(cl) {
  const x = fx(cl.x);
  const y = fy(cl.y);
  const u = view.s * 0.05 * cl.s;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  for (const [dx, dy, r] of [[0, 0, 1.5], [-1.6, 0.3, 1.05], [1.6, 0.3, 1.1],
    [-0.7, -0.75, 1.1], [0.8, -0.7, 1.0], [-2.6, 0.55, 0.7], [2.7, 0.55, 0.75]]) {
    ctx.beginPath();
    ctx.arc(x + dx * u, y + dy * u, r * u, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(190,215,240,0.55)';
  ctx.beginPath();
  ctx.ellipse(x, y + u * 0.95, u * 3.1, u * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();
}

// ── Tall flowing grass: rows of blades swaying in the wind ─────────────────
// Blades live in field coordinates so they survive resizes untouched. The
// front fringe draws OVER the targets for depth; the rest sits behind them.
function makeBlades(yBase, count, hMin, hMax, color) {
  const blades = [];
  for (let i = 0; i < count; i += 1) {
    blades.push({
      x: -0.1 + ((i + Math.random() * 0.8) / count) * 1.8,
      yBase: yBase + (Math.random() - 0.5) * 0.02,
      h: hMin + Math.random() * (hMax - hMin),
      w: 0.012 + Math.random() * 0.008,
      lean: (Math.random() - 0.5) * 0.02,
      phase: Math.random() * Math.PI * 2,
      speed: 0.8 + Math.random() * 0.7,
    });
  }
  return { blades, color };
}
const GRASS_ROWS = [
  makeBlades(0.685, 72, 0.03, 0.05, '#79c04f'),
  makeBlades(0.79, 60, 0.045, 0.075, '#58ab3a'),
  makeBlades(0.9, 50, 0.06, 0.095, '#47962e'),
];
const GRASS_FRINGE = makeBlades(0.975, 44, 0.09, 0.13, '#3b8527');

function drawGrassRow(row, now) {
  // One gust for everyone, plus each blade's own flutter.
  const gust = Math.sin(now / 2600) * 0.6 + 0.4 * Math.sin(now / 1100);
  ctx.fillStyle = row.color;
  ctx.beginPath();
  for (const b of row.blades) {
    const sway = b.lean + (gust + Math.sin(now / 900 * b.speed + b.phase) * 0.5) * 0.018;
    const bx = fx(b.x);
    const by = fy(b.yBase);
    const tipX = fx(b.x + sway);
    const tipY = fy(b.yBase - b.h);
    const w2 = Math.max(1.2, (b.w * view.s) / 2);
    const midY = by - (by - tipY) * 0.55;
    ctx.moveTo(bx - w2, by);
    ctx.quadraticCurveTo(bx - w2 * 0.3 + (tipX - bx) * 0.35, midY, tipX, tipY);
    ctx.quadraticCurveTo(bx + w2 * 0.3 + (tipX - bx) * 0.35, midY, bx + w2, by);
    ctx.closePath();
  }
  ctx.fill();
}

// ── Transient effects ──────────────────────────────────────────────────────
const popups = [];      // { x, y, text, color, age }
const stars = [];       // { x, y, vx, vy, age, life, size, color }
const booms = [];       // { x, y, age }
const trails = [[], []];   // per player: recent crosshair points for the ribbon
let shake = 0;
const flashAges = [1, 1];
const aims = [{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }];

function starBurst(x, y, color, n = 8, speed = 0.3) {
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
    const v = speed * (0.5 + Math.random() * 0.8);
    stars.push({
      x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.1,
      age: 0, life: 0.55 + Math.random() * 0.25,
      size: 0.012 + Math.random() * 0.012, color,
    });
  }
}

function drawStar(x, y, r, color, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.translate(x, y);
  ctx.beginPath();
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2;
    const rad = i % 2 === 0 ? r : r * 0.38;
    ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ── Wiring ─────────────────────────────────────────────────────────────────
const channel = createPlayersChannel({
  players: MAX_PLAYERS,
  onA: (slot) => {
    if (phase === 'running') { fire(slot); return; }
    if (phase === 'results') {
      if (performance.now() - doneAt < REMATCH_LOCK_MS) return;
      phase = 'lobby';                       // rematch: everyone readies up again
      ready = [false, false];
    }
    ready[slot] = true;
    maybeStart();
  },
  onSolo: () => {
    if (phase === 'running') return;
    if (phase === 'results') {
      if (performance.now() - doneAt < REMATCH_LOCK_MS) return;
      phase = 'lobby';
      ready = [false, false];
    }
    ready[0] = true;
    startRound(ready[1] ? 2 : 1);            // Space = go now with whoever is in
  },
  onPresence: (c) => {
    connected = c;
    syncLink();
    if (phase === 'lobby') renderLobby();
  },
});

// Dev console hook: inspect targets and the field mapping from the console.
window.__debug = { range, view: () => view, aims: () => aims, channel: () => channel };

function syncLink() {
  const dot = $('dot');
  if (dot) dot.classList.toggle('on', connected.some(Boolean));
  const label = $('link-t');
  if (label) {
    label.textContent = connected.some(Boolean)
      ? `P1 ${connected[0] ? '●' : '○'}  P2 ${connected[1] ? '●' : '○'}`
      : 'no remote connected';
  }
}

// ── Sound design ───────────────────────────────────────────────────────────
// Every cue can be replaced by dropping a file at audio/<name>.{mp3,wav,ogg}.
const { audio } = channel;

// The shot: a dry gun pop.
audio.register('sr-shot', (a) => {
  a.noise({ dur: 0.06, gain: 0.3, type: 'highpass', freq: 1800 });
  a.tone({ freq: 190, slideTo: 70, dur: 0.08, type: 'square', gain: 0.22, attack: 0.001 });
});

// A wooden target breaking apart.
audio.register('sr-break', (a) => {
  a.noise({ dur: 0.12, gain: 0.28, type: 'bandpass', freq: 950, q: 1.6 });
  a.tone({ freq: 420, slideTo: 210, dur: 0.1, type: 'triangle', gain: 0.16 });
  a.noise({ dur: 0.07, gain: 0.14, type: 'highpass', freq: 2600, delay: 0.03 });
});

// The gold target: a two-note chime with shimmer.
audio.register('sr-gold', (a) => {
  a.tone({ freq: 1318, dur: 0.16, type: 'sine', gain: 0.2 });
  a.tone({ freq: 1760, dur: 0.3, type: 'sine', gain: 0.18, delay: 0.09 });
  a.tone({ freq: 2637, dur: 0.24, type: 'sine', gain: 0.07, delay: 0.12 });
});

// The bomb: a proper blast.
audio.register('sr-bomb', (a) => {
  a.noise({ dur: 0.5, gain: 0.5, freq: 2400, sweepTo: 100 });
  a.tone({ freq: 100, slideTo: 36, dur: 0.45, type: 'sine', gain: 0.5, attack: 0.002 });
  a.noise({ dur: 0.15, gain: 0.2, type: 'bandpass', freq: 1600, q: 2, delay: 0.05 });
});

// A balloon bursting: a rubbery snap with a quick falling blip.
audio.register('sr-pop', (a) => {
  a.noise({ dur: 0.05, gain: 0.34, type: 'highpass', freq: 3200 });
  a.tone({ freq: 760, slideTo: 180, dur: 0.09, type: 'sine', gain: 0.24, attack: 0.001 });
  a.tone({ freq: 1500, slideTo: 900, dur: 0.05, type: 'triangle', gain: 0.1, delay: 0.015 });
});

// A clean whiff for a missed shot.
audio.register('sr-miss', (a) => {
  a.noise({ dur: 0.08, gain: 0.08, type: 'bandpass', freq: 700, q: 1 });
});

// End of round: a referee's two-tone whistle.
audio.register('sr-end', (a) => {
  a.tone({ freq: 1180, dur: 0.18, type: 'square', gain: 0.12 });
  a.tone({ freq: 880, dur: 0.34, type: 'square', gain: 0.12, delay: 0.2 });
});

/** Everyone who is connected has to be ready; with nobody paired (desk test) the first click starts. */
function maybeStart() {
  const waitingOn = [0, 1].filter((i) => connected[i] && !ready[i]);
  if ((ready[0] || ready[1]) && !waitingOn.length) startRound(ready[1] ? 2 : 1);
  else renderLobby();
}

function startRound(players) {
  phase = 'running';
  ready = [false, false];
  range.start(performance.now(), players);
  popups.length = 0;
  stars.length = 0;
  booms.length = 0;
  trails.forEach((t) => { t.length = 0; });
  $('card2').style.display = players > 1 ? '' : 'none';
  $('score').textContent = '0';
  $('score2').textContent = '0';
  $('overlay').classList.add('hide');
}

function fire(slot) {
  if (range.state !== 'running' || slot >= range.playerCount) return;
  if (slot === 0 && !channel.pointers[0].live && channel.mouse.active) {
    aims[0] = { x: channel.mouse.x, y: channel.mouse.y };
  }
  const p = toField(aims[slot].x, aims[slot].y);
  flashAges[slot] = 0;
  audio.play('sr-shot');
  channel.feedback(slot, { type: 'slice', combo: 1 });
  range.shoot(p.x, p.y, performance.now(), slot);
}

// ── Lobby + results panels ─────────────────────────────────────────────────
function slotLine(i) {
  const name = PLAYERS[i].name;
  const cls = `slot p${i + 1}`;
  if (ready[i]) return `<span class="${cls} ready">${name} ✓ ready</span>`;
  if (connected[i]) return `<span class="${cls}">${name} · press <strong>A</strong></span>`;
  return `<span class="${cls} off">${name} · no phone yet</span>`;
}

function renderLobby() {
  $('panel').innerHTML = `<h1>🎯 <em>Shooting Range</em></h1>
    <p>Two players, one meadow, sixty seconds. The first shot to land takes the
       target. Gold pays big, balloons pay more the higher they float — but
       they escape off the top — and bombs cost you.</p>
    <div class="slots">${slotLine(0)}${slotLine(1)}</div>
    <div class="cta"><strong>A</strong> on each phone to join · <strong>Space</strong> to start now ·
      <strong>B</strong> menu</div>`;
  $('overlay').classList.remove('hide');
}

function playerColumn(i, st, won) {
  const pct = Math.round(st.accuracy * 100);
  return `<div class="pcol p${i + 1}${won ? ' won' : ''}">
    <div class="pname">${PLAYERS[i].name}${won ? ' 🏆' : ''}</div>
    <div class="pscore">${st.score}</div>
    <div class="pline">${st.hits}/${st.shots} hits · ${pct}%</div>
    <div class="pline">🎈 ${st.balloons} · 💣 ${st.bombs}</div>
  </div>`;
}

function renderResults(e) {
  let body;
  if (range.playerCount < 2) {
    const pct = Math.round(e.accuracy * 100);
    body = `<h1>🎯 <em>Time!</em></h1>
      <div>
        <span class="stat"><b>${e.score}</b><span>score</span></span>
        <span class="stat"><b>${e.hits}/${e.shots}</b><span>hits</span></span>
        <span class="stat"><b>${pct}%</b><span>accuracy</span></span>
        <span class="stat"><b>${e.players[0].balloons}</b><span>balloons</span></span>
        <span class="stat"><b>${e.bombs}</b><span>bombs hit</span></span>
      </div>`;
  } else {
    const title = e.winner === -1
      ? '🤝 <em>Tie!</em>' : `🏆 <em>${PLAYERS[e.winner].name} wins!</em>`;
    body = `<h1>${title}</h1>
      <div class="pcols">${e.players.map((st, i) => playerColumn(i, st, e.winner === i)).join('')}</div>`;
  }
  $('panel').innerHTML = `${body}
    <div class="cta"><strong>A</strong> rematch · <strong>B</strong> menu</div>`;
  $('overlay').classList.remove('hide');
}

function handleEvent(e) {
  const who = PLAYERS[e.player] || PLAYERS[0];
  if (e.type === 'hit') {
    const gold = e.kind === 'gold';
    const balloon = e.kind === 'balloon';
    const burst = balloon ? BALLOON_COLORS[e.target.variant].base : gold ? '#ffd75e' : '#ffffff';
    starBurst(e.target.x, e.target.y, burst, balloon ? 14 : gold ? 12 : 8);
    popups.push({
      x: e.target.x, y: e.target.y - e.target.r, text: `+${e.points}`,
      color: range.playerCount > 1 ? who.pop : gold ? '#ffd75e' : '#ffffff', age: 0,
    });
    audio.play(balloon ? 'sr-pop' : gold ? 'sr-gold' : 'sr-break');
  } else if (e.type === 'bombHit') {
    booms.push({ x: e.target.x, y: e.target.y, age: 0 });
    popups.push({
      x: e.target.x, y: e.target.y - e.target.r, text: `-${e.penalty}`,
      color: '#ff5040', age: 0,
    });
    shake = 1;
    audio.play('sr-bomb');
    channel.feedback(e.player, { type: 'bomb' });
  } else if (e.type === 'miss') {
    starBurst(e.x, e.y, '#dfe9f2', 3, 0.12);
    audio.play('sr-miss');
  } else if (e.type === 'done') {
    phase = 'results';
    doneAt = performance.now();
    $('clock').textContent = '0.0s';
    renderResults(e);
    audio.play('sr-end');
    // Winners (or everyone, on a tie / solo) get the big buzz; the loser a small one.
    for (let i = 0; i < range.playerCount; i += 1) {
      const big = e.winner === null || e.winner === -1 || e.winner === i;
      channel.feedback(i, { type: 'slice', combo: big ? 3 : 1 });
    }
  }
}

// ── Target painting ────────────────────────────────────────────────────────
function drawTarget(t, now) {
  const age = now - t.bornMs;
  const left = t.expiresMs - now;
  let k = Math.min(1, age / 160);
  k = 1 - (1 - k) * (1 - k);
  if (left < 350) k *= Math.max(0, left / 350);
  if (k <= 0) return;

  const x = fx(t.x);
  const y = fy(t.y);
  const r = t.r * view.s * k;

  const ring = (rr, color) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r * rr, 0, Math.PI * 2);
    ctx.fill();
  };

  if (t.kind === 'bomb') {
    ring(1.06, '#f4f7fa');
    ring(1, '#3a3f46');
    ring(0.82, '#ff8c3a');
    ring(0.68, '#3a3f46');
    // The bomb: black ball, fuse, spark.
    ring(0.42, '#14171c');
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.arc(x - r * 0.14, y - r * 0.16, r * 0.13, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#c9a36a';
    ctx.lineWidth = Math.max(2, r * 0.07);
    ctx.beginPath();
    ctx.moveTo(x + r * 0.1, y - r * 0.38);
    ctx.quadraticCurveTo(x + r * 0.34, y - r * 0.62, x + r * 0.2, y - r * 0.74);
    ctx.stroke();
    drawStar(x + r * 0.2, y - r * 0.78, r * 0.14,
      Math.floor(now / 90) % 2 ? '#ffd75e' : '#ff8c3a', 1);
  } else if (t.kind === 'gold') {
    ring(1.1, '#fff6da');
    ring(1, '#f2b53a');
    ring(0.66, '#fff6da');
    ring(0.34, '#e2483d');
    // Glint.
    drawStar(x - r * 0.55, y - r * 0.55, r * 0.28,
      '#ffffff', 0.6 + 0.4 * Math.sin(now / 160 + t.phase));
  } else {
    ring(1.06, '#f4f7fa');
    ring(1, '#22262b');
    ring(0.66, '#f4f7fa');
    ring(0.34, '#e2483d');
  }
}

const BALLOON_COLORS = [
  { base: '#e2483d', hi: '#ff9b90', dark: '#a82a22' },
  { base: '#f2b53a', hi: '#ffe49a', dark: '#b8821a' },
  { base: '#3ab36a', hi: '#a4ecbd', dark: '#1f7a45' },
  { base: '#8a5ad8', hi: '#cdb4ff', dark: '#5b34a0' },
];

/** A glossy balloon with a knot, a wavy string, and what it's worth right now. */
function drawBalloon(b, now) {
  const c = BALLOON_COLORS[b.variant];
  const x = fx(b.x);
  const y = fy(b.y);
  const r = b.r * view.s;
  const bob = Math.sin(now / 320 + b.phase);

  // String first, so the body sits on top of it.
  ctx.strokeStyle = 'rgba(40,55,35,0.55)';
  ctx.lineWidth = Math.max(1.5, r * 0.05);
  ctx.lineCap = 'round';
  ctx.beginPath();
  const ky = y + r * 1.18;
  ctx.moveTo(x, ky);
  ctx.bezierCurveTo(x - r * 0.35 * bob, ky + r * 0.8, x + r * 0.35 * bob, ky + r * 1.5,
    x - r * 0.15 * bob, ky + r * 2.4);
  ctx.stroke();

  // Knot.
  ctx.fillStyle = c.dark;
  ctx.beginPath();
  ctx.moveTo(x, y + r * 1.04);
  ctx.lineTo(x - r * 0.16, y + r * 1.26);
  ctx.lineTo(x + r * 0.16, y + r * 1.26);
  ctx.closePath();
  ctx.fill();

  // Body: slightly taller than the hit circle, which covers its middle.
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.45, r * 0.1, x, y, r * 1.25);
  g.addColorStop(0, c.hi);
  g.addColorStop(0.45, c.base);
  g.addColorStop(1, c.dark);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(x, y - r * 0.06, r * 1.0, r * 1.16, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Shine.
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.ellipse(x - r * 0.4, y - r * 0.5, r * 0.16, r * 0.3, -0.5, 0, Math.PI * 2);
  ctx.fill();

  // Current payout: it grows as the balloon climbs.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `800 ${Math.round(r * 0.62)}px -apple-system, sans-serif`;
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(30,20,20,0.55)';
  const label = String(balloonPoints(b.y));
  ctx.strokeText(label, x, y + r * 0.02);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, x, y + r * 0.02);
  ctx.textBaseline = 'alphabetic';
}

function drawCrosshair(slot, now) {
  const x = aims[slot].x * view.w;
  const y = aims[slot].y * view.h;
  const flashAge = flashAges[slot];
  const r = 0.03 * view.s * (flashAge < 0.08 ? 1.25 : 1);
  const tint = PLAYERS[slot].color;

  // White underlay for contrast, then the player's reticle on top.
  for (const [color, wl] of [['rgba(255,255,255,0.9)', 5], [tint, 2.5]]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = wl;
    ctx.lineCap = 'round';
    // The fine circle.
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    // Four cross ticks with a gap at the middle, crossing the circle.
    ctx.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(x + dx * r * 0.38, y + dy * r * 0.38);
      ctx.lineTo(x + dx * r * 1.18, y + dy * r * 1.18);
    }
    ctx.stroke();
  }
  ctx.fillStyle = tint;
  ctx.beginPath();
  ctx.arc(x, y, 2.2, 0, Math.PI * 2);
  ctx.fill();
  if (twoUp()) {
    // A small tag so each player can find their own reticle.
    ctx.textAlign = 'left';
    ctx.font = `800 ${Math.round(0.028 * view.s)}px -apple-system, sans-serif`;
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.strokeText(PLAYERS[slot].name, x + r * 1.3, y - r * 1.15);
    ctx.fillStyle = tint;
    ctx.fillText(PLAYERS[slot].name, x + r * 1.3, y - r * 1.15);
  }
  if (flashAge < 0.08) {
    ctx.fillStyle = `rgba(255, 240, 190, ${0.5 * (1 - flashAge / 0.08)})`;
    ctx.beginPath();
    ctx.arc(x, y, r * 1.9, 0, Math.PI * 2);
    ctx.fill();
  }
  void now;
}

// Whose crosshair is on screen: the round's players, or whoever is paired in the lobby.
const shown = (i) => (phase === 'running'
  ? i < range.playerCount
  : i === 0 || connected[i] || channel.pointers[i].live);
const twoUp = () => shown(0) && shown(1);

// ── Loop ───────────────────────────────────────────────────────────────────
let last = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  if (dt <= 0) return;

  const polled = channel.poll(now);
  for (let i = 0; i < MAX_PLAYERS; i += 1) {
    if (polled[i]) aims[i] = polled[i];
    flashAges[i] += dt;
  }
  range.update(now);

  // The blade ribbon: remember where each crosshair has just been.
  for (let i = 0; i < MAX_PLAYERS; i += 1) {
    const trail = trails[i];
    if (shown(i)) {
      const f = toField(aims[i].x, aims[i].y);
      trail.push({ x: f.x, y: f.y, ms: now });
    }
    while (trail.length && now - trail[0].ms > 220) trail.shift();
    if (trail.length > 26) trail.shift();
  }

  // Screen shake from bombs.
  shake = Math.max(0, shake - dt * 2.5);
  const jx = shake * (Math.random() - 0.5) * 14;
  const jy = shake * (Math.random() - 0.5) * 14;

  ctx.save();
  ctx.translate(jx, jy);

  ctx.drawImage(backdrop, -2, -2, view.w + 4, view.h + 4);
  for (const cl of clouds) {
    cl.x -= cl.v * dt;
    if (cl.x < -0.35) { cl.x = 1.85; cl.y = 0.06 + Math.random() * 0.34; }
    drawCloud(cl);
  }

  for (const row of GRASS_ROWS) drawGrassRow(row, now);

  for (const t of range.targets) drawTarget(t, now);
  for (const b of range.balloons) drawBalloon(b, now);

  // Bomb explosions: expanding rings of fire and smoke.
  for (let i = booms.length - 1; i >= 0; i -= 1) {
    const b = booms[i];
    b.age += dt;
    const k = b.age / 0.65;
    if (k >= 1) { booms.splice(i, 1); continue; }
    const x = fx(b.x);
    const y = fy(b.y);
    for (const [rr, color, alpha] of [
      [0.16, '#fff3c9', 0.95], [0.11, '#ff9c3a', 0.9], [0.07, '#e2483d', 0.85],
    ]) {
      ctx.globalAlpha = alpha * (1 - k);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, (0.02 + k * rr) * view.s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 0.45 * (1 - k);
    ctx.fillStyle = '#6b6f76';
    for (let s = 0; s < 5; s += 1) {
      const a = (s / 5) * Math.PI * 2 + b.age * 2;
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * k * 0.11 * view.s, y + Math.sin(a) * k * 0.09 * view.s,
        0.028 * view.s * (1 - k * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // The blade ribbon, drawn like Fruit Ninja's: a tapered swoosh — a wide
  // soft blue underlay with a bright white core, fading with age.
  for (let pi = 0; pi < MAX_PLAYERS; pi += 1) {
    const trail = trails[pi];
    if (trail.length < 2) continue;
    for (const [color, base, alphaK] of [
      [PLAYERS[pi].trail, 0.016, 0.4], ['#ffffff', 0.009, 0.85],
    ]) {
      for (let i = 1; i < trail.length; i += 1) {
        const a = trail[i - 1];
        const b = trail[i];
        const age = (now - b.ms) / 220;
        const k = Math.max(0, 1 - age);
        ctx.strokeStyle = color;
        ctx.globalAlpha = alphaK * k;
        ctx.lineWidth = Math.max(1, base * view.s * k);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(fx(a.x), fy(a.y));
        ctx.lineTo(fx(b.x), fy(b.y));
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  // Hit star bursts.
  for (let i = stars.length - 1; i >= 0; i -= 1) {
    const st = stars[i];
    st.age += dt;
    if (st.age >= st.life) { stars.splice(i, 1); continue; }
    st.x += st.vx * dt;
    st.y += st.vy * dt;
    const kk = 1 - st.age / st.life;
    const twinkle = 0.7 + 0.3 * Math.sin(st.age * 30 + st.size * 999);
    drawStar(fx(st.x), fy(st.y), st.size * view.s * kk * twinkle, st.color, kk);
  }

  // Score popups float up and fade.
  ctx.textAlign = 'center';
  for (let i = popups.length - 1; i >= 0; i -= 1) {
    const pp = popups[i];
    pp.age += dt;
    const k = pp.age / 0.85;
    if (k >= 1) { popups.splice(i, 1); continue; }
    ctx.globalAlpha = 1 - k * k;
    ctx.font = `800 ${Math.round(0.052 * view.s)}px -apple-system, sans-serif`;
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(30,45,25,0.55)';
    const yy = fy(pp.y) - k * 0.07 * view.s;
    ctx.strokeText(pp.text, fx(pp.x), yy);
    ctx.fillStyle = pp.color;
    ctx.fillText(pp.text, fx(pp.x), yy);
    ctx.globalAlpha = 1;
  }

  drawGrassRow(GRASS_FRINGE, now);

  for (let i = 0; i < MAX_PLAYERS; i += 1) if (shown(i)) drawCrosshair(i, now);
  ctx.restore();

  if (range.state === 'running') {
    const leftS = Math.max(0, (ROUND_MS - (now - range.startMs)) / 1000);
    $('clock').textContent = `${leftS.toFixed(1)}s`;
    range.stats.forEach((st, i) => {
      $(i ? 'score2' : 'score').textContent = st.score;
      $(i ? 'meta2' : 'meta').textContent = `${st.hits}/${st.shots} hits`;
    });
  }

  const dbg = $('debug');
  if (dbg && dbg.classList.contains('on')) {
    dbg.textContent = `state ${range.state} · phase ${phase}\n`
      + `targets ${range.targets.length} · balloons ${range.balloons.length}\n`
      + `phones ${connected.map((c) => (c ? 'on' : 'off')).join('/')}\n`
      + `gold ${GOLD_POINTS} · bomb -${BOMB_PENALTY}\nshake ${shake.toFixed(2)}`;
  }
}
layout();
requestAnimationFrame(frame);

// Launching from the menu lands in the lobby: each player presses A on their
// phone to join (Space or a click starts a solo round straight away).
syncLink();
renderLobby();
