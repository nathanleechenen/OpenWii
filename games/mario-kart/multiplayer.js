/**
 * Mario Kart multiplayer (stage 1: several phones drive their own karts).
 *
 * logic.js is left untouched. MultiRace extends Race so that any racer can be
 * human-driven (racer id === phone slot), and RemotePlayers keeps one steering
 * wheel per extra phone. With only phone P1 (or just the keyboard) connected,
 * behaviour is identical to the original single-player Race.
 */
import { Race, FIXED_DT } from "./logic.js";
import { WheelInput } from "./input.js";

export const MAX_HUMANS = 4;

export class MultiRace extends Race {
  constructor(opts) {
    super(opts);
    this.humans = new Set([0]);       // racer ids driven by a person
    this.pending = new Set();         // item presses waiting for the next fixed step
  }

  /** Racer 0 is always the primary player; `ids` adds the other phones' racers. */
  setHumans(ids = []) {
    this.humans = new Set([0, ...ids.filter((i) => Number.isInteger(i) && i > 0 && i < MAX_HUMANS)]);
  }

  /** Same contract as Race.update, plus `others`: { [racerId]: input } for extra humans. */
  update(dt, input = {}, others = {}) {
    if (!Number.isFinite(dt) || dt <= 0 || this.state === "ready") return;
    // A long background stall pauses instead of running a race without the drivers.
    this.accumulator += Math.min(dt, 0.25);
    if (input.item) this.pending.add(0);
    for (const [id, inp] of Object.entries(others)) {
      if (inp && inp.item) this.pending.add(Number(id));
    }
    while (this.accumulator + 1e-10 >= FIXED_DT) {
      const inputs = { 0: { ...input, item: this.pending.has(0) } };
      for (const [id, inp] of Object.entries(others)) {
        inputs[id] = { ...inp, item: this.pending.has(Number(id)) };
      }
      this.stepAll(FIXED_DT, inputs);
      this.pending.clear();
      this.accumulator -= FIXED_DT;
    }
  }

  /** Race.step generalised from one human to many (inputs keyed by racer id). */
  stepAll(dt, inputs) {
    this.time += dt;
    const humans = this.racers.filter((r) => this.humans.has(r.id));
    if (this.state === "countdown") {
      for (const r of humans) {
        const inp = inputs[r.id] || {};
        if (inp.gas && !r.lastInput.gas) r.gasDownAt = this.time;
        if (!inp.gas) r.gasDownAt = null;
        r.lastInput = { ...inp };
      }
      const n = Math.max(0, 3 - Math.floor(this.time));
      if (n !== this.count) {
        this.count = n;
        if (n) this.emit("countdown", this.player, { count: n });
      }
      if (this.time + 1e-9 < 3) return;
      this.state = "racing";
      this.count = 0;
      this.emit("go");
      for (const r of humans) {
        const held = r.gasDownAt === null ? 0 : 3 - r.gasDownAt;
        if (held >= 0.7 && held <= 1.5) {
          r.boost = 1.8;
          r.speed = 24;
          this.emit("rocket", r);
        } else if (held > 1.8) {
          r.spin = 1.05;
          this.emit("burnout", r);
        }
      }
    }
    this.raceTime += dt;
    for (const p of [...this.boxes, ...this.coins]) p.respawn = Math.max(0, p.respawn - dt);
    const oldProgress = new Map(this.racers.map((r) => [r.id, r.progress]));
    for (const r of this.racers) {
      const auto = !this.humans.has(r.id) || r.finishTime !== null;
      this.move(r, auto ? this.cpuInput(r) : inputs[r.id] || {}, dt, auto);
    }
    this.collisions(dt, oldProgress);
    this.updateObjects(dt, oldProgress);
    this.finishOrder = this.racers
      .filter((r) => r.finishTime !== null)
      .sort((a, b) => a.finishTime - b.finishTime)
      .map((r) => r.id);
    // The race winds down once every human has crossed the line.
    if (this.state === "racing" && humans.every((r) => r.finishTime !== null)) {
      this.state = "finishing";
      this.finishedAt = this.time;
      this.emit("finish");
    }
    if (this.state === "finishing" && this.finishOrder.length === 8) this.showResults();
  }
}

/** One steering wheel per extra phone (slots 1–3); slot 0 stays on game.js's own wheel. */
export class RemotePlayers {
  constructor() {
    this.wheels = new Map();          // slot → WheelInput
    this.captureUntil = new Map();    // slot → time until which it may recapture level
    this.lastItem = new Map();        // slot → previous item-button state (edge detect)
    this.connected = new Set();       // extra slots whose phone is linked
    this.started = new Set();         // slots that were linked when the race began
  }

  wheel(slot) {
    if (!this.wheels.has(slot)) this.wheels.set(slot, new WheelInput());
    return this.wheels.get(slot);
  }

  has(slot) { return this.connected.has(slot); }
  slots() { return [...this.connected]; }

  presence(p) {
    const next = new Set();
    for (const s of (p && p.slots) || []) {
      if (s.occupied && s.slot > 0 && s.slot < MAX_HUMANS) next.add(s.slot);
    }
    for (const s of this.connected) if (!next.has(s)) this.wheel(s).release();
    this.connected = next;
  }

  label(p) {
    const n = Math.max(1, (p && p.controller) || 1);
    return n > 1 ? `${n} PHONES CONNECTED` : "PHONE CONNECTED · P1";
  }

  sample(sample, slot, now, raceState) {
    const until = this.captureUntil.get(slot) || 0;
    const canCapture = raceState === "ready" || raceState === "countdown" || now < until;
    this.wheel(slot).sample(sample, now, { canCapture });
  }

  command(cmd, slot, now) {
    const w = this.wheel(slot);
    w.command(cmd, now);
    if (cmd.type === "recentre" || cmd.type === "calibrate") {
      w.reset();
      this.captureUntil.set(slot, now + 10000);
    }
  }

  /** Called when a new race begins: every wheel re-levels during the countdown. */
  reset(now) {
    for (const [slot, w] of this.wheels) {
      w.reset();
      this.captureUntil.set(slot, now + 3000);
    }
  }

  /** True once every linked extra phone has levelled its wheel. */
  allArmed() {
    for (const s of this.connected) if (!this.wheel(s).armed) return false;
    return true;
  }

  /** Decide which racers are human this frame. Late joiners can only join before the green light. */
  apply(race) {
    if (!race || typeof race.setHumans !== "function") return;
    if (race.state === "ready" || race.state === "countdown") this.started = new Set(this.connected);
    race.setHumans([...this.connected].filter((s) => this.started.has(s)));
  }

  /** Inputs for the extra humans, keyed by racer id (= phone slot). */
  read(now) {
    const out = {};
    for (const s of this.connected) {
      const r = this.wheel(s).read(now);
      const item = r.item && !this.lastItem.get(s);
      this.lastItem.set(s, r.item);
      out[s] = { gas: r.gas, brake: r.brake, drift: r.drift, steer: r.steer, item };
    }
    return out;
  }
}
