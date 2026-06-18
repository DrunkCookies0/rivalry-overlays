/* =============================================================================
 * RIVALRY Overlay - Electron main process
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

const HTTP_PORT = 49080;
// Gameplay overlay now lives in the multi-scene tree (overlays/rivalry-gameplay,
// resolution-independent). The legacy /overlay/overlay.html is still served as a
// fallback during the transition, so existing OBS sources keep working.
const OVERLAY_URL = `http://localhost:${HTTP_PORT}/overlays/rivalry-gameplay/index.html`;
const CONTROL_URL = `http://localhost:${HTTP_PORT}/control/control.html`;
const TRAY_ICON = path.join(__dirname, "assets", "tray.png");

// Beta builds (built via electron-builder.beta.yml for CI PR artifacts) set
// productName to "RIVALRY Overlay Beta". We surface that in the tray + window
// title so producers running both prod + beta side by side can tell them apart
// at a glance. Detection runs once at boot.
const IS_BETA = (app.getName() || "").toLowerCase().includes("beta");
const APP_TITLE = IS_BETA ? "RIVALRY Overlay (BETA)" : "RIVALRY Overlay";
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

function startHttpServer(rootDir) {
  setHttpRoot(rootDir);
  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
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
    if (!filePath.startsWith(root)) {
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
  server.on("error", (e) => console.error("[rivalry] http server error:", e.message));
  server.listen(HTTP_PORT, "127.0.0.1", () => console.log(`[rivalry] web server -> ${OVERLAY_URL}`));
  return server;
}

let mainWindow = null;
let tray = null;
let collector = null;
let obsController = null;
let obsSettings = null;
let bridgeHandle = null;
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
  mainWindow.loadURL(CONTROL_URL);

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

function buildTrayMenu() {
  const startsWithWindows = app.getLoginItemSettings().openAtLogin;
  return Menu.buildFromTemplate([
    { label: APP_TITLE, enabled: false },
    { label: META.label, enabled: false },
    { type: "separator" },
    { label: "Show control panel", click: showWindow },
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
        } catch (e) {}
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
const OBS_SCENE_NAMES = {
  "gameplay": "RIVALRY - Live", "starting-soon": "RIVALRY - Starting Soon", "brb": "RIVALRY - BRB",
  "caster": "RIVALRY - Casters", "match-preview": "RIVALRY - Match Preview", "up-next": "RIVALRY - Up Next",
  "postgame": "RIVALRY - Post-Game", "bracket": "RIVALRY - Bracket",
};
async function setupObsScenes() {
  if (!obsController || !obsController.status.connected) return;
  const base = `http://localhost:${HTTP_PORT}`;
  // One OBS scene per available overlay, each with its Browser Source pre-wired.
  // In the packaged app only approved overlays are offered; dev offers all.
  const list = (overlayReg.list || []).filter((o) => (gateActive() ? o.approved : true));
  const scenes = list.map((o) => ({
    sceneName: OBS_SCENE_NAMES[o.scene] || ("RIVALRY - " + o.name),
    sourceName: o.name + " Overlay",
    url: base + o.url,
  }));
  if (!scenes.some((s) => s.sceneName === "RIVALRY - Live")) {
    scenes.unshift({ sceneName: "RIVALRY - Live", sourceName: "RIVALRY Overlay", url: OVERLAY_URL });
  }
  for (const s of scenes) {
    try { await obsController.createSceneWithBrowserSource(s); }
    catch (e) { console.error("[rivalry] scene setup failed:", e.message); }
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
      title: "Choose RIVALRY Overlays repo folder",
      defaultPath: devSettings.path || app.getPath("home"),
    });
    if (result.canceled || !result.filePaths.length) return;
    const picked = result.filePaths[0];
    if (!fs.existsSync(path.join(picked, "overlay", "overlay.html"))) {
      dialog.showMessageBox({
        type: "warning",
        message: "That folder does not look like a rivalry-overlays repo",
        detail: "Expected to find overlay/overlay.html inside it.",
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

  // Status changes -> repaint tray menu so producers can see live state.
  obsController.on("status", () => refreshTrayMenu());

  // Control panel -> main process messages.
  if (bridgeHandle && bridgeHandle.events) {
    bridgeHandle.events.on("control", (msg, sourceWs) => {
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
        obsSettings = { ...obsSettings, ...msg.payload };
        obsSettingsStore.save(userDataDir, obsSettings);
        obsController.applySettings(obsSettings).catch(() => {});
        // Echo current settings + status back to the panel.
        if (bridgeHandle.broadcastControl) {
          bridgeHandle.broadcastControl({
            type: "obs-status",
            payload: { settings: obsSettings, status: obsController.status },
          });
        }
      } else if (msg && msg.type === "obs-action") {
        handleObsAction(msg.payload || {});
      } else if (msg && msg.type === "obs-query") {
        handleObsQuery(msg.payload || {}, sourceWs);
      }
    });

    // Auto-scene-switching on game events (off by default; gated by
    // autoSwitchEnabled + a non-empty scene name for each trigger).
    bridgeHandle.events.on("game", (env) => onGameEventForObs(env));
  }
}

async function handleObsAction(payload) {
  if (!obsController || !obsController.status.connected) return;
  const action = payload && payload.action;
  if (action === "setup-scenes") return setupObsScenes();
  // Producer "scene deck": switch OBS to a named scene on demand (safer than
  // full auto-switching — the producer drives the cut).
  if (action === "switch" && payload.scene) {
    try { await obsController.switchScene(payload.scene); } catch (e) { /* unknown scene -> no-op */ }
  }
}

async function handleObsQuery({ query }, sourceWs) {
  if (!obsController || !obsController.status.connected) return;
  if (query === "list-scenes") {
    try {
      const scenes = await obsController.listScenes();
      if (sourceWs && sourceWs.readyState === sourceWs.OPEN) {
        sourceWs.send(JSON.stringify({
          type: "obs-scenes",
          payload: { scenes },
        }));
      }
    } catch (e) { /* ignore */ }
  }
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
    try { app.setAppUserModelId("com.rivalry.overlay"); } catch {}

    try {
      const r = runSetup();
      console.log("[rivalry] stats API config:", r.ok ? "written" : "RL folder not found yet");
    } catch (e) {
      console.error("[rivalry] setup error:", e.message);
    }

    applyFirstRunAutostart();
    // Resolve dev settings before starting the HTTP server so the right root
    // is in place on first request. Falls back to __dirname if the saved
    // folder no longer exists (e.g. repo was moved).
    if (DEV_MODE_AVAILABLE) {
      devSettings = devSettingsStore.load(app.getPath("userData"));
      if (devSettings.enabled && !fs.existsSync(path.join(devSettings.path, "overlay", "overlay.html"))) {
        console.warn("[rivalry] dev path missing, falling back to packaged:", devSettings.path);
        devSettings = { ...devSettings, enabled: false };
      }
    }
    bridgeHandle = startBridge({ mock: process.argv.includes("--mock") });
    collector = startReplayCollector({});
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
