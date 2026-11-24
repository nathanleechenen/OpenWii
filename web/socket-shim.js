/**
 * OpenWii web transport — a drop-in replacement for socket.io-client.
 *
 * The static site serves this file at /socket.io/socket.io.js, so every page
 * that already does `<script src="/socket.io/socket.io.js">` and calls `io()`
 * keeps working with no edits. Instead of a Node relay, the iPad itself is the
 * relay ("hub") and phones connect to it directly over WebRTC data channels
 * (PeerJS handles the one-off introduction between the devices).
 *
 *   phone  ──WebRTC──▶  hub (launcher page on the iPad)  ──▶  game
 *                                                          (iframe, via postMessage)
 *
 * Roles are picked from where the script runs:
 *   • /controller page          → ControllerSocket (dials the iPad's room)
 *   • top-level page (launcher) → Hub + LocalSocket (menu talks to hub in-process)
 *   • inside the launcher's iframe → FrameSocket (game talks to the parent hub)
 *
 * Event names and payloads are exactly the ones server.js used:
 *   register, presence, slot, slot-denied, orientation, motion, command,
 *   feedback, ping-probe, pong-probe.
 */
(() => {
  'use strict';

  const PEER_SRC = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
  const QR_SRC = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
  const MAX_PLAYERS = 4;
  const PEER_PREFIX = 'openwii-';
  const ROOM_KEY = 'openwii.room';
  const CLIENT_KEY = 'openwii.cid';
  const HB_MS = 2000;          // heartbeat period, both directions
  const DEAD_MS = 7000;        // silence longer than this = connection is dead
  const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  // Public STUN servers plus a free public TURN relay as a last resort, for
  // networks where phones and iPad cannot reach each other directly.
  const ICE_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
      {
        urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443?transport=tcp'],
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
    ],
  };

  // ── Small utilities ────────────────────────────────────────────────────────
  class Emitter {
    constructor() { this._h = {}; }
    on(ev, fn) { (this._h[ev] || (this._h[ev] = [])).push(fn); return this; }
    off(ev, fn) { this._h[ev] = (this._h[ev] || []).filter((f) => f !== fn); return this; }
    _fire(ev, data) {
      for (const fn of (this._h[ev] || []).slice()) {
        try { fn(data); } catch (err) { console.error('[openwii]', ev, err); }
      }
    }
  }

  // ── Hub core: slots, presence, routing. No browser or network dependencies,
  // so it can be unit-tested in Node. It is a straight port of server.js.
  class HubCore {
    constructor() {
      this.games = new Set();                       // { kind, deliver(ev, data) }
      this.ctrls = new Set();                       // { cid, registered, send, close }
      this.slots = new Array(MAX_PLAYERS).fill(null);
      this.lastSlot = new Map();                    // cid → slot it last held
      this.localEnabled = true;                     // false while a game iframe is on top
    }

    slotOf(c) { return this.slots.indexOf(c); }

    presence() {
      let controller = 0;
      for (const c of this.ctrls) if (c.registered) controller += 1;
      return {
        game: this.games.size,
        controller,
        slots: this.slots.map((c, i) => ({ slot: i, occupied: c !== null })),
      };
    }

    broadcastPresence() {
      const p = this.presence();
      for (const g of this.games) g.deliver('presence', p);
      for (const c of this.ctrls) if (c.registered) c.send('presence', p);
    }

    _toGames(ev, data) {
      for (const g of this.games) {
        if (g.kind === 'local' && !this.localEnabled) continue;
        g.deliver(ev, data);
      }
    }

    addGame(g) {
      if (this.games.has(g)) return;
      this.games.add(g);
      this.broadcastPresence();
    }

    removeGame(g) {
      if (this.games.delete(g)) this.broadcastPresence();
    }

    addCtrl(c) { this.ctrls.add(c); }

    removeCtrl(c) {
      if (!this.ctrls.delete(c)) return;
      const i = this.slots.indexOf(c);
      if (i !== -1) this.slots[i] = null;
      this.broadcastPresence();
    }

    /** A message arrived from a phone. */
    fromCtrl(c, ev, data) {
      switch (ev) {
        case 'register': {
          if (data !== 'controller') return;
          c.registered = true;
          // A phone that reconnected before its old link timed out: reclaim its seat.
          for (let i = 0; i < MAX_PLAYERS; i += 1) {
            const old = this.slots[i];
            if (old && old !== c && old.cid === c.cid) {
              this.slots[i] = null;
              this.ctrls.delete(old);
              try { old.close(); } catch { /* already gone */ }
            }
          }
          let slot = this.lastSlot.get(c.cid);
          if (slot === undefined || this.slots[slot] !== null) slot = this.slots.indexOf(null);
          if (slot === -1) {
            c.send('slot-denied', { reason: 'all player slots full', max: MAX_PLAYERS });
            return;
          }
          this.slots[slot] = c;
          this.lastSlot.set(c.cid, slot);
          c.send('slot', { slot });
          this.broadcastPresence();
          return;
        }
        case 'orientation':
        case 'motion':
        case 'command':
          this._toGames(ev, { ...data, slot: this.slotOf(c) });
          return;
        case 'pong-probe':
          this._toGames('pong-probe', data);
          return;
        default:
      }
    }

    /** A message arrived from a game (the menu, or a game iframe). */
    fromGame(g, ev, data) {
      switch (ev) {
        case 'register':
          if (data === 'game') this.addGame(g);
          return;
        case 'ping-probe':
          for (const c of this.ctrls) if (c.registered) c.send('ping-probe', data);
          return;
        case 'feedback': {
          // A message with a slot buzzes that one phone; without one it goes to all.
          const target = data && typeof data.slot === 'number' ? this.slots[data.slot] : null;
          if (target) target.send('feedback', data);
          else for (const c of this.ctrls) if (c.registered) c.send('feedback', data);
          return;
        }
        default:
      }
    }
  }

  // Node (tests) gets the pure core and stops here; browsers continue.
  if (typeof module === 'object' && module && module.exports) {
    module.exports = { HubCore, Emitter, MAX_PLAYERS };
    return;
  }

  // ── Browser helpers ────────────────────────────────────────────────────────
  const store = {
    get(k) { try { return window.localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  function randomString(n, alphabet) {
    const bytes = new Uint8Array(n);
    window.crypto.getRandomValues(bytes);
    let s = '';
    for (let i = 0; i < n; i += 1) s += alphabet[bytes[i] % alphabet.length];
    return s;
  }
  const newRoom = () => randomString(6, ROOM_ALPHABET);

  const scriptCache = {};
  function loadScript(src, globalName) {
    if (window[globalName]) return Promise.resolve();
    if (scriptCache[src]) return scriptCache[src];
    scriptCache[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => { delete scriptCache[src]; reject(new Error(`failed to load ${src}`)); };
      document.head.appendChild(s);
    });
    return scriptCache[src];
  }

  const isController = /\/controller(\.html)?\/?$/.test(window.location.pathname);
  const inFrame = (() => { try { return window.top !== window; } catch { return true; } })();

  // ── Hub (browser side): owns the PeerJS endpoint and the game iframe ───────
  class Hub {
    constructor() {
      this.core = new HubCore();
      this.room = store.get(ROOM_KEY) || newRoom();
      store.set(ROOM_KEY, this.room);
      this.status = 'connecting…';
      this.peer = null;
      this.frame = null;
      this.bridge = null;
      this.onExit = null;
      this.unavailableTries = 0;
      this.label = null;
      this.gameOpen = false;

      window.addEventListener('message', (e) => this._onFrameMessage(e));
      window.setInterval(() => this._tick(), HB_MS);
      this._open();
    }

    // -- signalling endpoint --
    async _open() {
      try {
        await loadScript(PEER_SRC, 'Peer');
      } catch {
        this._setStatus('offline — cannot reach PeerJS');
        window.setTimeout(() => this._open(), 5000);
        return;
      }
      const peer = new window.Peer(PEER_PREFIX + this.room, { config: ICE_CONFIG, debug: 1 });
      this.peer = peer;
      peer.on('open', () => { this.unavailableTries = 0; this._setStatus('ready'); });
      peer.on('connection', (conn) => this._accept(conn));
      peer.on('disconnected', () => {
        this._setStatus('reconnecting…');
        window.setTimeout(() => { try { if (!peer.destroyed) peer.reconnect(); } catch { /* retry on next tick */ } }, 1000);
      });
      peer.on('error', (err) => {
        if (err && err.type === 'unavailable-id') {
          // Our previous page's id is still held by the broker for a moment.
          this.unavailableTries += 1;
          try { peer.destroy(); } catch { /* ignore */ }
          if (this.unavailableTries > 15) {
            store.set(ROOM_KEY, newRoom());
            window.location.reload();
            return;
          }
          this._setStatus('waiting for room…');
          window.setTimeout(() => this._open(), 2000);
        } else if (err && (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error' || err.type === 'socket-closed')) {
          this._setStatus('reconnecting…');
        }
      });
    }

    _accept(conn) {
      const meta = conn.metadata || {};
      const ctrl = {
        cid: meta.cid || conn.peer,
        registered: false,
        last: Date.now(),
        send: (ev, data) => { if (conn.open) { try { conn.send([ev, data]); } catch { /* dropped */ } } },
        close: () => { try { conn.close(); } catch { /* already closed */ } },
      };
      conn.on('open', () => { ctrl.last = Date.now(); this.core.addCtrl(ctrl); this._updateLabel(); });
      conn.on('data', (m) => {
        ctrl.last = Date.now();
        if (Array.isArray(m) && m[0] !== 'hb') this.core.fromCtrl(ctrl, m[0], m[1]);
      });
      const gone = () => { this.core.removeCtrl(ctrl); this._updateLabel(); };
      conn.on('close', gone);
      conn.on('error', gone);
    }

    _tick() {
      const now = Date.now();
      for (const c of [...this.core.ctrls]) {
        if (now - c.last > DEAD_MS) {
          c.close();
          this.core.removeCtrl(c);
        } else {
          c.send('hb', 0);
        }
      }
      this._updateLabel();
    }

    // -- pairing info for the launcher's QR button --
    async pairing() {
      const url = `${window.location.origin}/controller.html?room=${this.room}`;
      let qr = '';
      try {
        await loadScript(QR_SRC, 'qrcode');
        const q = window.qrcode(0, 'M');
        q.addData(url);
        q.make();
        qr = q.createDataURL(8, 3);
      } catch { /* the room code label still lets people join */ }
      return { url, qr, room: this.room };
    }

    // -- game iframe --
    open(url, onExit) {
      if (this.frame) return;
      const f = document.createElement('iframe');
      f.src = url;
      f.setAttribute('allow', 'fullscreen; autoplay; accelerometer; gyroscope');
      f.setAttribute('allowfullscreen', '');
      f.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;background:#000;z-index:2147483000;';
      this.frame = f;
      this.onExit = onExit || null;
      this.gameOpen = true;
      this.core.localEnabled = false;
      document.body.appendChild(f);
      this._updateLabel();
    }

    close() {
      if (!this.frame) return;
      this.frame.remove();
      this.frame = null;
      if (this.bridge) { this.core.removeGame(this.bridge); this.bridge = null; }
      this.gameOpen = false;
      this.core.localEnabled = true;
      const cb = this.onExit;
      this.onExit = null;
      this._updateLabel();
      if (cb) cb();
    }

    _onFrameMessage(e) {
      const m = e.data;
      if (!m || !m.__openwii || !this.frame || e.source !== this.frame.contentWindow) return;
      if (m.ctl === 'exit') { this.close(); return; }
      if (!this.bridge) {
        const win = e.source;
        this.bridge = {
          kind: 'frame',
          deliver: (ev, data) => {
            try { win.postMessage({ __openwii: 1, ev, data }, window.location.origin); } catch { /* frame gone */ }
          },
        };
      }
      this.core.fromGame(this.bridge, m.ev, m.data);
    }

    // -- tiny status pill so you can see the room code and linked remotes --
    _setStatus(s) { this.status = s; this._updateLabel(); }

    _updateLabel() {
      if (!document.body) return;
      if (!this.label) {
        this.label = document.createElement('div');
        this.label.style.cssText = 'position:fixed;left:8px;bottom:6px;z-index:5;padding:2px 9px;'
          + 'border-radius:10px;background:rgba(20,28,40,.45);color:#fff;pointer-events:none;'
          + 'font:11px/1.5 -apple-system,system-ui,sans-serif;';
        document.body.appendChild(this.label);
      }
      let n = 0;
      for (const c of this.core.ctrls) if (c.registered) n += 1;
      this.label.style.display = this.gameOpen ? 'none' : 'block';
      this.label.textContent = `Room ${this.room} · ${n} remote${n === 1 ? '' : 's'} · ${this.status}`;
    }
  }

  // ── Sockets handed back by io() ────────────────────────────────────────────
  const fakeEngine = (name) => ({ engine: { transport: { name } } });

  /** The launcher's own client: talks to the hub in the same page. */
  class LocalSocket extends Emitter {
    constructor(hub) {
      super();
      this.kind = 'local';
      this.hub = hub;
      this.connected = false;
      this.io = fakeEngine('local');
      window.setTimeout(() => { this.connected = true; this._fire('connect'); }, 0);
    }
    emit(ev, data) { this.hub.core.fromGame(this, ev, data); return this; }
    deliver(ev, data) { this._fire(ev, data); }
  }

  /** A game inside the launcher's iframe: talks to the parent hub. */
  class FrameSocket extends Emitter {
    constructor() {
      super();
      this.connected = false;
      this.io = fakeEngine('frame');
      window.addEventListener('message', (e) => {
        const m = e.data;
        if (e.source === window.parent && m && m.__openwii && m.ev) this._fire(m.ev, m.data);
      });
      window.setTimeout(() => { this.connected = true; this._fire('connect'); }, 0);
    }
    emit(ev, data) {
      try { window.parent.postMessage({ __openwii: 1, ev, data }, window.location.origin); } catch { /* ignore */ }
      return this;
    }
  }

  /** The phone: dials the iPad's room and keeps redialling if the link drops. */
  class ControllerSocket extends Emitter {
    constructor() {
      super();
      this.connected = false;
      this.io = fakeEngine('webrtc');
      this.conn = null;
      this.peer = null;
      this.retryTimer = null;
      this.hbTimer = null;
      this.lastRx = 0;

      let cid = store.get(CLIENT_KEY);
      if (!cid) { cid = randomString(12, ROOM_ALPHABET); store.set(CLIENT_KEY, cid); }
      this.cid = cid;

      const fromUrl = new URLSearchParams(window.location.search).get('room');
      let room = (fromUrl || store.get(ROOM_KEY) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!room && typeof window.prompt === 'function') {
        room = (window.prompt('Enter the room code shown on the iPad') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      }
      this.room = room;
      if (room) store.set(ROOM_KEY, room);

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && !this.connected) this._redialSoon(0);
      });

      if (!room) {
        window.setTimeout(() => this._fire('connect_error', new Error('no room code')), 0);
        return;
      }
      this._boot();
    }

    async _boot() {
      try {
        await loadScript(PEER_SRC, 'Peer');
      } catch {
        this._fire('connect_error', new Error('cannot reach PeerJS'));
        this._redialSoon(3000, true);
        return;
      }
      const peer = new window.Peer(undefined, { config: ICE_CONFIG, debug: 1 });
      this.peer = peer;
      peer.on('open', () => this._dial());
      peer.on('disconnected', () => { try { if (!peer.destroyed) peer.reconnect(); } catch { /* next retry */ } });
      peer.on('error', (err) => {
        if (this.peer !== peer) return;
        if (err && err.type === 'peer-unavailable') {
          this._fire('connect_error', new Error('iPad not found'));
          this._failCurrent();
        } else if (err && (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error' || err.type === 'socket-closed')) {
          this._fire('connect_error', new Error(err.type));
        }
      });
    }

    _dial() {
      if (this.conn) return;
      if (!this.peer || this.peer.destroyed) { this._boot(); return; }
      if (this.peer.disconnected) {
        try { this.peer.reconnect(); } catch { /* fall through */ }
        this._redialSoon(1000);
        return;
      }
      const conn = this.peer.connect(PEER_PREFIX + this.room, {
        reliable: true, serialization: 'json', metadata: { cid: this.cid },
      });
      this.conn = conn;
      let opened = false;
      const timeout = window.setTimeout(() => { if (!opened) this._failCurrent(); }, 8000);

      conn.on('open', () => {
        opened = true;
        window.clearTimeout(timeout);
        this.connected = true;
        this.lastRx = Date.now();
        this._startHeartbeat();
        this._fire('connect');
      });
      conn.on('data', (m) => {
        this.lastRx = Date.now();
        if (Array.isArray(m) && m[0] !== 'hb') this._fire(m[0], m[1]);
      });
      conn.on('close', () => this._failCurrent(conn));
      conn.on('error', () => this._failCurrent(conn));
    }

    /** Tear down the current link (if it is `which`, or any when omitted) and redial. */
    _failCurrent(which) {
      const conn = this.conn;
      if (!conn || (which && which !== conn)) return;
      this.conn = null;
      window.clearInterval(this.hbTimer);
      const wasConnected = this.connected;
      this.connected = false;
      try { conn.close(); } catch { /* ignore */ }
      if (wasConnected) this._fire('disconnect');
      else this._fire('connect_error', new Error('iPad not reachable'));
      this._redialSoon(1200);
    }

    _startHeartbeat() {
      window.clearInterval(this.hbTimer);
      this.hbTimer = window.setInterval(() => {
        if (!this.connected) return;
        if (Date.now() - this.lastRx > DEAD_MS) { this._failCurrent(); return; }
        try { this.conn.send(['hb', 0]); } catch { /* next tick notices */ }
      }, HB_MS);
    }

    _redialSoon(ms) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = window.setTimeout(() => this._dial(), ms);
    }

    emit(ev, data) {
      if (!this.connected || !this.conn) return this;
      // Orientation and motion are "latest sample wins": if the link is backed up,
      // drop the stale sample instead of queueing it (queued samples = growing lag).
      if ((ev === 'orientation' || ev === 'motion') && this.conn.dataChannel
        && this.conn.dataChannel.bufferedAmount > 8192) return this;
      try { this.conn.send([ev, data]); } catch { /* the heartbeat will notice a dead link */ }
      return this;
    }
  }

  // ── Wire-up ────────────────────────────────────────────────────────────────
  let hub = null;
  if (!isController && !inFrame) {
    hub = new Hub();
    window.OpenWii = {
      room: hub.room,
      open: (url, onExit) => hub.open(url, onExit),
      close: () => hub.close(),
      pairing: () => hub.pairing(),
      get gameOpen() { return hub.gameOpen; },
      _hub: hub,
    };
  }

  if (inFrame && !isController) {
    window.openwiiExit = () => {
      try { window.parent.postMessage({ __openwii: 1, ctl: 'exit' }, window.location.origin); } catch { /* ignore */ }
    };
    // "← Games" style links go back to the launcher, not into the iframe.
    // Bubble phase + defaultPrevented check lets a game that handles the click
    // itself (Mario Kart plays a chime first) keep doing so.
    window.addEventListener('click', (e) => {
      if (e.defaultPrevented || !e.target || !e.target.closest) return;
      if (!e.target.closest('a[href="/"]')) return;
      e.preventDefault();
      window.openwiiExit();
    });

    // Safari only unlocks Web Audio after a tap *inside this frame*, so a game
    // started from a phone remote is silent until someone touches the iPad.
    // Track the game's audio contexts, resume them on the first touch, and show
    // a small hint while any of them is still locked.
    const audioContexts = [];
    for (const name of ['AudioContext', 'webkitAudioContext']) {
      const Native = window[name];
      if (!Native) continue;
      window[name] = class extends Native {
        constructor(...args) { super(...args); audioContexts.push(this); }
      };
    }
    const unlockAudio = () => { for (const c of audioContexts) { try { c.resume(); } catch { /* ignore */ } } };
    for (const ev of ['pointerdown', 'touchend', 'keydown']) window.addEventListener(ev, unlockAudio, { passive: true });
    let hint = null;
    window.setInterval(() => {
      const locked = audioContexts.some((c) => c.state !== 'running');
      if (!document.body) return;
      if (locked && !hint) {
        hint = document.createElement('div');
        hint.textContent = '🔊 Tap the iPad screen once to turn on sound';
        hint.style.cssText = 'position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:2147483000;'
          + 'padding:5px 14px;border-radius:14px;background:rgba(20,28,40,.7);color:#fff;pointer-events:none;'
          + 'font:600 13px -apple-system,system-ui,sans-serif;';
        document.body.appendChild(hint);
      } else if (!locked && hint) {
        hint.remove();
        hint = null;
      }
    }, 700);
  }

  window.io = function io() {
    if (isController) return new ControllerSocket();
    if (inFrame) return new FrameSocket();
    return new LocalSocket(hub);
  };
})();
