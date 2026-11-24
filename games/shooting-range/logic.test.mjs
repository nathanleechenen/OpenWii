import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Range, pointsFor, FIELD_W, FIELD_H, ROUND_MS, MAX_ALIVE,
  NORMAL_R_MIN, NORMAL_R_MAX, GOLD_R_MIN, GOLD_R_MAX, BOMB_R,
  GOLD_POINTS, BOMB_PENALTY, GOLD_SWAY_HZ, TARGET_TTL_MS,
  SPAWN_COLS, SPAWN_ROWS, SPAWN_X0, SPAWN_X1, SPAWN_Y0, SPAWN_Y1,
  balloonPoints, BALLOON_R, BALLOON_START_Y, BALLOON_FULL_Y, BALLOON_RISE,
  BALLOON_POINTS_MIN, BALLOON_POINTS_MAX, BALLOON_MAX_ALIVE, BALLOON_FIRST_MS,
} from './logic.js';
import { mulberry32 } from '../alien-attack/logic.js';

/** Spawn until the rigged rng yields a target of the wanted kind. */
function spawnKind(range, kind, now = 0) {
  for (let i = 0; i < 200; i += 1) {
    const t = range.spawn(now);
    if (t.kind === kind) return t;
    range.targets.pop();              // discard the wrong kind
  }
  throw new Error(`no ${kind} in 200 spawns`);
}

// S1 — hit geometry, unchanged by the type system.
test('S1: a shot inside the radius destroys the target, outside misses', () => {
  const r = new Range({ rng: mulberry32(3) });
  r.start(0);
  const t = spawnKind(r, 'normal');
  const inside = t.r / Math.SQRT2 - 1e-4;
  assert.equal(r.shoot(t.x + inside, t.y + inside, 10).hit, true);
  assert.equal(r.targets.length, 0, 'the hit target is gone');

  const t2 = spawnKind(r, 'normal', 20);
  assert.equal(r.shoot(t2.x + t2.r + 1e-4, t2.y, 30).hit, false);
  assert.equal(r.targets.length, 1, 'a miss leaves the target standing');
  assert.equal(r.shots, 2);
  assert.equal(r.hits, 1);
});

// S2 — the three types: sizes, movement, and what they pay.
test('S2: normal targets are big and pay 10..30 by size', () => {
  assert.equal(pointsFor(NORMAL_R_MAX), 10);
  assert.equal(pointsFor(NORMAL_R_MIN), 30);
  const r = new Range({ rng: mulberry32(11) });
  r.start(0);
  for (let i = 0; i < 30; i += 1) {
    const t = spawnKind(r, 'normal');
    assert.ok(t.r >= NORMAL_R_MIN && t.r <= NORMAL_R_MAX);
    const res = r.shoot(t.x, t.y, 10);
    assert.equal(res.points, pointsFor(t.r));
  }
});

test('S2: gold targets are small, drift on a sway, and pay GOLD_POINTS', () => {
  const r = new Range({ rng: mulberry32(7) });
  r.start(0);
  const t = spawnKind(r, 'gold');
  assert.ok(t.r >= GOLD_R_MIN && t.r <= GOLD_R_MAX, 'small');
  assert.ok(t.swayAmp > 0, 'it moves');

  // The drift is the documented sine: verify against an independent
  // computation at several times, and confirm it stays inside the field.
  for (const ms of [0, 400, 900, 1600]) {
    r.update(t.bornMs + ms);
    const expected = t.x0
      + Math.sin(t.phase + (ms / 1000) * GOLD_SWAY_HZ * Math.PI * 2) * t.swayAmp;
    assert.ok(Math.abs(t.x - expected) < 1e-12, `position at +${ms}ms`);
    assert.ok(t.x - t.r >= 0 && t.x + t.r <= FIELD_W, 'stays in the field');
  }
  const res = r.shoot(t.x, t.y, 1600);
  assert.equal(res.points, GOLD_POINTS);
  assert.equal(r.score, GOLD_POINTS);
});

test('S2: shooting a bomb subtracts BOMB_PENALTY, floored at zero', () => {
  const events = [];
  const r = new Range({ onEvent: (e) => events.push(e), rng: mulberry32(5) });
  r.start(0);
  const b1 = spawnKind(r, 'bomb');
  assert.equal(b1.r, BOMB_R);
  const res = r.shoot(b1.x, b1.y, 10);
  assert.equal(res.kind, 'bomb');
  assert.equal(res.points, -BOMB_PENALTY);
  assert.equal(r.score, 0, 'never below zero');
  assert.equal(r.hits, 0, 'a bomb is not a scoring hit');
  assert.equal(r.bombs, 1);
  assert.ok(events.some((e) => e.type === 'bombHit'));

  // With points in the bank, the penalty comes off the top.
  const n = spawnKind(r, 'normal', 20);
  r.shoot(n.x, n.y, 30);
  const before = r.score;
  const b2 = spawnKind(r, 'bomb', 40);
  r.shoot(b2.x, b2.y, 50);
  assert.equal(r.score, Math.max(0, before - BOMB_PENALTY));
});

test('placement: live targets never overlap, even with gold at full sway', () => {
  for (const seed of [3, 21, 77]) {
    const r = new Range({ rng: mulberry32(seed) });
    r.start(0);
    while (r.targets.length < MAX_ALIVE) r.spawn(0);
    // Check every pair at the worst case: each gold pushed to both sway
    // extremes; static targets at their spot.
    const spots = (t) => (t.swayAmp
      ? [t.x0 - t.swayAmp, t.x0 + t.swayAmp] : [t.x0]).map((x) => ({ x, y: t.y, r: t.r }));
    for (let i = 0; i < r.targets.length; i += 1) {
      for (let j = i + 1; j < r.targets.length; j += 1) {
        for (const a of spots(r.targets[i])) {
          for (const b of spots(r.targets[j])) {
            const d = Math.hypot(a.x - b.x, a.y - b.y);
            assert.ok(d > a.r + b.r, `seed ${seed}: pair ${i},${j} clear (${d.toFixed(3)})`);
          }
        }
      }
    }
    // And everything stays inside the field, sway included.
    for (const t of r.targets) {
      assert.ok(t.x0 - t.swayAmp - t.r >= 0 && t.x0 + t.swayAmp + t.r <= FIELD_W);
      assert.ok(t.y - t.r >= 0 && t.y + t.r <= FIELD_H);
    }
  }
});

test('placement: every grid cell gets used over time', () => {
  const r = new Range({ rng: mulberry32(13) });
  r.start(0);
  const seen = new Set();
  for (let i = 0; i < 300; i += 1) {
    const t = r.spawn(i);
    seen.add(t.cell);
    r.targets.length = 0;
  }
  assert.equal(seen.size, SPAWN_COLS * SPAWN_ROWS, 'all cells reachable');
  void SPAWN_X0; void SPAWN_X1; void SPAWN_Y0; void SPAWN_Y1; void SPAWN_ROWS;
});

test('S2: the spawn mix contains all three kinds in sane proportions', () => {
  const r = new Range({ rng: mulberry32(42) });
  r.start(0);
  const counts = { normal: 0, gold: 0, bomb: 0 };
  for (let i = 0; i < 400; i += 1) {
    counts[r.spawn(i).kind] += 1;
    r.targets.length = 0;
  }
  assert.ok(counts.normal > counts.gold && counts.gold > 40, `gold ${counts.gold}`);
  assert.ok(counts.bomb > 20 && counts.bomb < 90, `bomb ${counts.bomb}`);
});

// S3 — the 60-second round: totals must match an independent tally.
test('S3: the round ends at 60s with score, hits, bombs and accuracy', () => {
  const events = [];
  const r = new Range({ onEvent: (e) => events.push(e), rng: mulberry32(9) });
  r.start(0);
  let tally = 0;
  let hits = 0;
  let shots = 0;
  for (let now = 0; now <= ROUND_MS + 100; now += 50) {
    r.update(now);
    if (now % 400 === 0 && r.state === 'running' && r.targets.length) {
      const t = r.targets[0];
      const res = r.shoot(t.x, t.y, now);
      shots += 1;
      if (res.hit && res.kind !== 'bomb') { hits += 1; tally += res.points; }
      if (res.hit && res.kind === 'bomb') tally = Math.max(0, tally - BOMB_PENALTY);
    }
    if (now % 2000 === 0 && r.state === 'running') {
      const res = r.shoot(0.001, 0.001, now);
      shots += 1;
      if (res.hit && res.kind !== 'bomb') { hits += 1; tally += res.points; }
      if (res.hit && res.kind === 'bomb') tally = Math.max(0, tally - BOMB_PENALTY);
    }
  }
  assert.equal(r.state, 'done');
  const done = events.find((e) => e.type === 'done');
  assert.ok(done);
  assert.equal(done.score, tally, 'score equals the independent tally');
  assert.equal(done.shots, shots);
  assert.equal(done.hits, hits);
  assert.ok(Math.abs(done.accuracy - hits / shots) < 1e-12);
  assert.ok(done.hits > 15, `the marksman actually hit things (${done.hits})`);
});

test('S3: A restarts a finished round from zero', () => {
  const r = new Range({ rng: mulberry32(1) });
  r.start(0);
  for (let now = 0; now <= ROUND_MS + 100; now += 100) r.update(now);
  assert.equal(r.state, 'done');
  r.start(ROUND_MS + 5000);
  assert.equal(r.state, 'running');
  assert.equal(r.score, 0);
  assert.equal(r.shots, 0);
  assert.equal(r.bombs, 0);
  assert.equal(r.targets.length, 0);
});

test('housekeeping: targets expire on TTL and the field never overfills', () => {
  const r = new Range({ rng: mulberry32(7) });
  r.start(0);
  let maxAlive = 0;
  for (let now = 0; now <= 30_000; now += 50) {
    r.update(now);
    maxAlive = Math.max(maxAlive, r.targets.length);
    for (const t of r.targets) assert.ok(now < t.expiresMs, 'no zombie targets');
  }
  assert.ok(maxAlive <= MAX_ALIVE);
  assert.ok(maxAlive >= 3, 'the gallery actually fills up');
  const solo = new Range({ rng: mulberry32(2) });
  solo.start(0);
  const t = solo.spawn(0);
  const ttl = t.kind === 'gold' ? 3400 : TARGET_TTL_MS;
  solo.update(ttl - 1);
  assert.ok(solo.targets.includes(t), 'alive just before TTL');
  solo.update(ttl + 1);
  assert.ok(!solo.targets.includes(t));
});

test('shots after the buzzer do nothing', () => {
  const r = new Range({ rng: mulberry32(4) });
  r.start(0);
  const t = r.spawn(100);
  for (let now = 0; now <= ROUND_MS + 100; now += 100) r.update(now);
  const res = r.shoot(t.x, t.y, ROUND_MS + 200);
  assert.equal(res.hit, false);
  assert.equal(r.shots, 0, 'the trigger is dead after time');
});

// ── Two players ────────────────────────────────────────────────────────────

test('2P: each player keeps their own score, shots and hits', () => {
  const r = new Range({ rng: mulberry32(3), players: 2 });
  r.start(0);
  const a = spawnKind(r, 'normal');
  const b = spawnKind(r, 'normal');
  const resA = r.shoot(a.x, a.y, 10, 0);
  const resB = r.shoot(b.x, b.y, 20, 1);
  r.shoot(0.001, 0.001, 30, 1);                       // P2 whiffs
  assert.equal(resA.player, 0);
  assert.equal(resB.player, 1);
  assert.equal(r.stats[0].score, resA.points);
  assert.equal(r.stats[1].score, resB.points);
  assert.deepEqual([r.stats[0].shots, r.stats[1].shots], [1, 2]);
  assert.deepEqual([r.stats[0].hits, r.stats[1].hits], [1, 1]);
  assert.equal(r.accuracyOf(1), 0.5);
});

test('2P: first shot takes the target — the other player gets nothing', () => {
  const r = new Range({ rng: mulberry32(3), players: 2 });
  r.start(0);
  const t = spawnKind(r, 'normal');
  assert.equal(r.shoot(t.x, t.y, 10, 1).hit, true);
  assert.equal(r.shoot(t.x, t.y, 11, 0).hit, false, 'already gone');
  assert.equal(r.stats[0].score, 0);
  assert.ok(r.stats[1].score > 0);
});

test('2P: a bomb only costs the player who shot it, floored at zero', () => {
  const r = new Range({ rng: mulberry32(3), players: 2 });
  r.start(0);
  const n = spawnKind(r, 'normal');
  r.shoot(n.x, n.y, 5, 0);
  const before = r.stats[0].score;
  const bomb = spawnKind(r, 'bomb');
  r.shoot(bomb.x, bomb.y, 10, 1);                     // P2 eats the bomb at 0
  assert.equal(r.stats[1].score, 0, 'floored');
  assert.equal(r.stats[1].bombs, 1);
  assert.equal(r.stats[0].score, before, 'P1 untouched');
  const bomb2 = spawnKind(r, 'bomb');
  r.shoot(bomb2.x, bomb2.y, 20, 0);
  assert.equal(r.stats[0].score, Math.max(0, before - BOMB_PENALTY));
});

test('2P: done event reports both players and the winner', () => {
  const events = [];
  const r = new Range({ onEvent: (e) => events.push(e), rng: mulberry32(5), players: 2 });
  r.start(0);
  const g = spawnKind(r, 'gold');
  r.shoot(g.x, g.y, 100, 1);                          // P2 scores, P1 doesn't
  for (let now = 0; now <= ROUND_MS + 100; now += 100) r.update(now);
  const done = events.find((e) => e.type === 'done');
  assert.equal(done.winner, 1);
  assert.equal(done.players.length, 2);
  assert.equal(done.players[1].score, GOLD_POINTS);
  assert.equal(done.players[0].score, 0);
});

test('2P: equal scores are a tie (-1); a solo round has no winner', () => {
  const r = new Range({ rng: mulberry32(1), players: 2 });
  r.start(0);
  assert.equal(r.winner, -1);
  const solo = new Range({ rng: mulberry32(1) });
  solo.start(0);
  assert.equal(solo.winner, null);
});

test('2P: shots from a player index that is not in the round are ignored', () => {
  const r = new Range({ rng: mulberry32(3) });        // solo round
  r.start(0);
  const t = spawnKind(r, 'normal');
  assert.equal(r.shoot(t.x, t.y, 10, 1).hit, false);
  assert.equal(r.targets.length, 1, 'target still standing');
});

test('2P: start(now, players) resizes the round and wipes old stats', () => {
  const r = new Range({ rng: mulberry32(3) });
  r.start(0);
  const t = spawnKind(r, 'normal');
  r.shoot(t.x, t.y, 5, 0);
  r.start(100, 2);
  assert.equal(r.playerCount, 2);
  assert.deepEqual(r.stats.map((s) => s.score), [0, 0]);
  assert.equal(r.balloons.length, 0);
});

// ── Balloons ───────────────────────────────────────────────────────────────

test('balloons: payout rises with height, from MIN to MAX, in steps of 5', () => {
  assert.equal(balloonPoints(BALLOON_START_Y), BALLOON_POINTS_MIN);
  assert.equal(balloonPoints(BALLOON_FULL_Y), BALLOON_POINTS_MAX);
  assert.equal(balloonPoints(-1), BALLOON_POINTS_MAX, 'clamped at the top');
  assert.equal(balloonPoints(2), BALLOON_POINTS_MIN, 'clamped at the bottom');
  let prev = 0;
  for (let y = BALLOON_START_Y; y >= BALLOON_FULL_Y; y -= 0.01) {
    const p = balloonPoints(y);
    assert.ok(p >= prev, 'never pays less as it climbs');
    assert.equal(p % 5, 0);
    prev = p;
  }
  assert.ok(BALLOON_POINTS_MAX > GOLD_POINTS);
});

test('balloons: first one appears on schedule and rises steadily', () => {
  const r = new Range({ rng: mulberry32(2), balloonRng: mulberry32(11) });
  r.start(0);
  r.update(BALLOON_FIRST_MS - 10);
  assert.equal(r.balloons.length, 0);
  r.update(BALLOON_FIRST_MS + 10);
  assert.equal(r.balloons.length, 1);
  const b = r.balloons[0];
  const y0 = b.y;
  r.update(BALLOON_FIRST_MS + 1010);
  assert.ok(Math.abs((y0 - b.y) - BALLOON_RISE * 1.0) < 1e-6, 'rises BALLOON_RISE per second');
});

test('balloons: they escape off the top with no points, and never overfill', () => {
  const events = [];
  const r = new Range({
    onEvent: (e) => events.push(e), rng: mulberry32(2), balloonRng: mulberry32(11),
  });
  r.start(0);
  let maxAlive = 0;
  for (let now = 0; now <= ROUND_MS; now += 50) {
    r.update(now);
    maxAlive = Math.max(maxAlive, r.balloons.length);
    for (const b of r.balloons) assert.ok(b.y > 0, 'no balloon lingers past the top');
    if (r.state === 'done') break;
  }
  assert.ok(maxAlive >= 1 && maxAlive <= BALLOON_MAX_ALIVE);
  assert.ok(events.some((e) => e.type === 'expire' && e.target.kind === 'balloon'));
  assert.equal(r.score, 0, 'an escaped balloon costs and pays nothing');
});

test('balloons: shooting one pays by height and counts toward balloon stats', () => {
  const events = [];
  const r = new Range({
    onEvent: (e) => events.push(e), rng: mulberry32(2), balloonRng: mulberry32(11), players: 2,
  });
  r.start(0);
  r.update(BALLOON_FIRST_MS + 10);
  const b = r.balloons[0];
  const low = balloonPoints(b.y);
  const res = r.shoot(b.x, b.y, BALLOON_FIRST_MS + 20, 1);
  assert.equal(res.hit, true);
  assert.equal(res.kind, 'balloon');
  assert.equal(res.points, low);
  assert.equal(r.stats[1].balloons, 1);
  assert.equal(r.stats[1].score, low);
  assert.equal(r.balloons.length, 0);

  // A later one, shot high up, pays more.
  r.update(BALLOON_FIRST_MS + 8_000);
  r.nextBalloonMs = 0;
  r.update(BALLOON_FIRST_MS + 8_010);
  const b2 = r.balloons[0];
  b2.bornMs -= 6_000;                                  // age it into the upper sky
  r.update(BALLOON_FIRST_MS + 8_020);
  const high = r.shoot(b2.x, b2.y, BALLOON_FIRST_MS + 8_030, 0);
  assert.ok(high.points > low, `higher pays more (${high.points} > ${low})`);
  assert.ok(events.some((e) => e.type === 'hit' && e.kind === 'balloon' && e.player === 0));
});

test('balloons: hit area is a circle of BALLOON_R around the balloon body', () => {
  const r = new Range({ rng: mulberry32(2), balloonRng: mulberry32(11) });
  r.start(0);
  r.update(BALLOON_FIRST_MS + 10);
  const b = r.balloons[0];
  assert.equal(r.shoot(b.x + BALLOON_R + 1e-3, b.y, BALLOON_FIRST_MS + 20).hit, false);
  assert.equal(r.shoot(b.x + BALLOON_R - 1e-3, b.y, BALLOON_FIRST_MS + 30).hit, true);
});

test('balloons: do not count toward MAX_ALIVE or take grid cells', () => {
  const r = new Range({ rng: mulberry32(2), balloonRng: mulberry32(11) });
  r.start(0);
  r.spawnBalloon(0);
  r.spawnBalloon(0);
  for (let i = 0; i < MAX_ALIVE + 3; i += 1) r.update(1000 + i * 600);
  assert.ok(r.targets.length <= MAX_ALIVE);
  assert.equal(r.targets.some((t) => t.kind === 'balloon'), false);
});
