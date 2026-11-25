import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Bowling, scoreGame, frameMarks, rackPins, startXFromAim, speedFromPeak, leanOf,
  isForwardSwing, headingFromLean, throwFromSwing,
  LANE_HALF, START_X_MAX, MIN_SPEED, MAX_SPEED, PEAK_MIN, PEAK_MAX, HEADING_MAX,
  HEAD_Z, PIN_SPACING, RESULT_MS,
} from './logic.js';

const DT = 1 / 60;

/** Run the sim until the current throw has been scored (state 'result'). */
function rollOut(b, maxSteps = 60 * 40) {
  for (let i = 0; i < maxSteps && !['result', 'done'].includes(b.state); i += 1) b.update(DT);
}
/** Step through the result pause into the next throw. */
function advance(b) {
  for (let i = 0; i < 60 * 5 && b.state === 'result'; i += 1) b.update(DT);
}
/** Throw, then knock `n` standing pins down mid-roll — for flow tests. */
function throwKnocking(b, n) {
  b.throwBall({ x: 0, speed: 6, heading: 0 });
  b.ball.active = false;                                  // no real ball: only the forced pins fall
  b.pins.filter((p) => !p.down && !p.gone).slice(0, n).forEach((p) => { p.down = true; });
  rollOut(b);
  advance(b);
}
const gutterBall = { x: 0, speed: 6, heading: HEADING_MAX };

// ── Scoring ────────────────────────────────────────────────────────────────

test('scoring: a perfect game is 300', () => {
  assert.equal(scoreGame(Array(12).fill(10)).total, 300);
});

test('scoring: all gutters is 0, all 5-spares is 150', () => {
  assert.equal(scoreGame(Array(20).fill(0)).total, 0);
  assert.equal(scoreGame(Array(21).fill(5)).total, 150);
});

test('scoring: the classic worked example comes to 167', () => {
  const rolls = [10, 7, 3, 9, 0, 10, 0, 8, 8, 2, 0, 6, 10, 10, 10, 8, 1];
  const { frames, total } = scoreGame(rolls);
  assert.equal(total, 167);
  assert.deepEqual(frames.map((f) => f.score), [20, 39, 48, 66, 74, 84, 90, 120, 148, 167]);
});

test('scoring: a frame waits (null) until its bonus balls are rolled', () => {
  let s = scoreGame([10]);
  assert.equal(s.frames[0].score, null);
  assert.equal(s.total, 0);
  s = scoreGame([10, 7, 3]);
  assert.deepEqual(s.frames.slice(0, 2).map((f) => f.score), [20, null]);
  assert.equal(s.total, 20);
  s = scoreGame([3, 4, 5]);
  assert.deepEqual(s.frames.slice(0, 2).map((f) => f.score), [7, null]);
});

test('scoring: a null frame holds back every frame after it', () => {
  const s = scoreGame([10, 5, 5, 3]);        // strike, spare, then a lone 3
  assert.deepEqual(s.frames.slice(0, 3).map((f) => f.score), [20, 33, null]);
});

test('scoring: tenth frame — open takes 2 balls, strike/spare take 3', () => {
  const nine = Array(18).fill(0);
  assert.equal(scoreGame([...nine, 3, 4]).total, 7);
  assert.equal(scoreGame([...nine, 3]).frames[9].score, null);
  assert.equal(scoreGame([...nine, 10, 10, 10]).total, 30);
  assert.equal(scoreGame([...nine, 7, 3, 5]).total, 15);
  assert.equal(scoreGame([...nine, 7, 3]).frames[9].score, null, 'spare still owes a ball');
});

test('marks: X, /, - and digits, strike right-aligned in frames 1–9', () => {
  assert.deepEqual(frameMarks([10], 0), ['', 'X']);
  assert.deepEqual(frameMarks([7, 3], 1), ['7', '/']);
  assert.deepEqual(frameMarks([0, 9], 2), ['-', '9']);
  assert.deepEqual(frameMarks([10, 10, 5], 9), ['X', 'X', '5']);
  assert.deepEqual(frameMarks([3, 7, 10], 9), ['3', '/', 'X']);
  assert.deepEqual(frameMarks([10, 0, 10], 9), ['X', '-', '/']);
});

// ── Swing → throw mapping ──────────────────────────────────────────────────

test('mapping: swing speed → ball speed, clamped and monotone', () => {
  assert.equal(speedFromPeak(0), MIN_SPEED);
  assert.equal(speedFromPeak(PEAK_MIN), MIN_SPEED);
  assert.equal(speedFromPeak(PEAK_MAX), MAX_SPEED);
  assert.equal(speedFromPeak(5000), MAX_SPEED);
  let prev = 0;
  for (let p = 0; p <= 700; p += 10) {
    const s = speedFromPeak(p);
    assert.ok(s >= prev);
    prev = s;
  }
});

test('mapping: lean is 0 straight up, + to the right, − to the left', () => {
  const UP = -Math.PI / 2;
  assert.ok(Math.abs(leanOf(UP)) < 1e-9);
  assert.ok(leanOf(UP + 0.2) > 0.19 && leanOf(UP + 0.2) < 0.21);
  assert.ok(leanOf(UP - 0.2) < -0.19);
  // A downward swing that drifts right is still "right".
  assert.ok(leanOf(Math.PI / 2 - 0.2) > 0);
});

test('mapping: only an upward, mostly-vertical swing counts as a throw', () => {
  const UP = -Math.PI / 2;
  assert.equal(isForwardSwing(UP), true);
  assert.equal(isForwardSwing(UP + 0.5), true, 'a bit of lean is fine');
  assert.equal(isForwardSwing(Math.PI / 2), false, 'the backswing');
  assert.equal(isForwardSwing(0), false, 'a sideways flick');
  assert.equal(isForwardSwing(Math.PI), false);
  assert.equal(isForwardSwing(UP + 1.5), false, 'too flat');
  assert.equal(isForwardSwing(Math.PI / 2, true), true, 'flip accepts down');
  assert.equal(isForwardSwing(UP, true), false);
});

test('mapping: heading follows lean and is capped before it leaves the lane', () => {
  assert.equal(headingFromLean(0), 0);
  assert.ok(headingFromLean(0.2) > 0 && headingFromLean(-0.2) < 0);
  assert.equal(headingFromLean(5), HEADING_MAX);
  assert.equal(headingFromLean(-5), -HEADING_MAX);
});

test('mapping: pointer position slides the ball along the foul line', () => {
  assert.equal(startXFromAim(0.5), 0);
  assert.ok(startXFromAim(0.8) > 0 && startXFromAim(0.2) < 0);
  assert.equal(startXFromAim(2), START_X_MAX);
  assert.equal(startXFromAim(-2), -START_X_MAX);
});

test('mapping: throwFromSwing bundles all three', () => {
  const t = throwFromSwing({ peak: PEAK_MAX, angle: -Math.PI / 2 + 0.1 }, 0.6);
  assert.equal(t.speed, MAX_SPEED);
  assert.ok(t.heading > 0 && t.x > 0);
});

// ── Pins ───────────────────────────────────────────────────────────────────

test('rack: ten pins in a real triangle, head pin first', () => {
  const pins = rackPins();
  assert.equal(pins.length, 10);
  assert.deepEqual([pins[0].x, pins[0].z], [0, HEAD_Z]);
  assert.deepEqual(pins.map((p) => p.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(Math.abs(pins[1].x - -PIN_SPACING / 2) < 1e-9);
  assert.ok(Math.abs(pins[9].x - 1.5 * PIN_SPACING) < 1e-9);
  for (const p of pins) assert.ok(Math.abs(p.x) < LANE_HALF);
});

// ── Physics ────────────────────────────────────────────────────────────────

test('physics: a ball into the pocket takes most of the pins', () => {
  const b = new Bowling();
  b.throwBall({ x: 0.07, speed: 7, heading: 0 });
  rollOut(b);
  assert.ok(10 - b.standing >= 8, `knocked ${10 - b.standing}`);
});

test('physics: a ball aimed off the lane ends in the gutter and scores nothing', () => {
  const events = [];
  const b = new Bowling({ onEvent: (e) => events.push(e) });
  b.throwBall(gutterBall);
  rollOut(b);
  assert.equal(10 - b.standing, 0);
  assert.equal(b.lastResult.kind, 'gutter');
  assert.ok(events.some((e) => e.type === 'gutter'));
});

test('physics: a faster ball gets there sooner', () => {
  const arrival = (speed) => {
    const b = new Bowling();
    b.throwBall({ x: 0, speed, heading: 0 });
    let t = 0;
    while (b.ball.z < HEAD_Z - 0.3 && t < 20) { b.update(DT); t += DT; }
    return t;
  };
  assert.ok(arrival(9) < arrival(5) * 0.7);
});

test('physics: the ball is only thrown from "ready", and only once', () => {
  const b = new Bowling();
  assert.equal(b.throwBall({ x: 0, speed: 6, heading: 0 }), true);
  assert.equal(b.throwBall({ x: 0, speed: 6, heading: 0 }), false);
});

test('physics: pin collisions stay inside the lane — nothing explodes', () => {
  const b = new Bowling();
  b.throwBall({ x: 0.1, speed: 9.5, heading: 0 });
  for (let i = 0; i < 60 * 8; i += 1) {
    b.update(DT);
    for (const p of b.pins) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z));
      assert.ok(Math.hypot(p.vx, p.vz) < 40, 'no runaway pin speed');
    }
  }
});

test('physics: nothing moves while waiting for a throw', () => {
  const b = new Bowling();
  const before = JSON.stringify(b.pins);
  for (let i = 0; i < 120; i += 1) b.update(DT);
  assert.equal(JSON.stringify(b.pins), before);
  assert.equal(b.state, 'ready');
});

// ── Game flow ──────────────────────────────────────────────────────────────

test('flow: a strike ends the frame and the next one starts on a fresh rack', () => {
  const events = [];
  const b = new Bowling({ onEvent: (e) => events.push(e) });
  throwKnocking(b, 10);
  assert.equal(events.find((e) => e.type === 'result').kind, 'strike');
  assert.equal([b.frame, b.ballNo, b.standing].join(), '1,0,10');
  assert.deepEqual(b.rolls, [10]);
});

test('flow: an open frame takes two balls and keeps the standing pins between them', () => {
  const b = new Bowling();
  throwKnocking(b, 4);
  assert.equal([b.frame, b.ballNo, b.standing].join(), '0,1,6');
  assert.equal(b.pins.length, 6, 'knocked pins are swept');
  for (const p of b.pins) assert.deepEqual([p.x, p.z], [p.spot.x, p.spot.z]);
  throwKnocking(b, 2);
  assert.equal([b.frame, b.ballNo, b.standing].join(), '1,0,10');
  assert.deepEqual(b.rolls, [4, 2]);
});

test('flow: a spare is reported as one', () => {
  const events = [];
  const b = new Bowling({ onEvent: (e) => events.push(e) });
  throwKnocking(b, 6);
  throwKnocking(b, 4);
  assert.equal(events.filter((e) => e.type === 'result')[1].kind, 'spare');
});

test('flow: ten gutter-ball frames end the game at 0', () => {
  const events = [];
  const b = new Bowling({ onEvent: (e) => events.push(e) });
  for (let i = 0; i < 20; i += 1) {
    assert.equal(b.state, 'ready', `throw ${i}`);
    b.throwBall(gutterBall);
    rollOut(b);
    advance(b);
  }
  assert.equal(b.state, 'done');
  assert.equal(b.score.total, 0);
  assert.equal(events.at(-1).type, 'done');
});

test('flow: tenth frame — strike earns two more balls and a fresh rack', () => {
  const b = new Bowling();
  for (let i = 0; i < 18; i += 1) throwKnocking(b, 0);   // nine empty frames
  assert.equal(b.frame, 9);
  throwKnocking(b, 10);                                   // strike
  assert.equal([b.state, b.ballNo, b.standing].join(), 'ready,1,10');
  throwKnocking(b, 10);                                   // another
  assert.equal([b.state, b.ballNo, b.standing].join(), 'ready,2,10');
  throwKnocking(b, 7);                                    // fill ball
  assert.equal(b.state, 'done');
  assert.equal(b.score.total, 27);
});

test('flow: tenth frame — a spare earns one more ball, an open frame none', () => {
  const spare = new Bowling();
  for (let i = 0; i < 18; i += 1) throwKnocking(spare, 0);
  throwKnocking(spare, 3);
  throwKnocking(spare, 7);
  assert.equal([spare.state, spare.ballNo, spare.standing].join(), 'ready,2,10');
  throwKnocking(spare, 5);
  assert.equal(spare.state, 'done');
  assert.equal(spare.score.total, 15);

  const open = new Bowling();
  for (let i = 0; i < 18; i += 1) throwKnocking(open, 0);
  throwKnocking(open, 3);
  throwKnocking(open, 4);
  assert.equal(open.state, 'done');
  assert.equal(open.score.total, 7);
});

test('flow: the result screen holds for RESULT_MS, then the lane is ready again', () => {
  const b = new Bowling();
  b.throwBall({ x: 0.07, speed: 7, heading: 0 });
  rollOut(b);
  assert.equal(b.state, 'result');
  for (let t = 0; t < RESULT_MS - 100; t += 16) b.update(0.016);
  assert.equal(b.state, 'result');
  for (let t = 0; t < 300; t += 16) b.update(0.016);
  assert.equal(b.state, 'ready');
});

test('flow: a real full game of pocket balls finishes and the books balance', () => {
  const b = new Bowling();
  let throws = 0;
  while (b.state !== 'done' && throws < 30) {
    b.throwBall({ x: 0.07, speed: 7, heading: 0 });
    rollOut(b);
    advance(b);
    throws += 1;
  }
  assert.equal(b.state, 'done');
  assert.ok(throws >= 11 && throws <= 21);
  assert.equal(b.score.total, scoreGame(b.rolls).total);
  assert.ok(b.score.total > 80, `a steady player scores something (${b.score.total})`);
});
