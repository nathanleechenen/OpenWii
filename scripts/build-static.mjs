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
    '// Free the launcher\'s big GPU buffer while the game runs (iPad graphics memory is tight).\n'
    + '      renderer.setPixelRatio(0.1); renderer.setSize(2, 2, false);\n'
    + '      window.OpenWii.open(launching.tile.game.url, () => {\n'
    + '        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));\n'
    + '        resize();\n'
    + "        const b = document.getElementById('launch'); if (b) b.remove();\n"
    + '        for (const o of tiles) o.mesh.material.opacity = 1;\n'
    + '        barMesh.material.opacity = 1;\n'
    + '        for (const a of arrows) a.mesh.material.opacity = 1;\n'
    + '        launching = null;\n'
    + '        try { audio.startMusic(); } catch (e) { /* audio still locked */ }\n'
    + '      });'],
  // A rotation or resize while a game is open must not re-grow the hidden menu's buffer.
  ['function resize() {', 'function resize() {\n  if (window.OpenWii && window.OpenWii.gameOpen) return;'],
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

// Mario Kart: stability/performance fixes, then multiplayer hooks (up to 4 phones,
// per-player drivers, player count, split-screen). The logic lives in
// games/mario-kart/multiplayer.js; these patches only wire it into game.js.
patch('games/mario-kart/game.js', [
  // If iPadOS reclaims the graphics context, restart the game page instead of leaving a dead screen.
  ['renderer.setSize(innerWidth, innerHeight);\nrenderer.shadowMap.enabled = true;',
    `renderer.setSize(innerWidth, innerHeight);
renderer.domElement.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  const n = Number(sessionStorage.getItem('openwii.glreload') || 0);
  if (n < 2) { sessionStorage.setItem('openwii.glreload', String(n + 1)); setTimeout(() => location.reload(), 400); }
});
setTimeout(() => sessionStorage.removeItem('openwii.glreload'), 60000);
renderer.shadowMap.enabled = true;`],
  // Lighter rendering so an iPad keeps its frame rate (and stays cool) over a whole race:
  // lower resolution, 2x instead of 4x anti-aliasing, and no ambient-occlusion pass.
  ['renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));', 'renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));'],
  ['  type: THREE.HalfFloatType,\n  samples: 4,', '  type: THREE.HalfFloatType,\n  samples: 2,'],
  ['composer.addPass(ambientOcclusion);', 'ambientOcclusion.enabled = false;\ncomposer.addPass(ambientOcclusion);'],
  // iPad Safari keeps audio locked until the iPad itself is touched, so awaiting the
  // start sound froze the race on "LOADING…" when starting from a phone remote.
  ["await audio.ui('start');",
    "if (audio.engine.ctx && audio.engine.ctx.state === 'running') await audio.ui('start'); else Promise.resolve(audio.unlock()).catch(() => {});"],

  // ── multiplayer: setup, input and menus ──
  ['import { WheelInput } from "./input.js";',
    'import { WheelInput } from "./input.js";\nimport { MultiRace, RemotePlayers, SplitHud, view, camStore, layoutViews } from "./multiplayer.js";'],
  ['keys = new Set();',
    `keys = new Set(),
  remotes = new RemotePlayers(CHARACTERS.map((c) => c.id)),
  splitHud = new SplitHud();
remotes.p1Id = selected;
remotes.onChange = () => { if (race?.state === "ready" && !starting) constructRace(); };`],
  ['race = new Race({\n    character: selected,', 'race = new MultiRace({\n    character: selected,'],
  ['resultsShown = false;resultsPresentation=null;',
    'remotes.p1Id = selected;\n  remotes.setup(race);\n  camStore.length = 0;\n  resultsShown = false;resultsPresentation=null;'],
  ['onOrientation: (sample, slot) => {\n    if (slot !== 0) return;',
    'onOrientation: (sample, slot) => {\n    if (slot !== 0) { remotes.sample(sample, slot, performance.now(), race?.state); return; }'],
  ['onCommand: (cmd, slot) => {\n    if (slot !== 0) return;',
    'onCommand: (cmd, slot) => {\n    if (slot !== 0) { remotes.command(cmd, slot, performance.now(), race?.state); return; }'],
  ['onPresence: (p) => {', 'onPresence: (p) => {\n    remotes.presence(p);'],
  ['? "PHONE CONNECTED · P1"', '? remotes.label(p)'],
  ['function sendProfile() {\n  link.feedback({ type: "controller-profile", profile: "wheel", slot: 0 });',
    'function sendProfile() {\n  link.feedback({ type: "controller-profile", profile: "wheel", slot: 0 });\n'
    + '  for (const s of remotes.slots()) link.feedback({ type: "controller-profile", profile: "wheel", slot: s });'],
  ["if(e.racer===0)link.feedback({type:'rumble',pattern:[35],slot:0});",
    "if(e.racer===0)link.feedback({type:'rumble',pattern:[35],slot:0});"
    + "else if(remotes.slotForRacer(e.racer)>0)link.feedback({type:'rumble',pattern:[35],slot:remotes.slotForRacer(e.racer)});"],
  ['link.feedback({ type: "rumble", pattern: [80, 40, 80], slot: 0 });',
    'link.feedback({ type: "rumble", pattern: [80, 40, 80], slot: 0 });\n'
    + '    if (remotes.slotForRacer(e.racer) > 0) link.feedback({ type: "rumble", pattern: [80, 40, 80], slot: remotes.slotForRacer(e.racer) });'],
  // Driver menu: P1 cannot land on a driver another phone holds; up/down sets the player count.
  ['const c=CHARACTERS[(index+CHARACTERS.length)%CHARACTERS.length];',
    'const c=CHARACTERS[(index+CHARACTERS.length)%CHARACTERS.length];\n  if (remotes.occupied(0).has(c.id) && c.id !== selected) return;'],
  ['chooseDriver(index+step);', 'chooseDriver(remotes.skipPicked(index, step));'],
  ["if (direction === 'left' || direction === 'right') selectLaps(selectedLaps === 1 ? 3 : 1);",
    "if (direction === 'left' || direction === 'right') selectLaps(selectedLaps === 1 ? 3 : 1);\n"
    + "    else if (direction === 'up' || direction === 'down') remotes.bumpCount(direction === 'up' ? 1 : -1);"],
  ["{setDriverConfirmed(true);audio.ui('confirm');}\n    else begin();",
    "{setDriverConfirmed(true);audio.ui('confirm');}\n"
    + "    else if (remotes.allReady()) begin();\n"
    + "    else { $('menu-hint').textContent = remotes.hint(); audio.ui('cancel'); }"],
  ['wheel.reset();\n  captureUntil = performance.now() + 3000;\n  race.start();',
    'wheel.reset();\n  remotes.reset(performance.now());\n  captureUntil = performance.now() + 3000;\n  race.start();'],
  ['if (!(usingPhone && race.state === "countdown" && !wheel.armed))\n      race.update(dt, input);',
    'remotes.apply(race);\n    if (!(usingPhone && race.state === "countdown" && !(wheel.armed && remotes.allArmed())))\n      race.update(dt, input, remotes.read(now));'],
  ["const waiting=usingPhone && race.state==='countdown' && !wheel.armed;",
    "const waiting=usingPhone && race.state==='countdown' && !(wheel.armed && remotes.allArmed());"],

  // ── split-screen: draw() becomes drawView(), run once per human racer ──
  ['function draw(dt, now) {\n  const p = race.player,',
    'function drawView(camDt, now) {\n  // Only the first view advances animations/particles; the others just re-aim and re-render.\n  const dt = view.pass === 0 ? camDt : 0;\n  const p = race.player,'],
  ['const cast = i === 0 || Math.hypot(r.x - p.x, r.z - p.z) < 18;',
    'const cast = i === 0 || view.count > 1 || Math.hypot(r.x - p.x, r.z - p.z) < 18;'],
  ['boostFeedback=updateBoostScreen(race.time,p.boost);',
    'if (view.pass === 0) boostFeedback=updateBoostScreen(race.time,p.boost);'],
  ['cameraUp.lerp(up, 1 - Math.exp(-dt * 7)).normalize();', 'cameraUp.lerp(up, 1 - Math.exp(-camDt * 7)).normalize();'],
  ['unconstrainedEye.lerp(camTarget, 1 - Math.exp(-dt * 13));', 'unconstrainedEye.lerp(camTarget, 1 - Math.exp(-camDt * 13));'],
  ['cameraAim.lerp(cameraAimTarget, 1 - Math.exp(-dt * 13));', 'cameraAim.lerp(cameraAimTarget, 1 - Math.exp(-camDt * 13));'],
  ['upperHeadFocus,avoidScenery,sceneryOffset,dt));', 'upperHeadFocus,avoidScenery,sceneryOffset,camDt));'],
  ['(1 - Math.exp(-dt * 6));', '(1 - Math.exp(-camDt * 6));'],
  ['const headFocus = driverCameraAnchor(karts[0].model,cameraFocus);',
    'const headFocus = driverCameraAnchor(karts[p.id].model,cameraFocus);'],
  ['const upperHeadFocus = driverCameraAnchor(karts[0].model,cameraFocus,true);',
    'const upperHeadFocus = driverCameraAnchor(karts[p.id].model,cameraFocus,true);'],
  ['if (finishBlend > 0) camera.setViewOffset(', 'if (finishBlend > 0 && !view.rect) camera.setViewOffset('],
  ['camera.updateProjectionMatrix();\n  key.position.set(',
    'camera.aspect = view.rect ? view.rect.w / view.rect.h : innerWidth / innerHeight;\n  camera.updateProjectionMatrix();\n  key.position.set('],
  ['key.position.set(p.x - 30, p.y + 60, p.z + 25);', 'if (view.pass === 0) key.position.set(p.x - 30, p.y + 60, p.z + 25);'],
  ['key.target.position.set(p.x, p.y, p.z);\n  key.target.updateMatrixWorld();',
    'if (view.pass === 0) { key.target.position.set(p.x, p.y, p.z); key.target.updateMatrixWorld(); }'],
  ['composer.render();', 'renderView();'],
  ['if (previousDrawTime && !document.hidden) {', 'if (view.pass === 0 && previousDrawTime && !document.hidden) {'],
  ['previousDrawTime = now;\n  updateHUD();', 'previousDrawTime = now;\n  if (view.pass === 0) updateHUD();'],
  ['function updateHUD() {',
    `function camSave(i) {
  camStore[i] = { init: initializedCamera, lf: lastFlightCamera, lc: landingCamera,
    up: cameraUp.clone(), eye: unconstrainedEye.clone(), aim: cameraAim.clone(),
    target: camTarget.clone(), aimTarget: cameraAimTarget.clone(), offset: sceneryOffset.clone(), fov: camera.fov };
}
function camLoad(i) {
  const s = camStore[i];
  if (!s) { initializedCamera = false; lastFlightCamera = landingCamera = null; return; }
  initializedCamera = s.init; lastFlightCamera = s.lf; landingCamera = s.lc;
  cameraUp.copy(s.up); unconstrainedEye.copy(s.eye); cameraAim.copy(s.aim);
  camTarget.copy(s.target); cameraAimTarget.copy(s.aimTarget); sceneryOffset.copy(s.offset); camera.fov = s.fov;
}
function renderView() {
  const r = view.rect;
  if (!r) { composer.render(); return; }
  // Split-screen: render straight to the canvas inside this player's rectangle
  // (no bloom / ambient occlusion, so four views stay affordable on an iPad).
  const y = innerHeight - r.y - r.h;
  renderer.setScissorTest(true);
  renderer.setViewport(r.x, y, r.w, r.h);
  renderer.setScissor(r.x, y, r.w, r.h);
  renderer.render(scene, camera);
}
// One pass per human racer (P1 first). With a single human this is exactly the old draw().
function draw(dt, now) {
  const all = race.state === 'ready' ? null : remotes.viewsFor(race);
  const views = all && all.length > 1 ? all : null;
  document.body.classList.toggle('split', !!views);
  if (!views) {
    if (view.count !== 1) {
      view.count = 1;
      renderer.setScissorTest(false);
      renderer.shadowMap.autoUpdate = true;
      renderer.setViewport(0, 0, innerWidth, innerHeight);
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      splitHud.update(null);
    }
    view.pass = 0; view.rect = null;
    drawView(dt, now);
    return;
  }
  const rects = layoutViews(views.length, innerWidth, innerHeight);
  if (!camStore[0]) camSave(0);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, innerWidth, innerHeight);
  renderer.clear();
  // The shadow map follows P1's light; render it once per frame, not once per view.
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  view.count = views.length;
  for (let i = 0; i < views.length; i++) {
    race.player = race.racers[views[i].racer];
    view.pass = i; view.rect = rects[i];
    camLoad(i);
    drawView(dt, now);
    camSave(i);
  }
  race.player = race.racers[0];
  camLoad(0);
  view.pass = 0; view.rect = null;
  splitHud.update(race, views, rects);
}
function updateHUD() {`],
]);

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`OpenWii static build OK: ${fileCount} files, ${games.length} games → ${path.relative(process.cwd(), DIST) || DIST}`);
console.log(`Games: ${games.map((g) => g.slug).join(', ')}`);
if (skippedBig.length) {
  console.log('Left out (over the 25 MB Cloudflare Pages file limit):');
  for (const s of skippedBig) console.log(`  - ${s}`);
}
