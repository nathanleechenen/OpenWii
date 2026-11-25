/**
 * Mario Kart multiplayer: up to 4 phones race together.
 *
 * logic.js is left untouched. MultiRace extends Race so any racer can be driven
 * by a person; RemotePlayers tracks the extra phones (wheels, driver picks,
 * player count); SplitHud draws a small HUD per split-screen view.
 *
 * Phone slot → racer: P1 is racer 0 (back of the grid); P2, P3, P4 take racers
 * 7, 6, 5 so all humans start side by side at the back. With only P1 (or just
 * the keyboard) connected everything behaves exactly like the original game.
 */
import { Race, FIXED_DT } from "./logic.js";
import { WheelInput } from "./input.js";

export const MAX_HUMANS = 4;
export const RACERS = 8;
export const racerOf = (slot) => (slot === 0 ? 0 : RACERS - slot);
export const slotOf = (racerId) => (racerId === 0 ? 0 : RACERS - racerId);

/** Shared render state, read by game.js's draw code. */
export const view = { pass: 0, count: 1, rect: null };
/** Per-player camera state saved between split-screen passes. */
export const camStore = [];

/** Rectangles (CSS px, origin top-left) for n split-screen views. */
export function layoutViews(n, W, H) {
  if (n <= 1) return [{ x: 0, y: 0, w: W, h: H }];
  if (n === 2) return [{ x: 0, y: 0, w: W, h: H / 2 }, { x: 0, y: H / 2, w: W, h: H / 2 }];
  const w = W / 2, h = H / 2;
  return [{ x: 0, y: 0, w, h }, { x: w, y: 0, w, h }, { x: 0, y: h, w, h }, { x: w, y: h, w, h }].slice(0, n);
}

export class MultiRace extends Race {
  constructor(opts) {
    super(opts);
    this.humans = new Set([0]);       // racer ids driven by a person
    this.pending = new Set();         // item presses waiting for the next fixed step
  }

  /** Racer 0 is always the primary player; `ids` adds the other phones' racers. */
  setHumans(ids = []) {
    this.humans = new Set([0, ...ids.filter((i) => Number.isInteger(i) && i > 0 && i < RACERS)]);
  }

  /** Give racer `racerId` the character `characterId`, swapping with whoever has it now. */
  assignCharacter(racerId, characterId) {
    const target = this.racers[racerId];
    const holder = this.racers.find((r) => r.character.id === characterId);
    if (!target || !holder || holder === target) return;
    [target.character, holder.character] = [holder.character, target.character];
    target.skill = target.character.skill;
    holder.skill = holder.character.skill;
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

const DIRS = { left: -1, right: 1, up: -4, down: 4 };
const PICK_COLORS = { 2: "#35a7ff", 3: "#39d353", 4: "#ff5fbf" };
const ord = (n) => `${n}${["th", "st", "nd", "rd"][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10 < 4 ? n % 10 : 0]}`;

/** Extra phones (slots 1–3): wheels, driver picks, player count, per-racer inputs. */
export class RemotePlayers {
  constructor(characterIds = []) {
    this.ids = characterIds;          // character ids in grid order
    this.wheels = new Map();          // slot → WheelInput
    this.captureUntil = new Map();    // slot → time until which it may recapture level
    this.lastItem = new Map();        // slot → previous item-button state (edge detect)
    this.connected = new Set();       // extra slots whose phone is linked
    this.started = new Set();         // slots that took part when the race began
    this.count = 1;                   // chosen number of players (1–4)
    this.countTouched = false;        // true once someone picked the count by hand
    this.picks = new Map();           // slot → character id
    this.ready = new Set();           // slots whose driver is confirmed
    this.p1Id = null;                 // P1's current character id (kept in sync by game.js)
    this.onChange = null;             // called when the roster / picks change (rebuild karts)
  }

  wheel(slot) {
    if (!this.wheels.has(slot)) this.wheels.set(slot, new WheelInput());
    return this.wheels.get(slot);
  }

  // -- roster -------------------------------------------------------------
  maxCount() { return Math.min(MAX_HUMANS, 1 + this.connected.size); }
  extras() { return [...this.connected].sort((a, b) => a - b); }
  activeExtras() { return this.extras().slice(0, Math.max(0, this.count - 1)); }
  activeSlots() { return [0, ...this.activeExtras()]; }
  has(slot) { return this.connected.has(slot); }
  slots() { return this.extras(); }
  /** The slot of racer `id` if it is an active extra human, else -1. */
  slotForRacer(id) {
    const s = slotOf(id);
    return s > 0 && this.activeExtras().includes(s) ? s : -1;
  }

  _signature() { return `${this.activeExtras().join(",")}|${this.extras().map((s) => this.picks.get(s)).join(",")}`; }

  _changed(before) {
    this.paint();
    if (before !== this._signature() && this.onChange) this.onChange();
  }

  presence(p) {
    const before = this._signature();
    const next = new Set();
    for (const s of (p && p.slots) || []) {
      if (s.occupied && s.slot > 0 && s.slot < MAX_HUMANS) next.add(s.slot);
    }
    for (const s of this.connected) {
      if (!next.has(s)) { this.wheel(s).release(); this.picks.delete(s); this.ready.delete(s); }
    }
    this.connected = next;
    this.count = this.countTouched ? Math.min(this.count, this.maxCount()) : this.maxCount();
    this._ensurePicks();
    this._changed(before);
  }

  setCount(n) {
    const before = this._signature();
    this.countTouched = true;
    this.count = Math.max(1, Math.min(Math.floor(n) || 1, this.maxCount()));
    for (const s of this.extras()) {
      if (!this.activeExtras().includes(s)) { this.picks.delete(s); this.ready.delete(s); }
    }
    this._ensurePicks();
    this._changed(before);
  }

  bumpCount(delta) { this.setCount(this.count + delta); }

  label(p) {
    const n = Math.max(1, (p && p.controller) || 1);
    return n > 1 ? `${n} PHONES CONNECTED` : "PHONE CONNECTED · P1";
  }

  // -- driver picking -----------------------------------------------------
  /** Character ids someone else is on (P1's cursor counts for everyone but P1). */
  occupied(exceptSlot) {
    const out = new Set();
    if (exceptSlot !== 0 && this.p1Id) out.add(this.p1Id);
    for (const s of this.activeExtras()) {
      if (s !== exceptSlot && this.picks.has(s)) out.add(this.picks.get(s));
    }
    return out;
  }

  _ensurePicks() {
    for (const s of this.activeExtras()) {
      if (this.picks.has(s)) continue;
      const taken = this.occupied(s);
      const free = this.ids.find((id) => !taken.has(id));
      if (free) this.picks.set(s, free);
    }
  }

  /** For P1: step the cursor by `step`, skipping drivers the other players hold. */
  skipPicked(index, step) {
    const n = this.ids.length;
    if (!n) return index + step;
    const taken = this.occupied(0);
    taken.delete(this.p1Id);
    const dir = step < 0 ? -1 : 1;
    let i = index + step;
    for (let g = 0; g < n && taken.has(this.ids[((i % n) + n) % n]); g += 1) i += dir;
    return i;
  }

  navigate(slot, direction) {
    if (!this.activeExtras().includes(slot) || this.ready.has(slot) || !(direction in DIRS)) return;
    const n = this.ids.length;
    if (!n) return;
    const taken = this.occupied(slot);
    const dir = DIRS[direction] < 0 ? -1 : 1;
    let i = this.ids.indexOf(this.picks.get(slot)) + DIRS[direction];
    for (let g = 0; g < n && taken.has(this.ids[((i % n) + n) % n]); g += 1) i += dir;
    this.picks.set(slot, this.ids[((i % n) + n) % n]);
    this._changed("changed");
  }

  confirm(slot) {
    if (!this.activeExtras().includes(slot)) return;
    this.ready.add(slot);
    this._changed(this._signature());
  }

  cancel(slot) {
    if (this.ready.delete(slot)) this._changed(this._signature());
  }

  allReady() {
    return this.activeExtras().every((s) => this.ready.has(s));
  }

  hint() {
    const waiting = this.activeExtras().filter((s) => !this.ready.has(s)).map((s) => `P${s + 1}`);
    return waiting.length ? `Waiting for ${waiting.join(" & ")} to confirm a driver (② OK)` : "";
  }

  /** Swap characters into the freshly built race before karts are made. */
  setup(race) {
    if (!race || typeof race.assignCharacter !== "function") return;
    for (const s of this.activeExtras()) {
      if (this.picks.has(s)) race.assignCharacter(racerOf(s), this.picks.get(s));
    }
  }

  // -- input --------------------------------------------------------------
  sample(sample, slot, now, raceState) {
    const until = this.captureUntil.get(slot) || 0;
    const canCapture = raceState === "ready" || raceState === "countdown" || now < until;
    this.wheel(slot).sample(sample, now, { canCapture });
  }

  command(cmd, slot, now, raceState) {
    const w = this.wheel(slot);
    w.command(cmd, now);
    if (cmd.type === "recentre" || cmd.type === "calibrate") {
      w.reset();
      this.captureUntil.set(slot, now + 10000);
    }
    if (raceState === "ready" && cmd.type === "button" && cmd.pressed !== false) {
      const dir = cmd.menuDirection || cmd.button;
      if (dir in DIRS) this.navigate(slot, dir);
      else if (cmd.button === "2") this.confirm(slot);
      else if (cmd.button === "1") this.cancel(slot);
    }
  }

  /** Called when a new race begins: every wheel re-levels during the countdown. */
  reset(now) {
    for (const [slot, w] of this.wheels) {
      w.reset();
      this.captureUntil.set(slot, now + 3000);
    }
  }

  /** True once every active extra phone has levelled its wheel. */
  allArmed() {
    for (const s of this.activeExtras()) if (!this.wheel(s).armed) return false;
    return true;
  }

  /** Decide which racers are human. Late joiners can only join before the green light. */
  apply(race) {
    if (!race || typeof race.setHumans !== "function") return;
    if (race.state === "ready" || race.state === "countdown") this.started = new Set(this.activeExtras());
    race.setHumans(this.activeExtras().filter((s) => this.started.has(s)).map(racerOf));
  }

  /** Inputs for the extra humans, keyed by racer id. */
  read(now) {
    const out = {};
    for (const s of this.activeExtras()) {
      const r = this.wheel(s).read(now);
      const item = r.item && !this.lastItem.get(s);
      this.lastItem.set(s, r.item);
      out[racerOf(s)] = { gas: r.gas, brake: r.brake, drift: r.drift, steer: r.steer, item };
    }
    return out;
  }

  /** Split-screen roster: one view per human racer, in slot order. */
  viewsFor(race) {
    const ids = race && race.humans ? [...race.humans] : [0];
    return ids.map((id) => ({ slot: slotOf(id), racer: id })).sort((a, b) => a.slot - b.slot);
  }

  // -- DOM (all guarded so the logic runs in Node tests) ----------------------
  mount() {
    if (typeof document === "undefined" || this.mounted) return;
    this.mounted = true;
    const style = document.createElement("style");
    style.textContent = `
      .character{position:relative}
      ${[2, 3, 4].map((n) => `.character.pick-p${n}{border-color:${PICK_COLORS[n]}!important;box-shadow:0 0 0 .25vw ${PICK_COLORS[n]},0 0 1vw ${PICK_COLORS[n]}99!important}`).join("\n")}
      .character[data-picks]::after{content:attr(data-picks);position:absolute;left:0;right:0;bottom:-1.25vw;text-align:center;font:800 .8vw system-ui,sans-serif;color:#fff;text-shadow:0 1px 2px #000}
      #player-options{display:flex;align-items:center;gap:.7vw;width:31vw;margin:0 0 1.5vh;color:#203e61}
      #player-options>span{font-size:.9vw;margin-right:auto}
      #player-options button{font:inherit;font-size:1.15vw;padding:.5vw 1.1vw;border:2px solid #d7ecff;border-radius:4px;color:#203e61;background:#d7ecffb8;cursor:pointer}
      #player-options button[aria-pressed="true"]{background:linear-gradient(#fff67e,#ffd331);border-color:#fff6a0;box-shadow:0 2px 0 #bd931a}
      #player-options button:disabled{opacity:.4;cursor:default}
      body.split #item-frame,body.split #race-brand,body.split #lap-panel,body.split #position,
      body.split #minimap,body.split #speed,body.split #drift-meter{display:none!important}
      #mk-split{position:fixed;inset:0;pointer-events:none;z-index:3;display:none;font-family:inherit}
      #mk-split .cell{position:absolute;color:#fff;font-weight:900;text-shadow:0 2px 4px #000c,0 0 8px #0008}
      #mk-split .cell span{position:absolute;white-space:nowrap}
      #mk-split .tag{top:1.2%;left:50%;transform:translateX(-50%);font-size:1.5vw;padding:.1vw .8vw;border-radius:99px;background:#000a}
      #mk-split .pos{top:1.2%;left:1.5%;font-size:3.2vw}
      #mk-split .lap{top:1.8%;right:1.5%;font-size:1.7vw}
      #mk-split .itm{bottom:2%;left:1.5%;font-size:1.4vw}
      #mk-split .fin{top:42%;left:50%;transform:translateX(-50%);font-size:2.4vw;color:#ffe866}
      #mk-split .line{position:absolute;background:#000}`;
    document.head.appendChild(style);
    const lap = document.getElementById("lap-options");
    if (lap && !document.getElementById("player-options")) {
      const box = document.createElement("div");
      box.id = "player-options";
      box.setAttribute("role", "group");
      box.setAttribute("aria-label", "Number of players");
      box.innerHTML = '<span>PLAYERS</span>' + [1, 2, 3, 4].map((n) => `<button type="button" data-players="${n}" aria-pressed="false">${n}</button>`).join("");
      lap.insertAdjacentElement("afterend", box);
      box.querySelectorAll("button").forEach((b) => { b.onclick = () => this.setCount(Number(b.dataset.players)); });
    }
    this.paint();
  }

  paint() {
    if (typeof document === "undefined") return;
    this.mount();
    document.querySelectorAll("#characters .character").forEach((el, i) => {
      const id = this.ids[i];
      el.classList.remove("pick-p2", "pick-p3", "pick-p4");
      el.removeAttribute("data-picks");
      for (const s of this.activeExtras()) {
        if (this.picks.get(s) === id) {
          el.classList.add(`pick-p${s + 1}`);
          el.setAttribute("data-picks", `P${s + 1}${this.ready.has(s) ? " ✓" : ""}`);
        }
      }
    });
    document.querySelectorAll("#player-options button").forEach((b) => {
      const n = Number(b.dataset.players);
      b.setAttribute("aria-pressed", String(n === this.count));
      b.disabled = n > this.maxCount();
    });
  }
}

/** A small HUD in each split-screen view (the full HUD is hidden while split). */
export class SplitHud {
  constructor() { this.root = null; this.cells = []; this.lines = []; }

  mount() {
    if (this.root || typeof document === "undefined") return;
    this.root = document.createElement("div");
    this.root.id = "mk-split";
    document.body.appendChild(this.root);
    for (let i = 0; i < 2; i += 1) {
      const l = document.createElement("div");
      l.className = "line";
      this.root.appendChild(l);
      this.lines.push(l);
    }
  }

  _cell() {
    const el = document.createElement("div");
    el.className = "cell";
    el.innerHTML = '<span class="tag"></span><span class="pos"></span><span class="lap"></span><span class="itm"></span><span class="fin"></span>';
    this.root.appendChild(el);
    return { el, tag: el.children[0], pos: el.children[1], lap: el.children[2], itm: el.children[3], fin: el.children[4] };
  }

  update(race, views, rects) {
    this.mount();
    if (!this.root) return;
    if (!views || !rects) { this.root.style.display = "none"; return; }
    this.root.style.display = "block";
    while (this.cells.length < views.length) this.cells.push(this._cell());
    this.cells.forEach((c, i) => { c.el.style.display = i < views.length ? "block" : "none"; });
    views.forEach((v, i) => {
      const c = this.cells[i], r = rects[i], p = race.racers[v.racer];
      Object.assign(c.el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      const set = (node, text) => { if (node.textContent !== text) node.textContent = text; };
      set(c.tag, `P${v.slot + 1}`);
      set(c.pos, ord(race.position(p)));
      set(c.lap, `LAP ${Math.min(p.lap, race.laps)}/${race.laps}`);
      set(c.itm, p.roulette > 0 ? "ROULETTE" : p.item ? String(p.item).toUpperCase() : "");
      set(c.fin, p.finishTime !== null ? `FINISHED · ${ord(race.position(p))}` : "");
    });
    const W = innerWidth, H = innerHeight;
    const [h, vl] = this.lines;
    h.style.cssText = `left:0;top:${H / 2 - 2}px;width:${W}px;height:4px`;
    vl.style.cssText = views.length > 2 ? `left:${W / 2 - 2}px;top:0;width:4px;height:${H}px` : "display:none";
  }
}
