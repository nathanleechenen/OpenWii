/**
 * OpenWii → LibreCorsa bridge.
 *
 * Injected at the top of every LibreCorsa page (by scripts/build-static.mjs).
 * It makes phone P1 look like a standard Xbox gamepad to the game: tilt becomes
 * the left stick's X axis (steering), buttons become trigger / face buttons, and
 * rumble requests are sent back to the phone. LibreCorsa's own code is untouched:
 * it already polls navigator.getGamepads() every frame.
 *
 * Phone (wheel mode)      →  gamepad button            LibreCorsa default (GT layout)
 *   tilt                  →  axis 0                    steering
 *   2  (GAS)              →  RT (7), analog            throttle
 *   1  (BRAKE)            →  LT (6), analog            brake
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

  /** Pure: build a Gamepad-like snapshot from the wheel state. */
  function buildPad(state, now, vibration) {
    const buttons = Array.from({ length: BUTTON_COUNT }, () => ({ pressed: false, touched: false, value: 0 }));
    const set = (i, value) => { buttons[i] = { pressed: value > 0.5, touched: value > 0, value }; };
    const held = state.buttons || {};
    for (const [name, index] of Object.entries(MAP)) if (held[name]) set(index, 1);
    if (state.brake) set(LT, 1);
    if (state.gas) set(RT, 1);
    const steer = Math.max(-1, Math.min(1, Number(state.steer) || 0));
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
    module.exports = { buildPad, PAD_ID, MAP, BUTTON_COUNT };
    return;
  }

  if (typeof window.io !== 'function' || !navigator) return;   // opened outside OpenWii: leave the game alone

  const state = { present: false, steer: 0, gas: false, brake: false, buttons: {} };
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
    if (!wheel) { state.steer = 0; state.gas = false; state.brake = false; state.buttons = {}; return now; }
    const r = wheel.read(now);
    state.steer = r.steer;
    state.gas = !!r.gas;
    state.brake = !!r.brake;
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
    if (present) toast('Hold the phone sideways and level, then press − to recentre');
  });

  // The phone only shows its steering-wheel layout while a game keeps asking for it.
  setInterval(() => {
    if (state.present) link.emit('feedback', { type: 'controller-profile', profile: 'wheel', slot: 0 });
  }, 850);

  // ── Phone input → the shared WheelInput from Mario Kart (same tilt maths and level calibration) ──
  (window.__owLoad || ((u) => import(u)))('/games/mario-kart/input.js').then((m) => { wheel = new m.WheelInput(); }).catch((err) => {
    console.warn('[openwii] steering input unavailable', err);
  });

  link.on('orientation', (s) => {
    if (!wheel || !s || s.slot !== 0) return;
    const now = performance.now();
    wheel.sample(s, now, { canCapture: !wheel.armed || now < captureUntil });
  });

  link.on('command', (c) => {
    if (!c || c.slot !== 0) return;
    if (c.type === 'home') { if (window.openwiiExit) window.openwiiExit(); return; }
    if (!wheel) return;
    const now = performance.now();
    wheel.command(c, now);
    if (c.type === 'recentre' || c.type === 'calibrate') { wheel.reset(); captureUntil = now + 10000; }
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
