import { createChannel } from '../../core/channel.js';
import { consumeLaunchSplash } from '../../core/splash.js';

consumeLaunchSplash();

/**
 * Blockcraft adapter.
 *
 * Blockcraft runs unmodified in an iframe (blockcraft.html). Its own touch
 * controls stay in charge of walking, jumping, placing and the hotbar. This
 * file adds the phone: its gyro turns the camera, and A attacks / mines.
 *
 * The game keeps its state in top-level const/let (player, miningHeld, ...),
 * which window properties can't reach but code evaluated in the iframe's global
 * scope can, so one small helper is installed there when the page loads.
 *
 * URL options:  ?look=1    look speed multiplier (1 = turn as far as the phone turns)
 *               ?invertX=1 / ?invertY=1  flip an axis
 *               ?hold=800  ms that A keeps mining after a press (raise for hard blocks)
 */

const params = new URLSearchParams(location.search);
const RAD = Math.PI / 180;
const LOOK = Number(params.get('look')) || 1;
const HOLD_MS = Number(params.get('hold')) || 800;
const sx = params.has('invertX') ? -1 : 1;
const sy = params.has('invertY') ? -1 : 1;

const frame = document.getElementById('game');
const overlay = document.getElementById('overlay');
const note = document.getElementById('note');

const HELPER = `(() => {
  const canAct = () => gameActive && !inventoryOpen && !saveCodeOpen && !furnaceOpen && !chestOpen;
  window.__ow = {
    look(dYaw, dPitch) {
      if (!canAct()) return;
      player.yaw += dYaw;
      player.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, player.pitch + dPitch));
    },
    attackStart() {
      if (!canAct()) return false;
      const target = tryBreakBlock();
      if (target && target.type === 'block') miningHeld = true;
      return true;
    },
    attackStop() { stopMining(); },
  };
})()`;

function install() {
  try {
    frame.contentWindow.eval(HELPER);
    if (note) note.textContent = '';
  } catch (err) {
    console.error(err);
    if (note) note.textContent = 'Could not hook into Blockcraft: ' + err.message;
  }
}
frame.addEventListener('load', install);

const game = () => {
  try {
    const w = frame.contentWindow;
    return w && w.__ow ? w.__ow : null;
  } catch {
    return null;
  }
};

let stopTimer = null;
function attack() {
  const g = game();
  if (!g) return;
  if (g.attackStart()) {
    clearTimeout(stopTimer);
    stopTimer = setTimeout(() => {
      g.attackStop();
      stopTimer = null;
    }, HOLD_MS);
  }
}

const channel = createChannel({
  onA: attack,
  onSample: (_sample, dt) => {
    const g = game();
    if (!g) return;
    const rate = channel.pointer.rateDps;
    // Pointer: +yaw = turning left, +pitch = tilting up. Blockcraft: +player.yaw
    // turns left and +player.pitch looks up, so the signs carry straight across.
    g.look(rate.yaw * dt * RAD * LOOK * sx, rate.pitch * dt * RAD * LOOK * sy);
  },
});

overlay.addEventListener('click', () => overlay.classList.add('hide'));
