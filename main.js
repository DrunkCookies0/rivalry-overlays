/* =============================================================================
 * RIVALRY Casterverse - Electron main process
 * -----------------------------------------------------------------------------
 * On launch:
 *   1. Writes DefaultStatsAPI.ini into the user's Rocket League config so the
 *      official Stats API turns on (they restart RL once).
 *   2. Starts the bridge: RL TCP -> WebSocket game feed (49124) + control relay (49777).
 *   3. Starts a local web server (49080) serving the overlay + control panel so
 *      OBS can use a stable URL (Browser Source for the overlay, Custom Browser
 *      Dock for the control panel).
 *   4. Opens the control panel window and lives in the system tray.
 *
 * Producer-friendly behaviour:
 *   - Closing the window hides to tray (the bridge keeps serving). Quit from tray.
 *   - Auto-starts with Windows on first run (toggle in the tray menu).
 *   - Tray menu copies the OBS URLs to the clipboard.
 * ===========================================================================*/

"use strict";

const { app, BrowserWindow, Tray, Menu, nativeImage, clipboard, shell, Notification, dialog } = require("electron");
// electron-updater is required lazily inside setupAutoUpdate() because its
// module-load path eagerly instantiates NsisUpdater, which calls into
// electron.app and crashes when require()'d in dev (npm start / npm run mock).
let _autoUpdater = null;
function getAutoUpdater() {
  if (_autoUpdater) return _autoUpdater;
  _autoUpdater = require("electron-updater").autoUpdater;
  return _autoUpdater;
}
const http = require("http");
const fs = require("fs");
const path = require("path");

const { runSetup, startBridge } = require("./bridge/rl-bridge");
const { startReplayCollector } = require("./bridge/replay-collector");
const { createOBSController } = require("./bridge/obs-controller");
const obsSettingsStore = require("./bridge/obs-settings");
const devSettingsStore = require("./bridge/dev-settings");
const { getMeta } = require("./bridge/app-meta");
const overlayRegistry = require("./bridge/overlay-registry");
const { createApiRouter } = require("./bridge/http-api");
const leagueSettingsStore = require("./bridge/league-settings");
const { createLeagueClient } = require("./bridge/league-client");
const { migrateUserData } = require("./bridge/userdata-migrate");
const { createMatchLock } = require("./bridge/match-lock");
const portOwner = require("./bridge/port-owner");
const appLog = require("./bridge/app-log");

// Last-resort containment: one bad request or missed rejection must not take
// down the whole broadcast stack (HTTP + both WS servers die with the
// process). Log to the ring buffer (it lands in diagnostics) and keep going.
process.on("uncaughtException", (e) => {
  console.error("[rivalry] uncaught exception:", e && e.stack ? e.stack : String(e));
});
process.on("unhandledRejection", (e) => {
  console.error("[rivalry] unhandled rejection:", e && e.stack ? e.stack : String(e));
});

const HTTP_PORT = 49080;
// Gameplay overlay lives in the multi-scene tree (overlays/rivalry-gameplay,
// resolution-independent). The pre-migration /overlay/overlay.html fallback
// was removed for v1.0; an OBS source still pointing there gets a 404 and
// should be repointed via the scene list or the one-click scene build.
const OVERLAY_URL = `http://localhost:${HTTP_PORT}/overlays/rivalry-gameplay/index.html`;
const CONTROL_URL = `http://localhost:${HTTP_PORT}/control/control.html`;
const SETUP_URL = `http://localhost:${HTTP_PORT}/control/setup.html`;
const TRAY_ICON = path.join(__dirname, "assets", "tray.png");

// Beta builds (built via electron-builder.beta.js for CI PR artifacts) set
// productName to "RIVALRY Casterverse Beta". We surface that in the tray +
// window title so producers running both prod + beta side by side can tell them
// apart at a glance. Detection runs once at boot.
const IS_BETA = (app.getName() || "").toLowerCase().includes("beta");
const APP_TITLE = IS_BETA ? "RIVALRY Casterverse (BETA)" : "RIVALRY Casterverse";
const META = getMeta(IS_BETA);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

// Mutable root for the static-file server. Dev mode (see toggleDevMode) swaps
// this to a local repo folder so overlay/control HTML edits go live with just
// an OBS browser-source refresh — no app restart. Defaults to the packaged
// app directory.
let httpRootDir = __dirname;
function setHttpRoot(dir) { httpRootDir = dir; }
function getHttpRoot()   { return httpRootDir; }

// --- Overlay registry + signed-overlay gate (see bridge/overlay-registry.js) ---
// Scanned once at boot and again whenever the HTTP root changes (dev toggle), so
// requests never re-hash folders. The gate is enforced only when the PACKAGED
// app serves its own bundled files; dev-mode serving (unpacked, or a packaged
// app pointed at a repo) is treated as preview so unsigned WIP still loads.
let overlayPublicKey = null;
let overlayReg = { list: [], byFolder: {}, scannedAt: null, hasKey: false };
function gateActive() { return app.isPackaged && !devSettings.enabled; }
function rescanOverlays() {
  const base = path.join(getHttpRoot(), "overlays");
  const keyPath = path.join(base, "keys", "rivalry-overlay-public.pem");
  try { overlayPublicKey = fs.existsSync(keyPath) ? fs.readFileSync(keyPath, "utf8") : null; }
  catch (e) { overlayPublicKey = null; }
  overlayReg = overlayRegistry.scanOverlays(base, overlayPublicKey);
  const approved = overlayReg.list.filter((o) => o.approved).length;
  console.log(`[rivalry] overlays: ${overlayReg.list.length} found, ${approved} approved` +
    (overlayReg.hasKey ? "" : " (no public key)") + (gateActive() ? " [gate ON]" : " [preview]"));
}

// --- Match lock: the product is match-first ----------------------------------
// The packaged app serves overlay scenes only while a real league match is
// locked (loaded from the backend and cached to disk — see bridge/match-lock).
// This is the app's ONE gate: the access-key system was removed 2026-08-11
// (the league API key + a real match is the actual entitlement; per-install
// activation was ceremony on top). Enforced in packaged builds only, so dev
// runs, mock mode and the render-verify harness keep their full loop.
let matchLock = null;
function matchGateBlocks() {
  return app.isPackaged && !(matchLock && matchLock.isLocked());
}

// Shown in the OBS browser source instead of a scene when no league match is
// loaded. Polls the lock and reloads itself the moment one lands, so the
// producer never has to hand-refresh every OBS source after loading a match.
function matchNoticeHtml() {
  return `<!doctype html><meta charset="utf-8"><title>No match loaded</title>
<style>html,body{margin:0;height:100%;background:#0b1219;color:#f1eeee;
font-family:"Segoe UI",system-ui,sans-serif;display:flex;align-items:center;justify-content:center}
.c{max-width:640px;padding:40px;text-align:center}
h1{font-size:26px;letter-spacing:.14em;margin:0 0 14px;text-transform:uppercase;font-style:italic}
p{font-size:16px;line-height:1.6;color:#9fb0be;margin:0 0 10px}
b{color:#30c0f6}</style>
<div class="c"><h1>RIVALRY Casterverse</h1>
<p>No league match is loaded, so overlay scenes are not being served.</p>
<p>Open the control panel, <b>find your match</b>, and load it. This source will pick it up on its own.</p></div>
<script>setInterval(async()=>{try{const r=await(await fetch("/league/lock",{cache:"no-store"})).json();
if(r&&r.locked)location.reload();}catch{}},3000);</script>`;
}

function startHttpServer(rootDir) {
  setHttpRoot(rootDir);
  const server = http.createServer((req, res) => {
    // Malformed percent-encoding ("/%zz") throws; an uncaught throw here kills
    // the whole broadcast stack, so it must be a 400, never an exception.
    let urlPath;
    try {
      urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    } catch {
      res.writeHead(400);
      return res.end("bad request");
    }
    // Canonicalize BEFORE any gate reads the path. The match gate and the
    // signing gate classify by prefix/first-segment; resolving ".." only at
    // filesystem time would let "/control/..%2Foverlays/x" be gated as
    // /control/ but served from /overlays/. Backslashes are folded first so
    // Windows path joining cannot reintroduce a separator the gates never saw.
    urlPath = path.posix.normalize(urlPath.replace(/\\/g, "/"));
    if (!urlPath.startsWith("/")) urlPath = "/" + urlPath;
    // App API endpoints (status, setup, uploads, league proxy...) live in the
    // router; static serving + the overlay gate below stay untouched.
    if (apiRouter && apiRouter.handle(req, res, urlPath)) return;
    // Tiny meta endpoint so the control panel can render the build label.
    if (urlPath === "/version" || urlPath === "/version.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(META));
    }
    // Overlay registry so the control panel can list available scenes + their
    // approval state. Served from the last scan (cheap; no per-request hashing).
    if (urlPath === "/overlays/registry.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        version: 1, scannedAt: overlayReg.scannedAt, hasKey: overlayReg.hasKey,
        gate: gateActive(), overlays: overlayReg.list,
      }));
    }
    if (urlPath === "/" || urlPath === "") urlPath = "/control/control.html";

    // Match gate: no scene serves until a real league match is locked. The
    // notice polls /league/lock and reloads itself, so OBS sources come alive
    // the moment a match is loaded.
    if (matchGateBlocks() && urlPath.startsWith("/overlays/")) {
      res.writeHead(200, { "Content-Type": MIME[".html"] });
      return res.end(matchNoticeHtml());
    }

    // Signed-overlay gate: in the packaged app, deny unapproved scene folders and
    // inject the signed flag into an approved scene's entry HTML so the SDK drops
    // its PREVIEW badge. sdk/shared always serve; keys never do. Non-/overlays/
    // paths pass through unchanged.
    const cls = overlayRegistry.classifyOverlayRequest(urlPath, overlayReg, gateActive());
    if (cls.kind === "deny") {
      res.writeHead(404);
      return res.end("not found");
    }
    const root = httpRootDir;
    const filePath = path.normalize(path.join(root, urlPath));
    // Separator-anchored containment: a bare prefix test passes for sibling
    // directories like "<root>-backup".
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      res.writeHead(403);
      return res.end("forbidden");
    }
    const injectFlag = cls.kind === "scene" && cls.isEntry && gateActive() && cls.approved;
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end("not found");
      }
      const type = MIME[path.extname(filePath)] || "application/octet-stream";
      if (injectFlag && type.indexOf("text/html") === 0) {
        res.writeHead(200, { "Content-Type": type });
        return res.end(overlayRegistry.injectSignedFlag(data.toString("utf8")));
      }
      res.writeHead(200, { "Content-Type": type });
      res.end(data);
    });
  });
  server.on("error", (e) => {
    console.error("[rivalry] http server error:", e.message);
    if (e.code === "EADDRINUSE") reportPortConflict(HTTP_PORT, "web server");
  });
  server.listen(HTTP_PORT, "127.0.0.1", () => console.log(`[rivalry] web server -> ${OVERLAY_URL}`));
  return server;
}

let mainWindow = null;
let tray = null;
let collector = null;
let obsController = null;
let obsSettings = null;
let bridgeHandle = null;
let apiRouter = null;
let leagueSettings = null;
let leagueClient = null;
// Last runSetup() result, surfaced through /status.json so the setup wizard
// can show ini state instead of the old console-only logging.
let setupInfo = { ok: false, dirFound: false, written: [], checked: [] };
function runIniSetup() {
  try {
    setupInfo = runSetup();
  } catch (e) {
    console.error("[rivalry] setup error:", e.message);
    setupInfo = { ok: false, dirFound: false, written: [], checked: [], error: e.message };
  }
  // Keep the bridge's rl-status ini fields in sync with the fresh result (the
  // bridge otherwise carries its boot-time snapshot until relaunch).
  if (bridgeHandle && bridgeHandle.setSetupInfo) bridgeHandle.setSetupInfo(setupInfo);
  return setupInfo;
}

// First-run marker: the wizard's Finish button writes it; until then the app
// window opens on the setup page (and visibly — the normal boot is tray-only).
function setupMarkerPath() { return path.join(app.getPath("userData"), ".setup-complete"); }
function isSetupComplete() { return fs.existsSync(setupMarkerPath()); }
function markSetupComplete() {
  try { fs.writeFileSync(setupMarkerPath(), new Date().toISOString()); }
  catch (e) { console.error("[rivalry] setup marker error:", e.message); }
}

// One-time dialog when a port we need is already taken (usually a second
// overlay app or a zombie process). Console-only was invisible to producers.
let portConflictShown = false;
function reportPortConflict(port, what) {
  if (portConflictShown) return;
  portConflictShown = true;
  // Name the program holding the port. Nearly always an older version of this
  // app, still installed and auto-starting with Windows — which makes a fresh
  // install of the renamed build come up dead with nothing to go on.
  const owner = portOwner.findPortOwner(port);
  if (owner.name) console.error(`[rivalry] port ${port} held by ${owner.name} (pid ${owner.pid})`);
  dialog.showErrorBox(
    `${APP_TITLE} - port ${port} in use`,
    portOwner.portConflictMessage(port, what, owner, APP_TITLE, path.basename(process.execPath))
  );
}
// Live updater status shown as a row in the tray menu. Without this the
// "Check for updates" click had zero visible feedback. Values used:
//   "idle"        first launch, nothing checked yet
//   "checking"    a check is in flight
//   "up-to-date"  no newer version available
//   "available"   newer version found, downloading in background
//   "downloaded"  update sitting on disk, will install on next quit
//   "error"       last check / download errored, see updateError
let updateState = "idle";
let updateVersion = null;
let updateError = null;

// Dev-mode tray toggle. Hidden by default in packaged builds — only appears
// when running unpacked OR when RIVALRY_DEV=1 is set in the user environment.
// When on, the HTTP server serves overlay / control HTML from `devSettings.path`
// instead of the packaged app dir, so edits in a local repo go live to OBS
// after a browser-source refresh — no install / restart loop.
let devSettings = { enabled: false, path: "" };
const DEV_MODE_AVAILABLE = !app.isPackaged || process.env.RIVALRY_DEV === "1";

function createWindow() {
  // Start hidden so the app boots quietly to the tray on every launch
  // (including auto-start with Windows). Users open the control panel
  // explicitly via the tray click handler or "Show control panel".
  // EXCEPTION: until the setup wizard has been finished once, boot onto the
  // wizard and show the window — a first-run app that hides in the tray is
  // indistinguishable from a broken install to a new producer.
  const firstRun = !isSetupComplete();
  mainWindow = new BrowserWindow({
    width: 900,
    height: 1040,
    minWidth: 360,
    autoHideMenuBar: true,
    title: APP_TITLE,
    backgroundColor: "#0e1218",
    icon: TRAY_ICON,
    show: false,
    webPreferences: { contextIsolation: true },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.loadURL(firstRun ? SETUP_URL : CONTROL_URL);
  if (firstRun) mainWindow.once("ready-to-show", () => mainWindow.show());

  // Closing hides to tray so the bridge keeps running for OBS. Quit from tray.
  mainWindow.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function showWindow() {
  if (!mainWindow) createWindow();
  else {
    // If the wizard was left open but setup is done, land on the panel.
    try {
      if (isSetupComplete() && mainWindow.webContents.getURL().includes("/control/setup.html")) {
        mainWindow.loadURL(CONTROL_URL);
      }
    } catch {}
    mainWindow.show();
    mainWindow.focus();
  }
}

function obsStatusLabel() {
  if (!obsSettings || !obsSettings.enabled) return "OBS: disabled";
  if (!obsController) return "OBS: starting...";
  const s = obsController.status;
  if (s.connected) return "OBS: connected";
  if (s.error) return `OBS: ${s.error.substring(0, 40)}`;
  return "OBS: connecting...";
}

function updateStatusLabel() {
  switch (updateState) {
    case "checking":    return "Updates: checking...";
    case "up-to-date":  return `Updates: up to date (${META.label})`;
    case "available":   return `Updates: downloading v${updateVersion}...`;
    case "downloaded":  return `Updates: v${updateVersion} ready - quit to install`;
    case "error":       return `Updates: error (${(updateError || "").substring(0, 120)})`;
    default:            return app.isPackaged ? "Updates: not checked yet" : "Updates: disabled in dev";
  }
}

// Write the diagnostics bundle (same content as GET /diagnostics.json) to the
// Desktop and reveal it, so "send me the file" is one tray click for a
// producer mid-trouble. Never throws: a failed export shows an error box
// instead of dying silently in a tray callback.
function exportDiagnostics() {
  try {
    if (!apiRouter || !apiRouter.buildDiagnostics) throw new Error("app still starting");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = path.join(app.getPath("desktop"), `casterverse-diagnostics-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(apiRouter.buildDiagnostics(), null, 2));
    shell.showItemInFolder(file);
  } catch (e) {
    dialog.showErrorBox(
      "Export diagnostics failed",
      e.message + "\n\nThe same data is available at http://localhost:49080/diagnostics.json while the app is running."
    );
  }
}

function buildTrayMenu() {
  const startsWithWindows = app.getLoginItemSettings().openAtLogin;
  return Menu.buildFromTemplate([
    { label: APP_TITLE, enabled: false },
    { label: META.label, enabled: false },
    { type: "separator" },
    { label: "Show control panel", click: showWindow },
    {
      label: "Setup guide",
      click: () => {
        if (!mainWindow) createWindow();
        mainWindow.loadURL(SETUP_URL);
        showWindow();
      },
    },
    {
      label: "Copy overlay URL  (OBS Browser Source)",
      click: () => clipboard.writeText(OVERLAY_URL),
    },
    {
      label: "Copy control panel URL  (OBS Dock)",
      click: () => clipboard.writeText(CONTROL_URL),
    },
    { type: "separator" },
    {
      label: "Open replays folder",
      click: () => { if (collector && collector.archiveDir) shell.openPath(collector.archiveDir); },
    },
    {
      // The support path: one file on the Desktop the producer sends instead
      // of describing symptoms over a call. Secrets are masked upstream.
      label: "Export diagnostics",
      click: exportDiagnostics,
    },
    { type: "separator" },
    { label: obsStatusLabel(), enabled: false },
    {
      label: "Set up OBS scenes",
      enabled: !!(obsController && obsController.status.connected),
      click: () => setupObsScenes(),
    },
    { type: "separator" },
    { label: updateStatusLabel(), enabled: false },
    // Beta + prod both publish to GitHub Releases (beta = prerelease,
    // prod = release), so this works on both channels. allowPrerelease
    // in setupAutoUpdate() is what differentiates them.
    {
      label: "Check for updates now",
      enabled: app.isPackaged && updateState !== "checking",
      click: () => {
        try {
          updateState = "checking";
          refreshTrayMenu();
          getAutoUpdater().checkForUpdates();
        } catch (e) {
          // A throw here (updater failed to load) must not strand the state in
          // "checking": that also disables this menu item, killing all retries.
          updateState = "error";
          refreshTrayMenu();
        }
      },
    },
    {
      label: "Quit and install update",
      enabled: updateState === "downloaded",
      click: () => {
        app.isQuitting = true;
        try { getAutoUpdater().quitAndInstall(); }
        catch (e) { app.quit(); }
      },
    },
    { type: "separator" },
    {
      label: "Start with Windows",
      type: "checkbox",
      checked: startsWithWindows,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
      },
    },
    // Dev-mode toggle. Hidden in packaged user builds (gated by env var so the
    // code ships but the UI doesn't surface to end users).
    ...(DEV_MODE_AVAILABLE ? [
      { type: "separator" },
      {
        label: devSettings.enabled
          ? `Dev: serving from ${devSettings.path}`
          : "Dev: serve overlay from local folder...",
        type: "checkbox",
        checked: devSettings.enabled,
        click: () => { toggleDevMode().catch((e) => console.error("[rivalry] dev toggle:", e.message)); },
      },
    ] : []),
    { type: "separator" },
    {
      label: `Quit ${APP_TITLE}`,
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function refreshTrayMenu() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

// Idempotent: creates a "RIVALRY - Live" scene with the overlay URL pre-wired
// as a browser source. Producers run this once after enabling obs-websocket;
// re-running is safe and just no-ops if scenes / sources already exist.
// Scene names live in obs-collection.js so the websocket path and the
// importable scene-collection file can never disagree.
const { OBS_SCENE_NAMES, OBS_COLLECTION_NAME, CHROME_SCENE_TYPE, CHROME_SOURCE_NAME, DARK_SCENE_TYPES, selectOverlaysForSet } = require("./bridge/obs-collection");
const { SAFE_AREA } = require("./bridge/broadcast-geometry");
async function setupObsScenes() {
  if (!obsController || !obsController.status.connected) return { ok: false, error: "OBS not connected" };
  const base = `http://localhost:${HTTP_PORT}`;
  // One OBS scene per available overlay, each with its Browser Source pre-wired.
  // In the packaged app only approved overlays are offered; dev offers all.
  // Order by OBS_SCENE_NAMES key order (gameplay first) so scenes land in the
  // same broadcast order as the importable collection, not registry-scan order.
  const sceneRank = Object.keys(OBS_SCENE_NAMES);
  const available = (overlayReg.list || []).filter((o) => (gateActive() ? o.approved : true));
  // One overlay per scene type, from the producer's preferred look (set) with
  // the house set filling any scene type the preferred one doesn't cover —
  // same selection the importable collection makes.
  const chosen = selectOverlaysForSet(available, obsSettings && obsSettings.preferredSet);
  // The chrome is not a scene: one shared source pinned on top of every scene,
  // exactly like the importable collection builds it. Absent chrome degrades
  // to the pre-chrome layout (full-canvas capture, no frame).
  const chromeEntry = chosen.find((o) => o.scene === CHROME_SCENE_TYPE) || null;
  const list = chosen
    .filter((o) => o.scene !== CHROME_SCENE_TYPE && !DARK_SCENE_TYPES.has(o.scene))
    .sort((a, b) => {
      const ra = sceneRank.indexOf(a.scene), rb = sceneRank.indexOf(b.scene);
      return (ra === -1 ? sceneRank.length : ra) - (rb === -1 ? sceneRank.length : rb);
    });
  const scenes = list.map((o) => ({
    scene: o.scene,
    sceneName: OBS_SCENE_NAMES[o.scene] || ("RIVALRY - " + o.name),
    sourceName: o.name + " Overlay",
    url: base + o.url,
    opaque: !!o.opaque,
  }));
  try {
    // Build everything inside a dedicated collection (created if absent, else
    // reused) so we never disturb the producer's existing scenes. A freshly
    // created collection ships one default empty scene we remove afterward.
    const { created } = await obsController.ensureSceneCollection(OBS_COLLECTION_NAME);
    const defaults = created ? await obsController.sceneNames() : [];
    let sceneCount = 0;
    for (const s of scenes) {
      try {
        await obsController.createSceneWithBrowserSource(s);
        // The gameplay scene also gets a game capture pre-placed under the
        // scorebug, so the operator just confirms it is grabbing Rocket League.
        // With the chrome present it scales into the safe area, not full frame.
        if (s.scene === "gameplay") {
          await obsController.ensureGameCapture({
            sceneName: s.sceneName,
            sourceName: "Rocket League (Game Capture)",
            rect: chromeEntry ? SAFE_AREA : undefined,
          });
        }
        // Opaque scenes paint the full canvas themselves; pinning the chrome
        // on top would composite the house frame over another look's art.
        if (chromeEntry && !s.opaque) {
          await obsController.ensureSourceOnTop({
            sceneName: s.sceneName,
            sourceName: CHROME_SOURCE_NAME,
            url: base + chromeEntry.url,
          });
        }
        sceneCount++;
      } catch (e) { console.error("[rivalry] scene setup failed:", e.message); }
    }
    // Land OBS on the first broadcast scene (Starting Soon), then clear the
    // default(s) now that they are no longer the active program scene
    // (RemoveScene refuses the active one).
    if (scenes[0]) await obsController.switchScene(scenes[0].sceneName);
    if (created) {
      const ours = new Set(scenes.map((s) => s.sceneName));
      for (const name of defaults) if (!ours.has(name)) await obsController.removeScene(name);
    }
    return { ok: true, created, collection: OBS_COLLECTION_NAME, sceneCount };
  } catch (e) {
    console.error("[rivalry] OBS scene collection setup failed:", e.message);
    return { ok: false, error: e.message };
  }
}

// =============================================================================
// Zero-touch OBS setup
// -----------------------------------------------------------------------------
// One button, no typing. Finds OBS, reads OBS's OWN websocket settings (so the
// producer never sees a password), turns the server on if it is off, starts OBS
// if it isn't running, connects, and builds the scenes.
//
// Each step reports itself on the control bus so the wizard shows a live
// checklist instead of a spinner. Anything we cannot do safely stops with a
// plain-language instruction and leaves the manual path available.
// =============================================================================
const obsDiscovery = require("./bridge/obs-discovery");

let autoSetupRunning = false;
function reportSetupStep(step, state, detail) {
  if (bridgeHandle && bridgeHandle.broadcastControl) {
    bridgeHandle.broadcastControl({ type: "obs-setup-progress", payload: { step, state, detail: detail || "" } });
  }
  console.log(`[rivalry] obs-setup ${step}: ${state}${detail ? " — " + detail : ""}`);
}

// Poll until the OBS controller reports connected, or give up.
function waitForObsConnection(timeoutMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (obsController && obsController.status.connected) return resolve(true);
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(tick, 500);
    };
    tick();
  });
}
// Connected is not the same as ready. OBS opens its websocket while the rest of
// it is still loading and answers early requests with "OBS is not ready to
// perform the request" — which is what a cold-start scene build hits. Poll a
// harmless request until it succeeds.
async function waitForObsReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await obsController.sceneNames();
      return true;
    } catch (e) {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 750));
    }
  }
}

function waitFor(predicate, timeoutMs, intervalMs = 1000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

async function autoSetupObs() {
  if (autoSetupRunning) return { ok: false, error: "already running" };
  autoSetupRunning = true;
  const fail = (step, detail) => {
    reportSetupStep(step, "fail", detail);
    autoSetupRunning = false;
    return { ok: false, error: detail, step };
  };
  try {
    // 1. Where is OBS?
    reportSetupStep("find", "busy");
    const install = obsDiscovery.findObsInstall();
    if (!install.found) {
      return fail("find", "Couldn't find OBS Studio on this PC. Install it from obsproject.com, then run this again.");
    }
    reportSetupStep("find", "done", install.exePath);

    // 2. Its websocket settings. A missing config means OBS has never run, so
    //    let OBS create its own rather than authoring one for it.
    reportSetupStep("config", "busy");
    let configDir = obsDiscovery.resolveConfigDir({ installDir: install.installDir });
    let ws = obsDiscovery.readWebSocketConfig(configDir);
    if (!ws.exists) {
      reportSetupStep("config", "busy", "Starting OBS once so it can create its settings…");
      const launched = obsDiscovery.launchObs(install);
      if (!launched.ok) return fail("config", "Couldn't start OBS: " + launched.reason);
      const appeared = await waitFor(() => {
        configDir = obsDiscovery.resolveConfigDir({ installDir: install.installDir });
        return obsDiscovery.readWebSocketConfig(configDir).exists;
      }, 60000);
      if (!appeared) {
        return fail("config", "OBS started but hasn't written its settings yet. Finish the OBS setup wizard, then run this again.");
      }
      ws = obsDiscovery.readWebSocketConfig(configDir);
    }

    // 3. Server off? It can only be switched on while OBS is closed, because
    //    OBS rewrites this file on exit and would discard the change.
    if (!ws.enabled) {
      if (obsDiscovery.isObsRunning()) {
        return fail("config", "OBS's WebSocket server is off. Close OBS completely, then click this again — the app will switch it on for you.");
      }
      const enabled = obsDiscovery.enableWebSocketServer(configDir, { running: false });
      if (!enabled.ok) {
        return fail("config", enabled.reason === "no-config"
          ? "OBS hasn't saved its settings yet. Open OBS once, close it, then run this again."
          : "Couldn't update OBS's settings (" + enabled.reason + "). Use the manual steps instead.");
      }
      ws = obsDiscovery.readWebSocketConfig(configDir);
    }
    reportSetupStep("config", "done",
      `WebSocket server on, port ${ws.port}${ws.authRequired ? " (password read from OBS)" : " (no password needed)"}`);

    // 4. Running? Note "running" means its websocket is listening, not merely
    //    that the process exists — OBS binds the port only once its UI has
    //    finished loading, which on a cold start is tens of seconds later.
    reportSetupStep("launch", "busy");
    const alreadyUp = obsDiscovery.isObsRunning();
    if (!alreadyUp) {
      const launched = obsDiscovery.launchObs(install);
      if (!launched.ok) return fail("launch", "Couldn't start OBS: " + launched.reason);
      reportSetupStep("launch", "busy", "Waiting for OBS to finish starting…");
    }
    const portUp = await obsDiscovery.waitForPort(ws.port, { timeoutMs: alreadyUp ? 15000 : 90000 });
    if (!portUp) {
      // Most common cause by far: OBS is up but showing a dialog (a crash
      // prompt after an unclean exit, or its first-run wizard) and hasn't got
      // as far as opening its websocket. Say that, rather than a vague timeout.
      return fail("launch", obsDiscovery.isObsRunning()
        ? "OBS is open but hasn't finished starting. If it's showing a message (Crash Detected, Safe Mode, or the setup wizard), answer it, then click this again."
        : `Nothing is listening on port ${ws.port}. Open OBS, check Tools, WebSocket Server Settings, then click this again.`);
    }
    reportSetupStep("launch", "done", alreadyUp ? "OBS is already running" : "Started OBS");

    // 5. Connect. The password comes from OBS's own config, never from a human.
    reportSetupStep("connect", "busy");
    obsSettings = {
      ...obsSettings,
      enabled: true,
      url: `ws://localhost:${ws.port}`,
      password: ws.authRequired ? ws.password : "",
    };
    obsSettingsStore.save(app.getPath("userData"), obsSettings);
    await obsController.applySettings(obsSettings).catch(() => {});
    const connected = await waitForObsConnection(45000);
    if (!connected) {
      const why = (obsController && obsController.status.error) || "no response";
      return fail("connect", "OBS is running but wouldn't accept the connection (" + why + "). Try the manual steps.");
    }
    reportSetupStep("connect", "done");

    // 6. Scenes — once OBS will actually answer requests.
    reportSetupStep("scenes", "busy");
    if (!(await waitForObsReady(60000))) {
      return fail("scenes", "OBS connected but is still loading. Wait for it to finish, then click this again.");
    }
    const built = await setupObsScenes();
    if (!built.ok) return fail("scenes", built.error || "scene build failed");
    reportSetupStep("scenes", "done", `${built.sceneCount} scenes in "${built.collection}"`);

    autoSetupRunning = false;
    return { ok: true, ...built };
  } catch (e) {
    return fail("scenes", (e && e.message) || "unexpected error");
  }
}

// Toggle dev mode on/off. When turning on, prompts for the local repo folder
// (unless one was previously saved). When turning off, reverts the HTTP root
// to the packaged app dir. Persists across launches.
async function toggleDevMode() {
  if (!DEV_MODE_AVAILABLE) return;
  if (devSettings.enabled) {
    devSettings = { ...devSettings, enabled: false };
    setHttpRoot(__dirname);
  } else {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "Choose the RIVALRY Casterverse repo folder",
      defaultPath: devSettings.path || app.getPath("home"),
    });
    if (result.canceled || !result.filePaths.length) return;
    const picked = result.filePaths[0];
    if (!fs.existsSync(path.join(picked, "overlays", "rivalry-gameplay", "manifest.json"))) {
      dialog.showMessageBox({
        type: "warning",
        message: "That folder does not look like the Casterverse repo",
        detail: "Expected to find overlays/rivalry-gameplay/manifest.json inside it.",
      });
      return;
    }
    devSettings = { enabled: true, path: picked };
    setHttpRoot(picked);
  }
  devSettingsStore.save(app.getPath("userData"), devSettings);
  rescanOverlays();
  refreshTrayMenu();
}

function createTray() {
  let img = nativeImage.createFromPath(TRAY_ICON);
  if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip(APP_TITLE);
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", showWindow);
}

function setupAutoUpdate() {
  // Only in the packaged app; running unpacked (npm start) has no update feed.
  if (!app.isPackaged) return;
  const autoUpdater = getAutoUpdater();
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // installs on full quit, never mid-broadcast
  // Beta installs follow the prerelease channel (each PR push publishes a
  // GitHub prerelease tagged v<version>-beta.N). Production installs ignore
  // prereleases and only update on stable v<version> releases from main.
  autoUpdater.allowPrerelease = IS_BETA;
  // Beta installs read beta.yml from the latest GitHub prerelease.
  // Production installs read latest.yml from the latest stable release.
  // The channel field MUST match electron-builder.beta.js's publish.channel.
  if (IS_BETA) autoUpdater.channel = "beta";

  // Every updater event mutates updateState + refreshes the tray so the
  // producer sees actual status instead of clicking "Check for updates"
  // into a void. Status row in the tray reflects the current value of
  // updateState (via updateStatusLabel).
  autoUpdater.on("checking-for-update", () => {
    updateState = "checking"; refreshTrayMenu();
  });
  autoUpdater.on("update-not-available", () => {
    updateState = "up-to-date"; refreshTrayMenu();
  });
  autoUpdater.on("update-available", (info) => {
    updateState = "available";
    updateVersion = info && info.version;
    refreshTrayMenu();
  });
  autoUpdater.on("update-downloaded", (info) => {
    updateState = "downloaded";
    updateVersion = info && info.version;
    refreshTrayMenu();
    // Native OS notification so the producer doesn't have to right-click
    // the tray to discover an update is ready. Click action opens the
    // tray context menu by showing the control panel window.
    try {
      const n = new Notification({
        title: `${APP_TITLE} update ready`,
        body: `v${info && info.version} is downloaded. Quit from the tray to install — never mid-broadcast.`,
        icon: TRAY_ICON,
      });
      n.on("click", showWindow);
      n.show();
    } catch (e) { /* notifications unavailable on this OS, tray status still updates */ }
  });
  autoUpdater.on("error", (e) => {
    updateState = "error";
    updateError = e && e.message ? e.message : String(e);
    refreshTrayMenu();
  });

  // Auto-checks: on launch + every 30 min while the app is running. These
  // happen WITHOUT a user clicking anything, which is what makes auto-update
  // feel "automatic" - by the time the producer notices, the new build is
  // already downloaded and ready to install on next quit.
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 30 * 60 * 1000);
}

// =============================================================================
// OBS integration: load persisted settings, drive the controller, react to
// control-panel changes, optionally auto-switch scenes on game events.
// =============================================================================
function setupObsIntegration() {
  const userDataDir = app.getPath("userData");
  obsSettings = obsSettingsStore.load(userDataDir);
  obsController = createOBSController();

  // Push initial settings into the controller. If `enabled: false` (the
  // default) this is a no-op and OBS is never contacted.
  obsController.applySettings(obsSettings).catch(() => {});

  // The obs-status payload goes over the shared control bus. The saved
  // password never rides along — a panel only needs to know one exists.
  function obsStatusPayload() {
    const { password, ...rest } = obsSettings || {};
    return {
      settings: { ...rest, passwordSet: !!password },
      status: obsController.status,
    };
  }
  function broadcastObsStatus() {
    if (bridgeHandle && bridgeHandle.broadcastControl) {
      bridgeHandle.broadcastControl({ type: "obs-status", payload: obsStatusPayload() });
    }
  }

  // Status changes -> repaint tray + tell the panels LIVE, not only as an echo
  // of their own edits (a dock otherwise shows "connecting..." after OBS has
  // long connected, and "connected" after OBS quit).
  obsController.on("status", () => { refreshTrayMenu(); broadcastObsStatus(); });

  // Control panel -> main process messages.
  if (bridgeHandle && bridgeHandle.events) {
    // Hydrate every fresh control client with settings + live status, so the
    // panel never has to (and never does) push its HTML defaults at us.
    bridgeHandle.events.on("control-client", (ws) => {
      try { ws.send(JSON.stringify({ type: "obs-status", payload: obsStatusPayload() })); }
      catch { /* client already gone */ }
    });
    bridgeHandle.events.on("control", (msg) => {
      if (msg && msg.type === "obs-settings" && msg.payload) {
        // Allowlist the OBS WebSocket URL to loopback so a malicious
        // control-bus message (the WS server already guards Origin, but
        // defense-in-depth) can't repoint the controller at a remote
        // attacker server and reuse the producer's saved password.
        if (typeof msg.payload.url === "string") {
          try {
            const u = new URL(msg.payload.url);
            if (!["localhost", "127.0.0.1", "::1"].includes(u.hostname)) {
              return; // silently reject non-local URL
            }
          } catch { return; } // unparseable URL -> reject
        }
        const before = obsSettings;
        // forceReconnect is the panel's "Test connection" verb, not a setting:
        // strip it so it never persists to disk.
        const { forceReconnect, ...incoming } = msg.payload;
        // Panels omit `password` entirely unless the producer typed one, so a
        // merge never wipes the saved password with an empty field.
        obsSettings = { ...obsSettings, ...incoming };
        obsSettingsStore.save(userDataDir, obsSettings);
        // Redial only when a connection-relevant field changed; re-applying on
        // every sceneMap keystroke would tear down and redial the OBS socket.
        const conn = (s) => `${s.enabled}|${s.url}|${s.password}`;
        if (forceReconnect) {
          // Drop and redial with current settings even when nothing changed
          // (applySettings would no-op on identical settings).
          obsController.applySettings(obsSettings)
            .then(() => obsController.disconnect())
            .then(() => obsController.connect())
            .catch(() => {});
        } else if (conn(before) !== conn(obsSettings)) {
          obsController.applySettings(obsSettings).catch(() => {});
        }
        broadcastObsStatus();
      } else if (msg && msg.type === "obs-action") {
        handleObsAction(msg.payload || {});
      }
    });

    // Auto-scene-switching on game events (off by default; gated by
    // autoSwitchEnabled + a non-empty scene name for each trigger).
    bridgeHandle.events.on("game", (env) => onGameEventForObs(env));
  }
}

async function handleObsAction(payload) {
  const action = payload && payload.action;
  // Zero-touch setup runs BEFORE there is a connection — that is the point of
  // it — so it is handled ahead of the connected guard below.
  if (action === "auto-setup") {
    const result = await autoSetupObs();
    if (bridgeHandle && bridgeHandle.broadcastControl) {
      bridgeHandle.broadcastControl({ type: "obs-action-result", payload: { action, ...result } });
    }
    return;
  }
  if (!obsController || !obsController.status.connected) {
    // A silent return here leaves the panel's "Building..." (or a deck cut)
    // firing into a void; report the miss so the UI can say why.
    if (bridgeHandle && bridgeHandle.broadcastControl) {
      bridgeHandle.broadcastControl({
        type: "obs-action-result",
        payload: { action, ok: false, error: "OBS is not connected" },
      });
    }
    return;
  }
  if (action === "setup-scenes") {
    const result = await setupObsScenes();
    // Report back so the control panel / setup wizard can confirm the one-click
    // build ("Created 7 scenes in a new RIVALRY Casterverse collection") or show
    // the error, instead of the button firing into a void.
    if (bridgeHandle && bridgeHandle.broadcastControl) {
      bridgeHandle.broadcastControl({ type: "obs-action-result", payload: { action, ...result } });
    }
    return;
  }
  // Producer "scene deck": switch OBS to a named scene on demand (safer than
  // full auto-switching — the producer drives the cut). With the chrome
  // present, the branded wipe covers the frame first and the switch lands
  // under it; game-event auto-switches (onGameEventForObs) deliberately skip
  // the wipe because their timing is part of the goal sequence.
  if (action === "switch" && payload.scene) {
    let ok = false;
    try {
      if (chromeAvailable() && bridgeHandle && bridgeHandle.broadcastControl) {
        bridgeHandle.broadcastControl({ type: "chrome-wipe", payload: {} });
        // The wipe panel fully covers the canvas ~450ms into its 1s sweep.
        await new Promise((r) => setTimeout(r, 450));
      }
      ok = await obsController.switchScene(payload.scene);
    } catch (e) { /* fall through to the failure report */ }
    if (!ok && bridgeHandle && bridgeHandle.broadcastControl) {
      // A cut that silently doesn't happen mid-show reads as "panel broken";
      // name the scene so a renamed collection is diagnosable from the dock.
      bridgeHandle.broadcastControl({
        type: "obs-action-result",
        payload: { action, ok: false, error: `OBS could not switch to "${payload.scene}"` },
      });
    }
  }
}

// The wipe only makes sense when the chrome overlay is actually servable
// (present and, under the gate, approved) — otherwise a deck switch would
// just get slower for nothing.
function chromeAvailable() {
  return (overlayReg.list || []).some(
    (o) => o.scene === CHROME_SCENE_TYPE && (gateActive() ? o.approved : true)
  );
}

// Internal: translate game events into scene switches.
// Conservative: only fires if the master toggle is on AND the producer has
// mapped a scene name for the trigger. Unknown events / unmapped triggers
// silently do nothing.
function onGameEventForObs(env) {
  if (!obsSettings || !obsSettings.autoSwitchEnabled) return;
  if (!obsController || !obsController.status.connected) return;
  const map = obsSettings.sceneMap || {};
  const ev = env && env.event;
  if (ev === "GoalScored" && map.goal) {
    // Briefly cut to the "Goal" scene so RL's in-game "X Scored" text is
    // never composited into the broadcast. The replay-start handler below
    // will swap to the replay scene once RL fires it.
    obsController.switchScene(map.goal);
  } else if (ev === "GoalReplayStart" && map.replay) {
    obsController.switchScene(map.replay);
  } else if (ev === "GoalReplayEnd" || ev === "CountdownBegin" || ev === "RoundStarted") {
    onGameEventForObs._ended = false; // back in play -> re-arm the post-match trigger
    if (map.live) obsController.switchScene(map.live);
  } else if (ev === "MatchCreated" || ev === "MatchInitialized") {
    onGameEventForObs._ended = false;
  } else if ((ev === "MatchEnded" || ev === "PodiumStart") && map.postMatch) {
    // Real match-end events (CONTRACT.md). The old code keyed off Game.Winner,
    // which the mock never sets and is unverified in real RL. Debounce the
    // MatchEnded + PodiumStart pair (they fire together) with a one-shot flag.
    if (!onGameEventForObs._ended) {
      onGameEventForObs._ended = true;
      obsController.switchScene(map.postMatch);
    }
  }
}

// Toast notification on startup so the user has visible confirmation the app
// is running in the tray. Clicking it opens the control panel.
function notifyReady() {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: `${APP_TITLE} is live`,
      body: `Overlay: ${OVERLAY_URL}`,
      silent: true,
    });
    n.on("click", showWindow);
    n.show();
  } catch (e) {
    console.error("[rivalry] notify error:", e.message);
  }
}

// Enable auto-start the first time the app ever runs (producer convenience).
function applyFirstRunAutostart() {
  try {
    const marker = path.join(app.getPath("userData"), ".autostart-initialised");
    if (!fs.existsSync(marker)) {
      app.setLoginItemSettings({ openAtLogin: true });
      fs.writeFileSync(marker, new Date().toISOString());
    }
  } catch (e) {
    console.error("[rivalry] autostart init error:", e.message);
  }
}

// single instance only (avoid double-binding the ports)
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);

  app.whenReady().then(() => {
    // Windows needs an explicit AppUserModelID for native notifications
    // to work reliably in unpackaged dev runs. Without it, the toast appears
    // but the notification subsystem can behave strangely.
    // Must match the installer's appId or Windows treats toasts as coming from
    // an unregistered app and quietly drops them.
    try { app.setAppUserModelId(IS_BETA ? "gg.rivalry.casterverse.beta" : "gg.rivalry.casterverse"); } catch {}

    // Tee console output into <userData>/logs/casterverse.log plus a ring
    // buffer, so a packaged install finally has something to hand over when
    // it misbehaves (diagnostics export reads the ring). Before anything else
    // logs, so boot lines are captured.
    appLog.initAppLog(app.getPath("userData"));
    console.log("[rivalry] boot", META.label);

    // The rebrand moved userData ("RIVALRY Overlay*" -> "RIVALRY Casterverse*").
    // Carry the producer's saved state across ONCE, before anything reads it.
    try {
      const legacy = path.join(app.getPath("appData"), IS_BETA ? "RIVALRY Overlay Beta" : "rivalry-overlay");
      const m = migrateUserData(legacy, app.getPath("userData"));
      if (m.migrated) console.log("[rivalry] migrated settings from", m.from, "->", m.copied.join(", "));
    } catch (e) { console.error("[rivalry] userData migration:", e.message); }

    const r = runIniSetup();
    console.log("[rivalry] stats API config:", r.ok ? "written" : "RL folder not found yet");

    applyFirstRunAutostart();
    // Resolve dev settings before starting the HTTP server so the right root
    // is in place on first request. Falls back to __dirname if the saved
    // folder no longer exists (e.g. repo was moved).
    if (DEV_MODE_AVAILABLE) {
      devSettings = devSettingsStore.load(app.getPath("userData"));
      if (devSettings.enabled && !fs.existsSync(path.join(devSettings.path, "overlays", "rivalry-gameplay", "manifest.json"))) {
        console.warn("[rivalry] dev path missing, falling back to packaged:", devSettings.path);
        devSettings = { ...devSettings, enabled: false };
      }
    }
    bridgeHandle = startBridge({
      mock: process.argv.includes("--mock"),
      stateFile: path.join(app.getPath("userData"), "control-state.json"),
      setupInfo,
    });
    bridgeHandle.events.on("server-error", (info) => {
      if (info && info.code === "EADDRINUSE") {
        reportPortConflict(info.port, `${info.server} WebSocket server`);
      }
    });
    collector = startReplayCollector({});

    leagueSettings = leagueSettingsStore.load(app.getPath("userData"));
    if (process.argv.includes("--league-mock")) leagueSettings = { ...leagueSettings, mock: true };
    leagueClient = createLeagueClient({ getSettings: () => leagueSettings });
    // The match lock loads from disk here, BEFORE the HTTP server starts: a
    // restart mid-show comes back already locked to the same match, serving
    // scenes and cached logos with zero network involved.
    matchLock = createMatchLock({ userDataDir: app.getPath("userData") });
    if (matchLock.isLocked()) console.log("[rivalry] match lock restored:", matchLock.get().matchId);
    // Producer saves the league API key from the panel; persist it. The panel
    // confirms by re-fetching GET /league/status (masked); the key itself is
    // never echoed anywhere.
    bridgeHandle.events.on("control", (msg) => {
      if (msg && msg.type === "league-settings" && msg.payload) {
        const p = msg.payload;
        leagueSettings = {
          ...leagueSettings,
          ...(typeof p.apiKey === "string" ? { apiKey: p.apiKey.trim() } : {}),
          ...(typeof p.mock === "boolean" ? { mock: p.mock } : {}),
        };
        leagueSettingsStore.save(app.getPath("userData"), leagueSettings);
      }
    });
    apiRouter = createApiRouter({
      userDataDir: app.getPath("userData"),
      meta: META,
      httpPort: HTTP_PORT,
      getBridge: () => bridgeHandle,
      getObs: () => ({ settings: obsSettings, status: obsController ? obsController.status : null }),
      getSetupInfo: () => setupInfo,
      rewriteIni: runIniSetup,
      isSetupComplete,
      markSetupComplete,
      getOverlayReg: () => overlayReg,
      gateActive,
      getLeagueClient: () => leagueClient,
      getLeagueSettings: () => leagueSettings,
      getMatchLock: () => matchLock,
      maskLeagueKey: leagueSettingsStore.mask,
    });
    const initialRoot = devSettings.enabled ? devSettings.path : __dirname;
    startHttpServer(initialRoot);
    rescanOverlays();
    createWindow();
    createTray();
    setupAutoUpdate();
    setupObsIntegration();
    notifyReady();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // Stay alive in the tray when the window is closed; quit only via tray.
  app.on("window-all-closed", () => {});
}
