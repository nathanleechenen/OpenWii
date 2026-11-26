/**
 * OpenWii → LibreCorsa bridge.
 *
 * Injected at the top of every LibreCorsa page (by scripts/build-static.mjs).
 * It makes phone P1 look like a standard Xbox gamepad to the game: tilt becomes
 * the left stick's X axis (steering), buttons become trigger / face buttons, and
 * rumble requests are sent back to the phone. LibreCorsa's own code is untouched:
 * it already polls navigator.getGamepads() every frame.
 *
 * Two ways to hold the phone; whichever you are holding when you press − (recentre) is used:
 *   FLAT, like a tray (screen up):   roll left / right = steer · tilt forward = gas, back = brake
 *   UPRIGHT, like a wheel (screen toward you, portrait or landscape):
 *                                    rotate left / right = steer · push top away = gas, pull toward you = brake
 *
 * Phone (wheel mode)      →  gamepad button            LibreCorsa default (GT layout)
 *   steering              →  axis 0                    steering
 *   gas (tilt)            →  RT (7), analog            throttle (more tilt = more throttle)
 *   brake (tilt)          →  LT (6), analog            brake    (more tilt = more brake)
 *   2  (GAS)              →  RT (7), full              throttle (button override)
 *   1  (BRAKE)            →  LT (6), full              brake    (button override)
 *   →  right              →  A  (0)                    shift up
 *   ←  left               →  X  (2)                    shift down
 *   A  (DRIFT)            →  R3 (11)                   boost
 *   ↑  up                 →  Y  (3)                    aero
 *   ↓  down               →  RB (5)                    camera
 *   B                     →  Menu (9)                  pause
 *   HOME                  →  leaves the game, back to the launcher
 *   −  (recentre)         →  re-levels the wheel
 */
(() => {
  'use strict';

  const PAD_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 02fd)';
  const BUTTON_COUNT = 17;
  // phone button → standard-gamepad button index
  const MAP = { right: 0, left: 2, up: 3, down: 5, B: 9, A: 11 };
  const LT = 6;
  const RT = 7;

  // ── Tilt pedals: pitch relative to the level the wheel was calibrated at ──
  const DEG = Math.PI / 180;
  const PEDAL_DEADZONE = 3;    // degrees of tilt ignored (hand tremor, resting angle)
  const PEDAL_FULL = 18;       // degrees of tilt for a fully pressed pedal
  const clamp1 = (v) => Math.max(-1, Math.min(1, v));
  const shapePedal = (deg) => (deg <= PEDAL_DEADZONE ? 0 : Math.min(1, (deg - PEDAL_DEADZONE) / (PEDAL_FULL - PEDAL_DEADZONE)));

  /** Pitch in degrees, + = front edge down (leaning forward), from the device's short axis. */
  function pitchDeg(axes, sx) { return -Math.asin(clamp1(sx * axes.x.z)) / DEG; }

  /** Called when the wheel is levelled: remember which way the short axis points and the resting pitch. */
  function pedalCalibrate(axes, ref) {
    const fx = -ref.right.y, fy = ref.right.x;            // "forward", from the same "right" the steering uses
    const sx = axes.x.x * fx + axes.x.y * fy >= 0 ? 1 : -1;
    return { sx, pitch0: pitchDeg(axes, sx) };
  }

  /** Gas / brake (0..1) from the current orientation, relative to the calibrated rest pose. */
  function pedalRead(axes, cal) {
    const pitch = pitchDeg(axes, cal.sx) - cal.pitch0;
    return { pitch, gas: shapePedal(pitch), brake: shapePedal(-pitch) };
  }

  // ── Upright wheel: phone held in front of you, screen toward you, rotated like a steering wheel ──
  const UPRIGHT_DEADZONE = 2.5;   // degrees of rotation ignored
  const UPRIGHT_FULL = 70;        // degrees of rotation for full lock
  const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

  /** Wheel angle (° clockwise, as seen by the player) and pitch (° top-away) of an upright phone, or null if the screen is too flat to tell. */
  function uprightPose(axes, which, sgn) {
    const z = axes.z;
    const hm = Math.hypot(z.x, z.y);
    if (hm < 0.3) return null;
    const fx = -z.x / hm, fy = -z.y / hm;                  // horizontal direction away from the player
    const u = axes[which];
    const right = sgn * (u.x * fy - u.y * fx);             // component of the wheel's "up" along the player's right
    return { angle: Math.atan2(right, sgn * u.z) / DEG, pitch: Math.asin(clamp1(z.z)) / DEG };
  }

  const spread = (list) => Math.max(...list) - Math.min(...list);

  class UprightWheel {
    constructor() { this.reset(); }
    reset() { this.cal = null; this.stable = []; this.steer = 0; this.gas = 0; this.brake = 0; }
    get armed() { return !!this.cal; }
    sample(axes, now, canCapture) {
      if (!axes) return;
      if (!this.cal) {
        if (!canCapture) { this.stable = []; return; }
        const which = Math.abs(axes.y.z) >= Math.abs(axes.x.z) ? 'y' : 'x';   // portrait → y is up, landscape → x
        const upz = axes[which].z;
        const sgn = upz >= 0 ? 1 : -1;
        const pose = Math.abs(axes.z.z) > 0.5 || Math.abs(upz) < 0.7 ? null : uprightPose(axes, which, sgn);
        if (!pose) { this.stable = []; return; }
        this.stable.push({ ...pose, at: now });
        this.stable = this.stable.filter((e) => now - e.at <= 650);
        if (this.stable.length >= 10 && now - this.stable[0].at >= 450
          && spread(this.stable.map((e) => e.angle)) < 3 && spread(this.stable.map((e) => e.pitch)) < 3) {
          this.cal = { which, sgn, angle0: pose.angle, pitch0: pose.pitch };
          this.stable = [];
        }
        return;
      }
      const pose = uprightPose(axes, this.cal.which, this.cal.sgn);
      if (!pose) { this.steer = 0; this.gas = 0; this.brake = 0; return; }
      const d = wrap180(pose.angle - this.cal.angle0);
      const a = Math.abs(d);
      const steer = a <= UPRIGHT_DEADZONE ? 0 : Math.sign(d) * Math.min(1, (a - UPRIGHT_DEADZONE) / (UPRIGHT_FULL - UPRIGHT_DEADZONE));
      const dp = pose.pitch - this.cal.pitch0;
      const ease = (cur, target) => { const v = cur + (target - cur) * 0.5; return v < 0.01 ? 0 : v; };
      this.steer = Math.abs(steer) < 0.01 ? 0 : this.steer + (steer - this.steer) * 0.6;
      this.gas = ease(this.gas, shapePedal(dp));
      this.brake = ease(this.brake, shapePedal(-dp));
    }
  }

  /** Pure: build a Gamepad-like snapshot from the wheel state. */
  function buildPad(state, now, vibration) {
    const buttons = Array.from({ length: BUTTON_COUNT }, () => ({ pressed: false, touched: false, value: 0 }));
    const set = (i, value) => { buttons[i] = { pressed: value > 0.5, touched: value > 0, value }; };
    const held = state.buttons || {};
    let steer = 0;
    if (state.menu) {
      // In menus the phone is a pointer: nothing steers or presses a pedal (the left stick would move the menu focus).
      // Only short "pulses" (B = back) reach the game as gamepad buttons; A clicks at the cursor instead.
      for (const [index, until] of Object.entries(state.pulses || {})) if (until > now) set(Number(index), 1);
    } else {
      for (const [name, index] of Object.entries(MAP)) if (held[name]) set(index, 1);
      const brake = state.brakeValue !== undefined ? state.brakeValue : state.brake ? 1 : 0;
      const gas = state.gasValue !== undefined ? state.gasValue : state.gas ? 1 : 0;
      if (brake > 0) set(LT, Math.min(1, brake));
      if (gas > 0) set(RT, Math.min(1, gas));
      steer = Math.max(-1, Math.min(1, Number(state.steer) || 0));
    }
    return {
      id: PAD_ID,
      index: 0,
      connected: true,
      mapping: 'standard',
      timestamp: now,
      axes: [steer, 0, 0, 0],
      buttons,
      vibrationActuator: vibration || null,
      hapticActuators: [],
    };
  }

  if (typeof module === 'object' && module && module.exports) {
    module.exports = { buildPad, pedalCalibrate, pedalRead, UprightWheel, uprightPose, PAD_ID, MAP, BUTTON_COUNT, PEDAL_DEADZONE, PEDAL_FULL, UPRIGHT_DEADZONE, UPRIGHT_FULL };
    return;
  }

  if (typeof window.io !== 'function' || !navigator) return;   // opened outside OpenWii: leave the game alone

  const state = { present: false, menu: false, pulses: {}, steer: 0, gas: false, brake: false, gasValue: 0, brakeValue: 0, buttons: {} };
  const pedals = { gas: 0, brake: 0, ref: null, cal: null };
  const upright = new UprightWheel();
  let wheel = null;
  let captureUntil = 0;
  let lastRumble = 0;
  let announced = false;

  const link = window.io();
  link.on('connect', () => link.emit('register', 'game'));

  // ── Rumble: the game calls vibrationActuator.playEffect(); forward it to the phone ──
  const vibration = {
    type: 'dual-rumble',
    playEffect(_type, params) {
      const p = params || {};
      const strength = Math.max(p.strongMagnitude || 0, p.weakMagnitude || 0);
      const now = performance.now();
      if (state.present && strength > 0.15 && now - lastRumble > 110) {
        lastRumble = now;
        const ms = Math.round(Math.max(20, Math.min(220, p.duration || 40)));
        link.emit('feedback', { type: 'rumble', pattern: [ms], slot: 0 });
      }
      return Promise.resolve('complete');
    },
    reset() { return Promise.resolve('complete'); },
  };

  // ── Make navigator.getGamepads() include the phone ──
  const realGetGamepads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads.bind(navigator) : () => [];
  function refresh() {
    const now = performance.now();
    if (state.menu) { state.steer = 0; state.gas = false; state.brake = false; state.gasValue = 0; state.brakeValue = 0; state.buttons = {}; return now; }
    if (!wheel) { state.steer = 0; state.gas = false; state.brake = false; state.gasValue = 0; state.brakeValue = 0; state.buttons = {}; return now; }
    const r = wheel.read(now);
    const uprightOn = upright.armed && !wheel.armed;       // which way the phone was held when it was levelled
    state.steer = uprightOn ? (r.live ? upright.steer : 0) : r.steer;
    state.gas = !!r.gas;
    state.brake = !!r.brake;
    // Tilt pedals count only while the wheel is levelled and its signal is live; the 1 / 2 buttons press fully.
    const tilt = r.live && (wheel.armed || upright.armed);
    const tiltGas = uprightOn ? upright.gas : pedals.gas;
    const tiltBrake = uprightOn ? upright.brake : pedals.brake;
    state.gasValue = Math.max(r.gas ? 1 : 0, tilt ? tiltGas : 0);
    state.brakeValue = Math.max(r.brake ? 1 : 0, tilt ? tiltBrake : 0);
    state.buttons = now - (wheel.lastButtonsAt || 0) < 650 ? wheel.buttons : {};
    return now;
  }
  Object.defineProperty(navigator, 'getGamepads', {
    configurable: true,
    value() {
      const real = Array.from(realGetGamepads() || []).filter(Boolean);
      if (!state.present) return real;
      return [buildPad(state, refresh(), vibration), ...real];
    },
  });

  function announce(connected) {
    if (connected === announced) return;
    announced = connected;
    const pad = buildPad(state, performance.now(), vibration);
    const ev = new Event(connected ? 'gamepadconnected' : 'gamepaddisconnected');
    ev.gamepad = pad;
    window.dispatchEvent(ev);
  }

  link.on('presence', (p) => {
    const present = !!(p && p.slots && p.slots[0] && p.slots[0].occupied);
    if (present && !state.present) captureUntil = performance.now() + 4000;   // first level, shortly after connecting
    state.present = present;
    announce(present);
    if (present) {
      sendProfile();                                    // pointer layout in menus, wheel layout when driving
      if (state.menu && pointer) pointer.recentre();
    }
    if (present) toast('Hold the phone like a wheel (or flat like a tray), then press − to recentre · forward = gas, back = brake');
  });

  // The phone shows its steering-wheel layout only while a game keeps asking for it; in menus it needs the pointer layout.
  function sendProfile() {
    if (state.present) link.emit('feedback', { type: 'controller-profile', profile: state.menu ? 'default' : 'wheel', slot: 0 });
  }
  setInterval(sendProfile, 850);

  // ── Menus: the phone is a pointer (aim = cursor, A = click, B = back) until the race starts ──
  const CLICKABLE = 'button, a[href], [role="button"], [role="radio"], [role="checkbox"], [role="tab"], '
    + '[role="switch"], [role="option"], [role="menuitem"], input, select, label, summary';
  let pointer = null;
  let lastPointerAt = 0;
  (window.__owLoad || ((u) => import(u)))('/core/pointer.js').then((m) => {
    pointer = new m.Pointer({});
    pointer.setViewport(window.innerWidth || 1, window.innerHeight || 1);
  }).catch((err) => console.warn('[openwii] pointer unavailable', err));
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('resize', () => { if (pointer) pointer.setViewport(window.innerWidth, window.innerHeight); });
  }

  /** True while any LibreCorsa menu (title, setup, pause, settings…) is on screen: they all use focus zones. */
  function menuOpen() {
    try { return !!document.querySelector('[data-nav-zone]'); } catch (e) { return false; }
  }

  function targetAt(x, y) {
    try {
      const el = document.elementFromPoint(x, y);
      return el && el.closest ? el.closest(CLICKABLE) : null;
    } catch (e) { return null; }
  }

  function clickAt(x, y) {
    const t = targetAt(x, y);
    if (!t) return false;
    if (t.tagName === 'INPUT' && t.type === 'range') {                  // sliders: set the value from where the cursor is
      const r = t.getBoundingClientRect();
      const min = Number(t.min || 0), max = Number(t.max || 100), step = Number(t.step || 1);
      const ratio = Math.max(0, Math.min(1, (x - r.left) / Math.max(1, r.width)));
      const value = Math.round((min + ratio * (max - min)) / step) * step;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (setter && setter.set) setter.set.call(t, String(value)); else t.value = String(value);
      t.dispatchEvent(new Event('input', { bubbles: true }));
      t.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    const o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, view: window };
    const po = { ...o, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    t.dispatchEvent(new PointerEvent('pointerdown', po));
    t.dispatchEvent(new MouseEvent('mousedown', o));
    t.dispatchEvent(new PointerEvent('pointerup', po));
    t.dispatchEvent(new MouseEvent('mouseup', o));
    t.click();
    return true;
  }

  let cursorEl = null;
  let hiliteEl = null;
  function ensureCursor() {
    if (cursorEl || !document.body) return !!cursorEl;
    cursorEl = document.createElement('div');
    cursorEl.innerHTML = '<svg width="34" height="34" viewBox="0 0 34 34"><path d="M4 2 L4 26 L10 20.5 L14.5 30 L19 28 L14.6 18.6 L22.5 18.4 Z" '
      + 'fill="#fff" stroke="#10151f" stroke-width="2.2" stroke-linejoin="round"/></svg>';
    cursorEl.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483001;pointer-events:none;display:none;'
      + 'filter:drop-shadow(0 2px 3px rgba(0,0,0,.55));will-change:transform;';
    hiliteEl = document.createElement('div');
    hiliteEl.style.cssText = 'position:fixed;z-index:2147483000;pointer-events:none;display:none;border:2px solid #ffd331;'
      + 'border-radius:8px;box-shadow:0 0 0 2px rgba(0,0,0,.35),0 0 14px rgba(255,211,49,.6);';
    document.body.appendChild(hiliteEl);
    document.body.appendChild(cursorEl);
    return true;
  }

  function hideCursor() {
    if (cursorEl) cursorEl.style.display = 'none';
    if (hiliteEl) hiliteEl.style.display = 'none';
  }

  function updateCursor(now) {
    const show = state.present && state.menu && pointer && pointer.live && now - pointer.lastSeen < 700;
    if (!show || !ensureCursor()) { hideCursor(); return; }
    const a = pointer.sampleAt(now);
    const x = a.x * window.innerWidth, y = a.y * window.innerHeight;
    cursorEl.style.display = 'block';
    cursorEl.style.transform = 'translate(' + (x - 4) + 'px,' + (y - 2) + 'px)';
    const t = targetAt(x, y);
    if (t) {
      const r = t.getBoundingClientRect();
      Object.assign(hiliteEl.style, { display: 'block', left: r.left - 3 + 'px', top: r.top - 3 + 'px', width: r.width + 6 + 'px', height: r.height + 6 + 'px' });
    } else hiliteEl.style.display = 'none';
  }

  function setMenu(open, now) {
    if (open === state.menu) return;
    state.menu = open;
    state.pulses = {};
    if (open) {
      if (pointer) pointer.recentre();                  // start from the middle of the screen
    } else {
      // The race is starting: drop the pointer and re-learn the driving pose from however the phone is held now.
      hideCursor();
      if (wheel) wheel.reset();
      upright.reset();
      pedals.ref = null; pedals.cal = null; pedals.gas = 0; pedals.brake = 0;
      toast('Hold the phone like a wheel (or flat like a tray) and keep it still to set neutral');
    }
    sendProfile();
  }

  /** One step of the menu watcher + cursor; runs every animation frame (and is callable for tests). */
  function tick() {
    const now = performance.now();
    setMenu(menuOpen(), now);
    updateCursor(now);
  }
  window.openwiiPad = { tick };
  if (typeof window.requestAnimationFrame === 'function') {
    const loop = () => { tick(); window.requestAnimationFrame(loop); };
    window.requestAnimationFrame(loop);
  }

  // ── Phone input → the shared WheelInput from Mario Kart (same tilt maths and level calibration) ──
  (window.__owLoad || ((u) => import(u)))('/games/mario-kart/input.js').then((m) => { wheel = new m.WheelInput(); }).catch((err) => {
    console.warn('[openwii] steering input unavailable', err);
  });

  link.on('orientation', (s) => {
    if (!s || s.slot !== 0) return;
    const now = performance.now();
    if (pointer) {
      const dt = lastPointerAt ? Math.min(0.1, Math.max(1 / 240, (now - lastPointerAt) / 1000)) : 1 / 60;
      lastPointerAt = now;
      pointer.update(s, dt, now);
    }
    if (!wheel || state.menu) return;                  // menus only need the pointer; the wheel learns when driving starts
    const learning = (!wheel.armed && !upright.armed) || now < captureUntil;
    wheel.sample(s, now, { canCapture: learning && !upright.armed });   // flat (tray) pose
    upright.sample(wheel.lastAxes, now, learning && !wheel.armed);        // upright (wheel) pose
    if (wheel.ref && wheel.lastAxes) {
      if (pedals.ref !== wheel.ref) {                  // the wheel was just (re)levelled: this is the rest pose
        pedals.ref = wheel.ref;
        pedals.cal = pedalCalibrate(wheel.lastAxes, wheel.ref);
        pedals.gas = 0; pedals.brake = 0;
      }
      const t = pedalRead(wheel.lastAxes, pedals.cal);
      pedals.gas += (t.gas - pedals.gas) * 0.5;        // light smoothing against hand jitter
      pedals.brake += (t.brake - pedals.brake) * 0.5;
      if (pedals.gas < 0.01) pedals.gas = 0;             // no lingering "touched" value once released
      if (pedals.brake < 0.01) pedals.brake = 0;
    } else {
      pedals.ref = null; pedals.cal = null; pedals.gas = 0; pedals.brake = 0;
    }
  });

  link.on('command', (c) => {
    if (!c || c.slot !== 0) return;
    if (c.type === 'home') { if (window.openwiiExit) window.openwiiExit(); return; }
    const t0 = performance.now();
    if (state.menu) {                                   // pointer menus
      if (c.type === 'button' && c.button === 'A' && c.pressed !== false) {
        if (pointer && pointer.live) { const a = pointer.sampleAt(t0); clickAt(a.x * window.innerWidth, a.y * window.innerHeight); }
      } else if (c.type === 'button' && c.button === 'B' && c.pressed !== false) {
        state.pulses[1] = t0 + 160;                      // gamepad B = back / cancel
      } else if (c.type === 'recentre' || c.type === 'calibrate') {
        if (pointer) pointer.recentre();
      } else if (c.type === 'speed' && pointer) {
        pointer.sensitivity = Math.max(0.2, Math.min(6, pointer.sensitivity * (c.factor || 1)));
      }
      return;
    }
    if (!wheel) return;
    const now = t0;
    wheel.command(c, now);
    if (c.type === 'recentre' || c.type === 'calibrate') { wheel.reset(); upright.reset(); captureUntil = now + 10000; }
  });

  // ── Small on-screen helpers: a way back to the launcher, and a hint ──
  function onReady(fn) {
    if (document.body) fn(); else document.addEventListener('DOMContentLoaded', fn, { once: true });
  }
  let toastEl = null;
  let toastTimer = 0;
  function toast(text) {
    onReady(() => {
      if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483000;'
          + 'padding:8px 16px;border-radius:99px;background:rgba(10,14,22,.8);color:#fff;pointer-events:none;'
          + 'font:600 14px -apple-system,system-ui,sans-serif;transition:opacity .4s;';
        document.body.appendChild(toastEl);
      }
      toastEl.textContent = text;
      toastEl.style.opacity = '1';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, 6000);
    });
  }

  onReady(() => {
    if (!window.openwiiExit) return;
    const back = document.createElement('button');
    back.textContent = '⌂ Games';
    back.setAttribute('aria-label', 'Back to the OpenWii launcher');
    back.style.cssText = 'position:fixed;left:8px;top:8px;z-index:2147483000;padding:6px 12px;border:0;'
      + 'border-radius:99px;background:rgba(10,14,22,.55);color:#fff;opacity:.6;'
      + 'font:600 13px -apple-system,system-ui,sans-serif;';
    back.addEventListener('click', () => window.openwiiExit());
    document.body.appendChild(back);
  });
})();
