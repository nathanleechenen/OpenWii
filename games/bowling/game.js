import { consumeLaunchSplash } from '../../core/splash.js';

// Carry the menu's launch banner across the navigation, then fade it out.
consumeLaunchSplash();
import { createChannel } from '../../core/channel.js';
import { SwingDetector } from '../../core/gesture.js';
import {
  Bowling, throwFromSwing, isForwardSwing, frameMarks, startXFromAim,
  LANE_HALF, HEAD_Z, PIT_Z, BALL_R, FRAMES, PIN_SPACING, ROW_DZ, rackPins,
} from './logic.js';

/**
 * Bowling — renderer and input wiring. A chase camera behind the ball over a
 * perspective-projected lane, drawn on a plain 2D canvas. All rules live in
 * logic.js; this file maps the remote onto them and draws.
 *
 * The remote does two things. Its sideways position slides the ball along the
 * foul line (frozen while you swing, so the backswing can't nudge your
 * aim). The forward-and-up swing releases it: swing speed → ball speed,
 * sideways lean of the swing → heading.
 */

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d');

const bowl = new Bowling({ onEvent: handleEvent });
let started = false;

// Some grips read the forward swing the other way round; I flips it.
let flip = false;
try { flip = localStorage.getItem('openwii.bowling.flip') === '1'; } catch { /* private mode */ }

// ── Input ──────────────────────────────────────────────────────────────────
const swing = new SwingDetector({ onThreshold: 120, offThreshold: 55, minTravel: 30, maxMs: 700 });
let targetX = 0;          // where the ball wants to sit on the foul line
let ballX = 0;            // …and where it's drawn (smoothed)
let holdUntil = 0;        // after a rejected swing (the backswing), keep the aim
let wrongWay = 0;         // consecutive swings in the opposite direction

const channel = createChannel({
  onA: () => {
    if (!started || bowl.state === 'done') { startGame(); return; }
    // Desk fallback: with no remote paired, A / click throws a steady ball.
    if (bowl.state === 'ready' && !channel.pointer.live) {
      bowl.throwBall({ x: ballX, speed: 6.8, heading: 0 });
    }
  },
  onSample: (sample, dt, now) => {
    const s = swing.update(channel.pointer.rateDps, dt, now);
    if (s && started && bowl.state === 'ready') handleSwing(s, now);
  },
});
const audio = channel.audio;

function handleSwing(s, now) {
  if (!isForwardSwing(s.angle, flip)) {
    holdUntil = now + 1500;                // that was the backswing: keep the line-up
    const vertical = Math.abs(Math.sin(s.angle)) > 0.7;
    wrongWay = vertical ? wrongWay + 1 : 0;
    if (wrongWay >= 3) say('Swing UP to throw — press I if that feels backwards');
    return;
  }
  wrongWay = 0;
  // The line-up is already frozen in ballX; the swing decides speed and heading.
  bowl.throwBall({ ...throwFromSwing(s, 0.5), x: ballX });
}

addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== 'i') return;
  flip = !flip;
  try { localStorage.setItem('openwii.bowling.flip', flip ? '1' : '0'); } catch { /* ignore */ }
  say(flip ? 'Swing direction flipped: swing DOWN to throw' : 'Swing direction normal: swing UP to throw');
});

// ── Sounds (all synthesised) ───────────────────────────────────────────────
audio.register('bw-throw', (a) => {
  a.noise({ dur: 0.3, gain: 0.2, type: 'lowpass', freq: 1400 });
  a.tone({ freq: 220, slideTo: 90, dur: 0.25, type: 'sine', gain: 0.16, attack: 0.01 });
});
audio.register('bw-pin', (a) => {
  a.noise({ dur: 0.05, gain: 0.3, type: 'highpass', freq: 2600 });
  a.tone({ freq: 920, slideTo: 560, dur: 0.07, type: 'triangle', gain: 0.18, attack: 0.001 });
});
audio.register('bw-strike', (a) => {
  [523, 659, 784, 1046].forEach((f, i) => {
    a.tone({ freq: f, dur: 0.35, type: 'triangle', gain: 0.14, attack: 0.005, delay: i * 0.07 });
  });
});
audio.register('bw-spare', (a) => {
  a.tone({ freq: 587, dur: 0.18, type: 'triangle', gain: 0.15, attack: 0.005 });
  a.tone({ freq: 880, dur: 0.3, type: 'triangle', gain: 0.15, attack: 0.005, delay: 0.12 });
});
audio.register('bw-gutter', (a) => {
  a.tone({ freq: 140, slideTo: 55, dur: 0.5, type: 'sine', gain: 0.25, attack: 0.005 });
});
audio.register('bw-end', (a) => {
  [392, 523, 659, 784].forEach((f, i) => {
    a.tone({ freq: f, dur: 0.4, type: 'triangle', gain: 0.14, attack: 0.005, delay: i * 0.12 });
  });
});

// ── HUD ────────────────────────────────────────────────────────────────────
function buildCard() {
  $('card').innerHTML = Array.from({ length: FRAMES }, (_, f) => {
    const boxes = f === FRAMES - 1 ? 3 : 2;
    return `<div class="fr${f === FRAMES - 1 ? ' last' : ''}" id="fr${f}"><div class="n">${f + 1}</div>
      <div class="m">${'<span></span>'.repeat(boxes)}</div><div class="t"></div></div>`;
  }).join('');
}

function renderCard() {
  const { frames, total } = bowl.score;
  frames.forEach((fr, f) => {
    const el = $(`fr${f}`);
    const marks = frameMarks(fr.rolls, f);
    const boxes = el.querySelectorAll('.m span');
    boxes.forEach((b) => { b.textContent = ''; });
    marks.forEach((m, i) => { boxes[i].textContent = m; });   // a strike's X is already in box 2
    el.querySelector('.t').textContent = fr.score ?? '';
    el.classList.toggle('cur', started && bowl.state !== 'done' && f === bowl.frame);
  });
  $('total-n').textContent = total;
}

let bannerTimer = 0;
function banner(text) {
  const el = $('banner');
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => el.classList.remove('on'), 1700);
}

let sayTimer = 0;
function say(text, ms = 2600) {
  $('readout').textContent = text;
  clearTimeout(sayTimer);
  if (ms) sayTimer = setTimeout(() => { $('readout').textContent = ''; }, ms);
}

function startGame() {
  started = true;
  bowl.reset();
  $('overlay').classList.add('hide');
  $('banner').classList.remove('on');
  renderCard();
  say('Line up, then swing up to throw', 4000);
}

let lastPinSound = 0;
function handleEvent(e) {
  if (e.type === 'throw') {
    audio.play('bw-throw');
    channel.feedback({ type: 'slice', combo: 1 });
    const deg = (e.heading * 180) / Math.PI;
    const dir = Math.abs(deg) < 0.15 ? 'straight' : `${Math.abs(deg).toFixed(1)}° ${deg > 0 ? 'right' : 'left'}`;
    say(`${e.speed.toFixed(1)} m/s · ${dir}`, 3500);
  } else if (e.type === 'pinHit') {
    const now = performance.now();
    if (e.strength > 0.8 && now - lastPinSound > 45) { lastPinSound = now; audio.play('bw-pin'); }
  } else if (e.type === 'gutter') {
    audio.play('bw-gutter');
    channel.feedback({ type: 'bomb' });
  } else if (e.type === 'result') {
    const text = {
      strike: 'STRIKE!', spare: 'SPARE!', gutter: 'GUTTER', miss: 'MISS',
    }[e.kind] || `${e.knocked} PIN${e.knocked === 1 ? '' : 'S'}`;
    banner(text);
    if (e.kind === 'strike') { audio.play('bw-strike'); channel.feedback({ type: 'slice', combo: 3 }); }
    else if (e.kind === 'spare') { audio.play('bw-spare'); channel.feedback({ type: 'slice', combo: 2 }); }
    renderCard();
  } else if (e.type === 'ready') {
    $('banner').classList.remove('on');
    say(`Frame ${bowl.frame + 1} · ball ${bowl.ballNo + 1}`, 2500);
    renderCard();
  } else if (e.type === 'done') {
    $('banner').classList.remove('on');
    renderCard();
    audio.play('bw-end');
    channel.feedback({ type: 'slice', combo: 3 });
    $('panel').innerHTML = `<h1>🎳 <em>Game over</em></h1>
      <div><span class="stat"><b>${e.total}</b><span>final score</span></span>
      <span class="stat"><b>${bowl.rolls.filter((r) => r === 10).length}</b><span>strikes</span></span></div>
      <div class="cta"><strong>A</strong> bowl again · <strong>B</strong> menu</div>`;
    $('overlay').classList.remove('hide');
  }
}

// ── Projection ─────────────────────────────────────────────────────────────
let W = 1; let H = 1; let F = 1; let horizon = 0;
const CAM_HOME = { y: 0.85, z: -3.0 };          // behind the foul line
const CAM_PINS_Z = HEAD_Z - 5.2;                  // parked here once the ball is near the pins
const CAM_PINS_Y = 1.45;                          // …and raised, so the rack opens out
const cam = { x: 0, y: CAM_HOME.y, z: CAM_HOME.z };

function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  F = Math.min(W, H * 1.78) * 1.05;
  horizon = H * 0.36;
}
window.addEventListener('resize', layout);

/** World (x right, y up, z down-lane) → [screenX, screenY, scale]. */
function P(x, y, z) {
  const k = F / Math.max(0.25, z - cam.z);
  return [W / 2 + (x - cam.x) * k, horizon + (cam.y - y) * k, k];
}

function poly(pts, fill) {
  ctx.beginPath();
  pts.forEach(([x, y, z], i) => {
    const [sx, sy] = P(x, y, z);
    if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy);
  });
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function line(a, b, color, width, dash) {
  const [x1, y1] = P(...a);
  const [x2, y2] = P(...b);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash || []);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.setLineDash([]);
}

// ── Scene ──────────────────────────────────────────────────────────────────
function drawAlley(now) {
  // Walls and ceiling glow above the horizon, dark floor below.
  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, '#0d0a18');
  sky.addColorStop(1, '#2d1f58');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, horizon + 1);
  ctx.fillStyle = '#16101f';
  ctx.fillRect(0, horizon, W, H - horizon);

  const zA = cam.z + 0.5;
  const zB = PIT_Z + 0.4;

  // Floor either side of the lane.
  poly([[-6, 0, zA], [6, 0, zA], [6, 0, zB], [-6, 0, zB]], '#1d1530');

  // Gutters, slightly sunk.
  for (const s of [-1, 1]) {
    const a = s * LANE_HALF;
    const b = s * (LANE_HALF + 0.16);
    poly([[a, -0.04, zA], [b, -0.04, zA], [b, -0.04, zB], [a, -0.04, zB]], '#2b2342');
    line([a, -0.01, zA], [a, -0.01, zB], '#8c7fc4', 1.5);
  }

  // The lane: lighter approach, glossy wood beyond the foul line.
  const yNear = P(0, 0, zA)[1];
  const yFar = P(0, 0, PIT_Z)[1];
  const wood = ctx.createLinearGradient(0, yNear, 0, yFar);
  wood.addColorStop(0, '#f1c987');
  wood.addColorStop(1, '#b97f3e');
  poly([[-LANE_HALF, 0, Math.max(zA, 0)], [LANE_HALF, 0, Math.max(zA, 0)],
    [LANE_HALF, 0, PIT_Z], [-LANE_HALF, 0, PIT_Z]], wood);
  if (zA < 0) {
    poly([[-LANE_HALF, 0, zA], [LANE_HALF, 0, zA], [LANE_HALF, 0, 0], [-LANE_HALF, 0, 0]], '#f7dba6');
  }
  for (let i = 1; i < 14; i += 1) {
    const x = -LANE_HALF + (i / 14) * LANE_HALF * 2;
    line([x, 0, zA], [x, 0, PIT_Z], 'rgba(80,40,0,0.13)', 1);
  }
  // A soft reflection of the ceiling lights down the middle.
  poly([[-0.16, 0, Math.max(zA, 0)], [0.16, 0, Math.max(zA, 0)], [0.05, 0, PIT_Z], [-0.05, 0, PIT_Z]],
    'rgba(255,255,255,0.1)');

  // Foul line, dots, and the V of arrows.
  line([-LANE_HALF, 0, 0], [LANE_HALF, 0, 0], '#b3392f', 3);
  for (let i = -3; i <= 3; i += 1) {
    const x = i * 0.1;
    const z = 4.6 - Math.abs(i) * 0.22;
    poly([[x, 0, z - 0.2], [x - 0.035, 0, z + 0.2], [x + 0.035, 0, z + 0.2]], 'rgba(60,25,0,0.55)');
    const [dx, dy, dk] = P(x, 0, 2.1);
    ctx.fillStyle = 'rgba(60,25,0,0.5)';
    ctx.beginPath();
    ctx.ellipse(dx, dy, dk * 0.016, dk * 0.006, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // The pit and the masking unit behind the pins.
  poly([[-0.75, 0, PIT_Z], [0.75, 0, PIT_Z], [0.75, 0, zB], [-0.75, 0, zB]], '#07050c');
  poly([[-1.6, 0, zB], [1.6, 0, zB], [1.6, 2.2, zB], [-1.6, 2.2, zB]], '#150f26');
  poly([[-1.6, 1.15, zB], [1.6, 1.15, zB], [1.6, 2.2, zB], [-1.6, 2.2, zB]], '#2f2160');
  const glow = 0.5 + 0.5 * Math.sin(now / 700);
  poly([[-1.2, 1.5, zB], [1.2, 1.5, zB], [1.2, 1.62, zB], [-1.2, 1.62, zB]],
    `rgba(255,107,170,${0.35 + 0.35 * glow})`);
}

function drawPin(p) {
  const H0 = 0.38;
  let top;
  let baseY = 0;
  if (!p.down) {
    top = [p.x, H0, p.z];
  } else {
    const a = Math.min(1, p.downAge / 0.35) * (Math.PI / 2) * 0.96;
    const reach = Math.sin(a) * H0;
    top = [p.x + Math.cos(p.fallDir) * reach, Math.max(0.05, Math.cos(a) * H0), p.z + Math.sin(p.fallDir) * reach];
    baseY = Math.sin(a) * 0.055;
  }
  const [bx, by, k] = P(p.x, baseY, p.z);
  const [tx, ty] = P(...top);
  const w = 0.118 * k;
  // Shadow.
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.ellipse(bx, P(p.x, 0, p.z)[1], w * 0.62, w * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();
  // Body, then the two red neck stripes.
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#f7f3ea';
  ctx.lineWidth = w;
  ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(tx, ty); ctx.stroke();
  ctx.lineCap = 'butt';
  ctx.strokeStyle = '#d33a31';
  ctx.lineWidth = w * 0.62;
  for (const [t0, t1] of [[0.66, 0.7], [0.74, 0.78]]) {
    ctx.beginPath();
    ctx.moveTo(bx + (tx - bx) * t0, by + (ty - by) * t0);
    ctx.lineTo(bx + (tx - bx) * t1, by + (ty - by) * t1);
    ctx.stroke();
  }
}

// Finger holes sit on the ball's surface and roll with it.
const HOLES = [[-0.2, 0.52, -0.83], [0.16, 0.5, -0.85], [0.0, 0.3, -0.95]];
function drawBall(x, z, spin) {
  const [cx, cy, k] = P(x, BALL_R, z);
  const R = BALL_R * k;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(cx, P(x, 0, z)[1], R * 0.95, R * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
  const g = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R * 1.05);
  g.addColorStop(0, '#9a8cf2');
  g.addColorStop(0.5, '#4333b0');
  g.addColorStop(1, '#150f45');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
  const c = Math.cos(spin);
  const s = Math.sin(spin);
  ctx.fillStyle = 'rgba(8,5,30,0.85)';
  for (const [hx, hy, hz] of HOLES) {
    const y2 = hy * c - hz * s;
    const z2 = hy * s + hz * c;
    if (z2 > -0.1) continue;                       // on the far side of the ball
    ctx.beginPath();
    ctx.ellipse(cx + hx * R, cy - y2 * R, R * 0.12, R * 0.12 * -z2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.beginPath();
  ctx.ellipse(cx - R * 0.4, cy - R * 0.5, R * 0.14, R * 0.22, -0.6, 0, Math.PI * 2);
  ctx.fill();
}

// A top-down rack in the corner: which pins are still up. Handy for spares,
// when the real ones are specks at the far end of the lane.
const DECK = rackPins();
function drawDeck() {
  const w = 132;
  const h = 112;
  const x0 = 22;
  const y0 = H - h - 70;
  ctx.fillStyle = 'rgba(27,20,48,0.78)';
  ctx.strokeStyle = '#4a3a7a';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x0, y0, w, h, 12);
  ctx.fill();
  ctx.stroke();
  const standing = new Set(bowl.pins.filter((p) => !p.down && !p.gone).map((p) => p.id));
  for (const d of DECK) {
    const cx = x0 + w / 2 + (d.x / PIN_SPACING) * 27;
    const cy = y0 + h - 22 - ((d.z - HEAD_Z) / ROW_DZ) * 27;   // the head pin faces you
    ctx.beginPath();
    ctx.arc(cx, cy, 9, 0, Math.PI * 2);
    if (standing.has(d.id)) { ctx.fillStyle = '#f7f3ea'; ctx.fill(); }
    else { ctx.strokeStyle = '#5b4d8c'; ctx.lineWidth = 2; ctx.stroke(); }
  }
}

function drawScene(now) {
  drawAlley(now);

  // Pins and ball, far to near, so they overlap correctly.
  const items = bowl.pins.filter((p) => !p.gone).map((p) => ({ z: p.z, draw: () => drawPin(p) }));
  const b = bowl.ball;
  if (bowl.state === 'ready') {
    items.push({ z: 0, draw: () => drawBall(ballX, 0, 0) });
  } else if (b.z < PIT_Z + 0.3) {
    items.push({ z: b.z, draw: () => drawBall(b.x, b.z, b.z / BALL_R) });
  }
  items.sort((a, c) => c.z - a.z).forEach((it) => it.draw());

  drawDeck();

  // Aim line: where a dead-straight throw from here would go.
  if (bowl.state === 'ready' && started) {
    line([ballX, 0.01, 0.3], [ballX, 0.01, HEAD_Z - 0.4], 'rgba(255,255,255,0.4)', 2, [9, 11]);
  }
}

// ── Loop ───────────────────────────────────────────────────────────────────
let last = performance.now();
const dbg = $('debug');
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  const aim = channel.poll(now);
  if (started) bowl.update(dt);

  // Line-up follows the remote, except while a swing is under way.
  if (bowl.state === 'ready' && !swing.active && now > holdUntil) targetX = startXFromAim(aim.x);
  ballX += (targetX - ballX) * Math.min(1, dt * 14);

  // Chase camera: behind the ball on the way down, parked at the pins.
  const wantZ = bowl.state === 'ready'
    ? CAM_HOME.z : Math.min(CAM_PINS_Z, Math.max(CAM_HOME.z, bowl.ball.z - 3.0));
  cam.z += (wantZ - cam.z) * Math.min(1, dt * 5);
  const rise = Math.min(1, Math.max(0, (cam.z - CAM_HOME.z) / (CAM_PINS_Z - CAM_HOME.z)));
  cam.y = CAM_HOME.y + (CAM_PINS_Y - CAM_HOME.y) * rise;
  horizon = H * (0.36 - 0.24 * rise);               // tilt down toward the rack
  cam.x += ((bowl.state === 'ready' ? ballX : bowl.ball.x) * 0.3 - cam.x) * Math.min(1, dt * 4);

  drawScene(now);

  if (dbg.classList.contains('on')) {
    dbg.textContent = `state ${bowl.state} · frame ${bowl.frame + 1} ball ${bowl.ballNo + 1}\n`
      + `standing ${bowl.standing} · rolls ${bowl.rolls.join(',')}\n`
      + `flip ${flip} · swing ${swing.active ? 'active' : 'idle'} · aimX ${ballX.toFixed(2)}\n`
      + `rate ${channel.pointer.rateDps.yaw.toFixed(0)} / ${channel.pointer.rateDps.pitch.toFixed(0)} °/s\n`
      + `gyro map  ${channel.pointer.describeMap()}\n`
      + `sensor    ${channel.link.rate.toFixed(0)} Hz`;
  }
}

// Dev console hook: drive a throw without a remote.
window.__debug = { bowl, swing, channel: () => channel, handleSwing, startGame, cam: () => cam, aimX: () => ballX };

buildCard();
renderCard();
layout();
requestAnimationFrame(frame);
