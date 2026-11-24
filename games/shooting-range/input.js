import { Pointer } from '../../core/pointer.js';
import { GameLink } from '../../core/net.js';
import { AudioEngine } from '../../core/audio.js';
import { goHome } from '../../core/splash.js';
import { saveSensitivity, loadSensitivity } from '../../core/calibration.js';
import { clamp } from '../../core/orientation.js';

/**
 * Multi-player channel for Shooting Range.
 *
 * core/channel.js is single-player: one Pointer, and every phone's samples
 * and button presses land on it. This is the same wiring with one Pointer
 * PER PLAYER SLOT, so phone 1 and phone 2 each steer their own crosshair
 * and each A press says who fired. The relay already tags every packet
 * with the sender's slot (GameLink hands it over as the last argument).
 *
 * Keyboard and mouse stand in for player 1 only, for desk testing and solo
 * play. Everything else behaves like createChannel.
 */
export function createPlayersChannel({
  players = 2,
  onA = () => {},               // (slot) — a player pressed A
  onSolo = () => {},            // Space / Enter — start now, without waiting
  onB = null,                   // default: HOME chime + fade back to the menu
  onPresence = () => {},        // (connected: boolean[]) — which phones are in
} = {}) {
  const $ = (id) => document.getElementById(id);
  const audio = new AudioEngine();
  const sensitivity = loadSensitivity() ?? 1;
  const pointers = Array.from({ length: players }, () => {
    const p = new Pointer({});
    p.sensitivity = sensitivity;
    return p;
  });
  const setSensitivity = (v) => {
    for (const p of pointers) p.sensitivity = v;
    saveSensitivity(v);
  };

  const lastSampleAt = new Array(players).fill(0);
  const connected = new Array(players).fill(false);

  const link = new GameLink({
    onOrientation: (sample, slot = 0) => {
      const p = pointers[slot];
      if (!p) return;                           // a 3rd/4th phone just watches
      const now = performance.now();
      const dt = lastSampleAt[slot]
        ? clamp((now - lastSampleAt[slot]) / 1000, 1 / 240, 0.1) : 1 / 60;
      lastSampleAt[slot] = now;
      p.update(sample, dt, now);
    },
    onCommand: (cmd, slot = 0) => {
      const p = pointers[slot];
      if (!p) return;
      if (cmd.type === 'button' && cmd.button === 'A') { audio.unlock(); onA(slot); }
      else if (cmd.type === 'button' && cmd.button === 'B') (onB || (() => goHome(audio)))();
      else if (cmd.type === 'calibrate' || cmd.type === 'recentre') p.recentre();
      else if (cmd.type === 'speed') {
        setSensitivity(clamp(p.sensitivity * (cmd.factor || 1), 0.2, 6));
      }
    },
    onPresence: (pres) => {
      for (let i = 0; i < players; i += 1) {
        connected[i] = !!(pres.slots && pres.slots[i] && pres.slots[i].occupied);
      }
      onPresence(connected.slice());
    },
  });

  // Mouse + keyboard: player 1 only.
  const mouse = { x: 0.5, y: 0.5, active: false };
  window.addEventListener('mousemove', (e) => {
    mouse.x = e.clientX / window.innerWidth;
    mouse.y = e.clientY / window.innerHeight;
    mouse.active = true;
  });
  window.addEventListener('pointerdown', (e) => {
    if (Number.isFinite(e.clientX)) {
      mouse.x = e.clientX / window.innerWidth;
      mouse.y = e.clientY / window.innerHeight;
      mouse.active = true;
    }
    audio.unlock();
    onA(0);
  });
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      audio.unlock();
      onSolo();
    } else if (k === 'b' || e.key === 'Escape') (onB || (() => goHome(audio)))();
    else if (k === 'c' || k === 'r') pointers.forEach((p) => p.recentre());
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const step = e.key === 'ArrowRight' ? 1.12 : 1 / 1.12;
      setSensitivity(clamp(pointers[0].sensitivity * step, 0.2, 6));
    } else if (k === 'd') {
      const dbg = $('debug');
      if (dbg) dbg.classList.toggle('on');
    }
  });

  /**
   * Call once per frame. Returns each player's aim as {x, y} in [0,1].
   * Player 1 falls back to the mouse when no phone is steering them.
   */
  function poll(now) {
    if (!pointers[0].live && mouse.active) pointers[0].setFromMouse(mouse.x, mouse.y);
    for (const p of pointers) {
      if (p.live && now - p.lastSeen > 500) p.live = false;
    }
    return pointers.map((p) => p.sampleAt(now));
  }

  return {
    pointers,
    audio,
    link,
    mouse,
    connected,
    poll,
    /** Rumble one player's phone (the relay routes by slot). */
    feedback: (slot, msg) => link.feedback({ ...msg, slot }),
  };
}
