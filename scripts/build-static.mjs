#!/usr/bin/env node
/**
 * Builds the static, serverless OpenWii site into ./dist (for Cloudflare Pages).
 *
 * It reproduces the URL layout server.js used to serve, so no game needs to
 * change its imports:
 *   /                    ← public/*
 *   /games/…  /core/…  /assets/…
 *   /vendor/three, /vendor/three-examples   ← from node_modules/three
 *   /api/games, /api/session                ← generated JSON (replaces the server APIs)
 *   /socket.io/socket.io.js                 ← web/socket-shim.js (WebRTC transport)
 *
 * Source files are never modified; the few patches are applied to the copies in
 * ./dist and the build fails loudly if a patch no longer matches.
 *
 * Optional env var: SKIP_SOURCE_GLB=1 leaves out the *-source.glb model files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PAGES_FILE_LIMIT = 25 * 1024 * 1024 - 4096;     // Cloudflare Pages: 25 MiB per file
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'pipeline', 'tests', 'dist']);
const skippedBig = [];
let fileCount = 0;

function fail(msg) { console.error(`\nBUILD FAILED: ${msg}\n`); process.exit(1); }

function shouldSkipFile(name, full, size) {
  if (/\.test\.mjs$/.test(name) || name.endsWith('.md')) return true;
  if (process.env.SKIP_SOURCE_GLB === '1' && name.endsWith('-source.glb')) return true;
  if (size > PAGES_FILE_LIMIT) { skippedBig.push(`${path.relative(ROOT, full)} (${(size / 1048576).toFixed(1)} MB)`); return true; }
  return false;
}

function copyTree(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) copyTree(from, to);
    } else if (entry.isFile()) {
      const size = fs.statSync(from).size;
      if (shouldSkipFile(entry.name, from, size)) continue;
      fs.copyFileSync(from, to);
      fileCount += 1;
    }
  }
}

function patch(rel, edits) {
  const p = path.join(DIST, rel);
  if (!fs.existsSync(p)) fail(`cannot patch missing file ${rel}`);
  let s = fs.readFileSync(p, 'utf8');
  for (const [from, to] of edits) {
    const n = s.split(from).length - 1;
    if (n !== 1) fail(`patch for ${rel}: expected exactly 1 match of ${JSON.stringify(from.slice(0, 70))}, found ${n}`);
    s = s.replace(from, () => to);
  }
  fs.writeFileSync(p, s);
}

// ── 1. Copy the static trees ────────────────────────────────────────────────
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

copyTree(path.join(ROOT, 'public'), DIST);
copyTree(path.join(ROOT, 'games'), path.join(DIST, 'games'));
copyTree(path.join(ROOT, 'core'), path.join(DIST, 'core'));
copyTree(path.join(ROOT, 'assets'), path.join(DIST, 'assets'));

// ── 2. Three.js, exactly where server.js mounted it ─────────────────────────
const three = path.join(ROOT, 'node_modules', 'three');
if (!fs.existsSync(path.join(three, 'build'))) fail('node_modules/three is missing — the build command must run `npm ci --omit=dev` first.');
copyTree(path.join(three, 'build'), path.join(DIST, 'vendor', 'three'));
copyTree(path.join(three, 'examples', 'jsm'), path.join(DIST, 'vendor', 'three-examples'));

// ── 3. Transport shim, served at the Socket.IO URL games already load ───────
const shimDir = path.join(DIST, 'socket.io');
fs.mkdirSync(shimDir, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'web', 'socket-shim.js'), path.join(shimDir, 'socket.io.js'));

// ── 4. Replacement for the server's game-discovery and session APIs ─────────
const gamesRoot = path.join(ROOT, 'games');
// Faithful port of listGames() in server.js: game.json is optional, `hidden`
// games are left out, and `order` then title decide the sequence.
const games = fs.readdirSync(gamesRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(gamesRoot, e.name, 'index.html')))
  .map((e) => {
    const meta = { title: e.name, tagline: '', emoji: '🎮' };
    try {
      Object.assign(meta, JSON.parse(fs.readFileSync(path.join(gamesRoot, e.name, 'game.json'), 'utf8')));
    } catch { /* game.json is optional */ }
    return { slug: e.name, url: `/games/${e.name}/`, ...meta };
  })
  .filter((g) => !g.hidden)
  .sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.title.localeCompare(b.title));
const apiDir = path.join(DIST, 'api');
fs.mkdirSync(apiDir, { recursive: true });
fs.writeFileSync(path.join(apiDir, 'games'), JSON.stringify(games));
fs.writeFileSync(path.join(apiDir, 'session'), JSON.stringify({ bootId: `build-${Date.now()}` }));

fs.writeFileSync(path.join(DIST, '_headers'), [
  '/api/*',
  '  Content-Type: application/json',
  '  Cache-Control: no-cache',
  '',
  '/socket.io/*',
  '  Cache-Control: no-cache',
  '',
].join('\n'));

// ── 5. Patches: launcher, splash and Mario Kart exit paths ──────────────────
patch('menu.js', [
  // QR comes from the hub (room-specific URL), not /api/pairing.
  ["fetch('/api/pairing').then((r) => r.json()).then(({ qr }) => {",
    'window.OpenWii.pairing().then(({ qr }) => {'],
  // Launch the game in an iframe on top of the launcher so the phone links survive.
  ['window.location.href = launching.tile.game.url;',
    'window.OpenWii.open(launching.tile.game.url, () => {\n'
    + "        const b = document.getElementById('launch'); if (b) b.remove();\n"
    + '        for (const o of tiles) o.mesh.material.opacity = 1;\n'
    + '        barMesh.material.opacity = 1;\n'
    + '        for (const a of arrows) a.mesh.material.opacity = 1;\n'
    + '        launching = null;\n'
    + '        try { audio.startMusic(); } catch (e) { /* audio still locked */ }\n'
    + '      });'],
  // Do not render the menu underneath a running game.
  ['function frame(now) {\n  requestAnimationFrame(frame);',
    'function frame(now) {\n  requestAnimationFrame(frame);\n  if (window.OpenWii && window.OpenWii.gameOpen) return;'],
]);

patch('core/splash.js', [
  ["setTimeout(() => { window.location.href = '/'; }, 950);",
    "setTimeout(() => { if (window.openwiiExit) window.openwiiExit(); else window.location.href = '/'; }, 950);"],
]);

patch('games/mario-kart/game.js', [
  ['()=>location.href="/",100', '()=>(window.openwiiExit?window.openwiiExit():location.href="/"),100'],
  ["()=>location.href='/',100", "()=>(window.openwiiExit?window.openwiiExit():location.href='/'),100"],
]);

// Mario Kart multiplayer (stage 1): extra phones drive their own karts.
// The logic lives in games/mario-kart/multiplayer.js; these are only the hooks.
patch('games/mario-kart/game.js', [
  ['import { WheelInput } from "./input.js";',
    'import { WheelInput } from "./input.js";\nimport { MultiRace, RemotePlayers } from "./multiplayer.js";'],
  ['keys = new Set();', 'keys = new Set(),\n  remotes = new RemotePlayers();'],
  ['race = new Race({\n    character: selected,', 'race = new MultiRace({\n    character: selected,'],
  ['onOrientation: (sample, slot) => {\n    if (slot !== 0) return;',
    'onOrientation: (sample, slot) => {\n    if (slot !== 0) { remotes.sample(sample, slot, performance.now(), race?.state); return; }'],
  ['onCommand: (cmd, slot) => {\n    if (slot !== 0) return;',
    'onCommand: (cmd, slot) => {\n    if (slot !== 0) { remotes.command(cmd, slot, performance.now()); return; }'],
  ['onPresence: (p) => {', 'onPresence: (p) => {\n    remotes.presence(p);'],
  ['? "PHONE CONNECTED · P1"', '? remotes.label(p)'],
  ['function sendProfile() {\n  link.feedback({ type: "controller-profile", profile: "wheel", slot: 0 });',
    'function sendProfile() {\n  link.feedback({ type: "controller-profile", profile: "wheel", slot: 0 });\n'
    + '  for (const s of remotes.slots()) link.feedback({ type: "controller-profile", profile: "wheel", slot: s });'],
  ["if(e.racer===0)link.feedback({type:'rumble',pattern:[35],slot:0});",
    "if(e.racer===0)link.feedback({type:'rumble',pattern:[35],slot:0});"
    + "else if(remotes.has(e.racer))link.feedback({type:'rumble',pattern:[35],slot:e.racer});"],
  ['link.feedback({ type: "rumble", pattern: [80, 40, 80], slot: 0 });',
    'link.feedback({ type: "rumble", pattern: [80, 40, 80], slot: 0 });\n'
    + '    if (e.racer > 0 && remotes.has(e.racer)) link.feedback({ type: "rumble", pattern: [80, 40, 80], slot: e.racer });'],
  ['wheel.reset();\n  captureUntil = performance.now() + 3000;\n  race.start();',
    'wheel.reset();\n  remotes.reset(performance.now());\n  captureUntil = performance.now() + 3000;\n  race.start();'],
  ['if (!(usingPhone && race.state === "countdown" && !wheel.armed))\n      race.update(dt, input);',
    'remotes.apply(race);\n    if (!(usingPhone && race.state === "countdown" && !(wheel.armed && remotes.allArmed())))\n      race.update(dt, input, remotes.read(now));'],
  ["const waiting=usingPhone && race.state==='countdown' && !wheel.armed;",
    "const waiting=usingPhone && race.state==='countdown' && !(wheel.armed && remotes.allArmed());"],
]);

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`OpenWii static build OK: ${fileCount} files, ${games.length} games → ${path.relative(process.cwd(), DIST) || DIST}`);
console.log(`Games: ${games.map((g) => g.slug).join(', ')}`);
if (skippedBig.length) {
  console.log('Left out (over the 25 MB Cloudflare Pages file limit):');
  for (const s of skippedBig) console.log(`  - ${s}`);
}
