/**
 * Bowling — lane physics, throw mapping and scoring. No renderer, no DOM.
 *
 * Top-down 2D in metres: x across the lane (0 = centre), z down the lane from
 * the foul line (z = 0) to the head pin (z = HEAD_Z). The remote does two
 * things: its sideways position lines up the ball on the foul line, and the
 * SWING releases it — swing speed becomes ball speed, and the sideways lean of
 * the swing path becomes the ball's heading.
 *
 * Pins are knocked by circle collisions (ball→pin, pin→pin); a downed pin
 * keeps sliding and can take others with it. Scoring is standard ten-pin.
 */

// ── Lane geometry (real tenpin proportions) ────────────────────────────────
export const LANE_HALF = 0.53;           // half of the 1.06 m lane
export const GUTTER_X = LANE_HALF + 0.07;
export const HEAD_Z = 18.29;             // foul line → head pin, 60 ft
export const PIN_SPACING = 0.3048;       // 12 in, centre to centre
export const ROW_DZ = 0.264;             // row spacing (12 in × cos 30°)
export const PIT_Z = 19.45;              // past this, pins and ball are gone
export const SIDE_OUT_X = 0.66;          // pins knocked past the lane edge

export const BALL_R = 0.109;
export const BALL_MASS = 6;
export const PIN_R = 0.07;               // collision radius (a bit generous)
export const PIN_MASS = 1.5;
export const E_BALL_PIN = 0.55;
export const E_PIN_PIN = 0.75;
export const TOPPLE_SPEED = 0.2;         // m/s of approach that knocks a pin over
export const SLIDE_DECEL = 2.4;          // 1/s velocity decay of a sliding pin
export const REST_SPEED = 0.06;

// ── Swing → throw mapping ──────────────────────────────────────────────────
export const PEAK_MIN = 150;             // deg/s of swing for the softest throw
export const PEAK_MAX = 540;             // …and for a full-power throw
export const MIN_SPEED = 3.5;            // m/s
export const MAX_SPEED = 9.5;
export const HEADING_GAIN = 0.075;       // radians of heading per radian of lean
export const HEADING_MAX = 0.045;        // ~0.8 m of drift by the pins: gutter
export const START_X_MAX = 0.42;         // ball centre limit on the foul line
export const START_X_RANGE = 0.9;        // pointer 0..1 → ±0.45 m
export const FORWARD_CONE = 1.3;         // rad: swings leaning further are ignored

// ── Timing ─────────────────────────────────────────────────────────────────
export const SETTLE_MIN_MS = 700;
export const SETTLE_MAX_MS = 3200;
export const ROLL_MAX_MS = 12_000;
export const RESULT_MS = 2_000;
export const FRAMES = 10;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Pointer x in [0,1] → where the ball sits on the foul line. */
export function startXFromAim(aimX) {
  return clamp((aimX - 0.5) * START_X_RANGE, -START_X_MAX, START_X_MAX);
}

/** Swing peak rate (deg/s) → ball speed (m/s). */
export function speedFromPeak(peakDps) {
  const k = clamp((peakDps - PEAK_MIN) / (PEAK_MAX - PEAK_MIN), 0, 1);
  return MIN_SPEED + (MAX_SPEED - MIN_SPEED) * k;
}

/**
 * Sideways lean of a swing: 0 for a swing straight up (or straight down),
 * + toward the right. `angle` is the SwingDetector's cursor-space direction
 * (x right, y down), so up is −π/2.
 */
export function leanOf(angle) {
  return Math.atan2(Math.cos(angle), Math.abs(Math.sin(angle)));
}

/**
 * Is this the forward swing of a bowling arm? Up and mostly vertical counts;
 * the backswing (down) and sideways flicks don't. `flip` accepts down instead,
 * for a grip where the forward swing reads the other way.
 */
export function isForwardSwing(angle, flip = false) {
  const up = Math.sin(angle) < 0;
  return (flip ? !up : up) && Math.abs(leanOf(angle)) < FORWARD_CONE;
}

/** Ball heading in radians, + = toward +x (right). */
export function headingFromLean(lean) {
  return clamp(lean * HEADING_GAIN, -HEADING_MAX, HEADING_MAX);
}

/** Everything the remote decides about one throw. */
export function throwFromSwing({ peak, angle }, aimX) {
  return {
    x: startXFromAim(aimX),
    speed: speedFromPeak(peak),
    heading: headingFromLean(leanOf(angle)),
  };
}

// ── Scoring ────────────────────────────────────────────────────────────────

/**
 * Standard ten-pin scoring from the flat list of pins knocked per throw.
 * Returns { frames: [{ rolls, score }], total }. A frame's cumulative `score`
 * is null until its strike/spare bonus has been rolled.
 */
export function scoreGame(rolls) {
  const frames = [];
  let i = 0;
  let running = 0;
  let known = true;
  for (let f = 0; f < FRAMES; f += 1) {
    const a = rolls[i];
    if (a === undefined) { frames.push({ rolls: [], score: null }); known = false; continue; }
    let fr;
    let pts = null;
    if (f < FRAMES - 1) {
      if (a === 10) {
        const b = rolls[i + 1];
        const c = rolls[i + 2];
        fr = [10];
        if (b !== undefined && c !== undefined) pts = 10 + b + c;
        i += 1;
      } else {
        const b = rolls[i + 1];
        if (b === undefined) fr = [a];
        else {
          fr = [a, b];
          if (a + b === 10) { const c = rolls[i + 2]; if (c !== undefined) pts = 10 + c; }
          else pts = a + b;
        }
        i += fr.length;
      }
    } else {
      fr = rolls.slice(i, i + 3);
      const third = fr[0] === 10 || (fr.length > 1 && fr[0] + fr[1] === 10);
      if (fr.length === (third ? 3 : 2)) pts = fr.reduce((s, r) => s + r, 0);
    }
    if (pts === null) known = false;
    frames.push({ rolls: fr, score: known ? (running += pts) : null });
  }
  return { frames, total: running };
}

/** Scorecard marks for one frame: ['', 'X'], ['7', '/'], ['-', '3'], … */
export function frameMarks(rolls, f) {
  const marks = rolls.map((r, i) => {
    // Spare first: in the tenth, a 10 after a 0 is a spare, not a strike.
    if (i > 0 && rolls[i - 1] !== 10 && rolls[i - 1] + r === 10) return '/';
    if (r === 10) return 'X';
    return r === 0 ? '-' : String(r);
  });
  if (f < FRAMES - 1 && marks.length === 1 && marks[0] === 'X') return ['', 'X'];
  return marks;
}

// ── Pins ───────────────────────────────────────────────────────────────────

/** The ten-pin triangle, numbered 1 (head pin) to 10 like a real rack. */
export function rackPins() {
  const pins = [];
  let id = 1;
  for (let row = 0; row < 4; row += 1) {
    for (let k = 0; k <= row; k += 1) {
      const x = (k - row / 2) * PIN_SPACING;
      const z = HEAD_Z + row * ROW_DZ;
      pins.push({
        id: id++, x, z, vx: 0, vz: 0, r: PIN_R, m: PIN_MASS,
        spot: { x, z }, down: false, gone: false, fallDir: 0, downAge: 0,
      });
    }
  }
  return pins;
}

/** Circle-circle impulse. Returns the approach speed (0 if they don't hit). */
function collide(a, b, e) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const d = Math.hypot(dx, dz);
  const rr = a.r + b.r;
  if (d >= rr || d === 0) return 0;
  const nx = dx / d;
  const nz = dz / d;
  const ia = 1 / a.m;
  const ib = 1 / b.m;
  const push = (rr - d) / (ia + ib);
  a.x -= nx * push * ia; a.z -= nz * push * ia;
  b.x += nx * push * ib; b.z += nz * push * ib;
  const vrel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
  if (vrel >= 0) return 0;
  const j = (-(1 + e) * vrel) / (ia + ib);
  a.vx -= j * ia * nx; a.vz -= j * ia * nz;
  b.vx += j * ib * nx; b.vz += j * ib * nz;
  return -vrel;
}

export class Bowling {
  constructor({ onEvent = () => {} } = {}) {
    this.onEvent = onEvent;
    this.reset();
  }

  reset() {
    this.state = 'ready';            // ready | rolling | settling | result | done
    this.stateMs = 0;
    this.frame = 0;                  // 0..9
    this.ballNo = 0;                 // throw within the frame
    this.rolls = [];                 // pins per throw, whole game
    this.frameRolls = [];
    this.pins = rackPins();
    this.ball = this.freshBall();
    this.standingBefore = 10;
    this.next = null;
    this.lastResult = null;
  }

  freshBall() {
    return {
      x: 0, z: 0, vx: 0, vz: 0, r: BALL_R, m: BALL_MASS, active: false, gutter: false,
    };
  }

  get standing() { return this.pins.filter((p) => !p.down && !p.gone).length; }
  get score() { return scoreGame(this.rolls); }

  setState(s) { this.state = s; this.stateMs = 0; }

  /** Release the ball. Only valid while waiting for a throw. */
  throwBall({ x = 0, speed = 6, heading = 0 } = {}) {
    if (this.state !== 'ready') return false;
    this.ball = {
      ...this.freshBall(), x: clamp(x, -START_X_MAX, START_X_MAX), active: true,
      vx: Math.sin(heading) * speed, vz: Math.cos(heading) * speed,
    };
    this.standingBefore = this.standing;
    this.setState('rolling');
    this.onEvent({ type: 'throw', x: this.ball.x, speed, heading });
    return true;
  }

  update(dt) {
    if (this.state === 'ready' || this.state === 'done') return;
    const step = Math.min(dt, 0.1);
    this.stateMs += step * 1000;
    if (this.state === 'rolling' || this.state === 'settling') {
      let left = step;
      while (left > 1e-9) { const h = Math.min(left, 1 / 240); this.physics(h); left -= h; }
      for (const p of this.pins) if (p.down) p.downAge += step;
    }

    if (this.state === 'rolling') {
      const b = this.ball;
      const stalled = b.active && Math.hypot(b.vx, b.vz) < 0.25;
      if (!b.active || stalled || this.stateMs > ROLL_MAX_MS) {
        b.active = false;
        this.setState('settling');
      }
    } else if (this.state === 'settling') {
      const moving = this.pins.some((p) => !p.gone && Math.hypot(p.vx, p.vz) > REST_SPEED);
      if ((!moving && this.stateMs >= SETTLE_MIN_MS) || this.stateMs >= SETTLE_MAX_MS) {
        this.finishRoll();
      }
    } else if (this.state === 'result' && this.stateMs >= RESULT_MS) {
      this.advance();
    }
  }

  physics(dt) {
    const b = this.ball;
    if (b.active) {
      b.x += b.vx * dt;
      b.z += b.vz * dt;
      if (!b.gutter && Math.abs(b.x) > LANE_HALF) {
        b.gutter = true;                       // dropped into the channel
        b.x = Math.sign(b.x) * GUTTER_X;
        b.vx = 0;
        this.onEvent({ type: 'gutter' });
      }
      if (b.gutter) { b.vz *= 1 - 0.1 * dt; }
      if (b.z > PIT_Z + 0.3) b.active = false;
    }

    const fric = Math.max(0, 1 - SLIDE_DECEL * dt);
    for (const p of this.pins) {
      if (p.gone) continue;
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      if (p.down) { p.vx *= fric; p.vz *= fric; }
      if (p.z > PIT_Z || Math.abs(p.x) > SIDE_OUT_X) { p.gone = true; p.down = true; }
    }

    if (b.active && !b.gutter) {
      for (const p of this.pins) {
        if (p.gone) continue;
        const hit = collide(b, p, E_BALL_PIN);
        if (hit) this.knock(p, hit, b.x, b.z);
      }
    }
    for (let i = 0; i < this.pins.length; i += 1) {
      const a = this.pins[i];
      if (a.gone) continue;
      for (let j = i + 1; j < this.pins.length; j += 1) {
        const c = this.pins[j];
        if (c.gone) continue;
        const hit = collide(a, c, E_PIN_PIN);
        if (hit) { this.knock(a, hit, c.x, c.z); this.knock(c, hit, a.x, a.z); }
      }
    }
  }

  /** A pin took a hit of `speed` from something at (fromX, fromZ). */
  knock(pin, speed, fromX, fromZ) {
    if (speed > 0.3) this.onEvent({ type: 'pinHit', strength: speed, x: pin.x, z: pin.z });
    if (pin.down || speed < TOPPLE_SPEED) return;
    pin.down = true;
    pin.downAge = 0;
    const speedAfter = Math.hypot(pin.vx, pin.vz);
    pin.fallDir = speedAfter > 0.05
      ? Math.atan2(pin.vz, pin.vx) : Math.atan2(pin.z - fromZ, pin.x - fromX);
  }

  finishRoll() {
    const knocked = this.standingBefore - this.standing;
    const standing = this.standing;
    const f = this.frame;
    const k = this.ballNo;
    this.rolls.push(knocked);
    this.frameRolls.push(knocked);
    const fr = this.frameRolls;

    let kind = 'pins';
    if (knocked === 0) kind = this.ball.gutter ? 'gutter' : 'miss';
    else if (standing === 0) kind = this.standingBefore === 10 ? 'strike' : 'spare';

    // What comes next?
    let frameEnds = false;
    let over = false;
    let rerack = false;
    if (f < FRAMES - 1) {
      frameEnds = standing === 0 || k === 1;
      rerack = frameEnds;
    } else if (k === 0) {
      rerack = knocked === 10;
    } else if (k === 1) {
      if (fr[0] === 10) rerack = knocked === 10;
      else if (fr[0] + knocked === 10) rerack = true;
      else over = true;
    } else {
      over = true;
    }

    this.next = { frameEnds, over, rerack };
    this.lastResult = { kind, knocked, standing, frame: f, ballNo: k };
    this.setState('result');
    this.onEvent({ type: 'result', ...this.lastResult, total: this.score.total });
  }

  advance() {
    const n = this.next;
    if (n.over || (n.frameEnds && this.frame === FRAMES - 1)) {
      this.setState('done');
      this.onEvent({ type: 'done', total: this.score.total, frames: this.score.frames });
      return;
    }
    if (n.frameEnds) { this.frame += 1; this.ballNo = 0; this.frameRolls = []; }
    else this.ballNo += 1;

    if (n.rerack) this.pins = rackPins();
    else {
      this.pins = this.pins.filter((p) => !p.down && !p.gone);
      for (const p of this.pins) { p.x = p.spot.x; p.z = p.spot.z; p.vx = 0; p.vz = 0; }
    }
    this.ball = this.freshBall();
    this.setState('ready');
    this.onEvent({
      type: 'ready', frame: this.frame, ballNo: this.ballNo, standing: this.standing,
    });
  }
}
