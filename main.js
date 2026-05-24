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

const { app, BrowserWindow, Tray, Menu, nativeImage, clipboard, shell } = require("electron");
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
const { getMeta } = require("./bridge/app-meta");

const HTTP_PORT = 49080;
const OVERLAY_URL = `http://localhost:${HTTP_PORT}/overlay/overlay.html`;
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

function startHttpServer(rootDir) {
  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    // Tiny meta endpoint so the control panel can render the build label.
    if (urlPath === "/version" || urlPath === "/version.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(META));
    }
    if (urlPath === "/" || urlPath === "") urlPath = "/control/control.html";
    const filePath = path.normalize(path.join(rootDir, urlPath));
    if (!filePath.startsWith(rootDir)) {
      res.writeHead(403);
      return res.end("forbidden");
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end("not found");
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 1040,
    minWidth: 360,
    autoHideMenuBar: true,
    title: APP_TITLE,
    backgroundColor: "#0e1218",
    icon: TRAY_ICON,
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
    // Beta builds have no update channel (each PR build is throwaway, no
    // latest.yml is published), so the menu item would do nothing visible.
    // Hide it entirely on beta to remove the dead UX.
    ...(IS_BETA ? [] : [{
      label: "Check for updates",
      click: () => { try { getAutoUpdater().checkForUpdates(); } catch (e) {} },
    }]),
    ...(IS_BETA ? [] : [{ type: "separator" }]),
    {
      label: "Start with Windows",
      type: "checkbox",
      checked: startsWithWindows,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
      },
    },
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
async function setupObsScenes() {
  if (!obsController || !obsController.status.connected) return;
  const scenes = [
    { sceneName: "RIVALRY - Live", sourceName: "RIVALRY Overlay", url: OVERLAY_URL },
  ];
  for (const s of scenes) {
    try { await obsController.createSceneWithBrowserSource(s); }
    catch (e) { console.error("[rivalry] scene setup failed:", e.message); }
  }
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
  autoUpdater.on("error", (e) => console.error("[rivalry] updater error:", e && e.message));
  autoUpdater.on("update-available", (i) => console.log("[rivalry] update available:", i && i.version));
  autoUpdater.on("update-downloaded", (i) => console.log("[rivalry] update downloaded:", i && i.version));
  autoUpdater.checkForUpdates().catch(() => {});
  // re-check every 30 minutes in case the app stays open across a release
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

async function handleObsAction({ action }) {
  if (!obsController || !obsController.status.connected) return;
  if (action === "setup-scenes") return setupObsScenes();
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
  } else if ((ev === "GoalReplayEnd" || ev === "CountdownBegin" || ev === "RoundStarted") && map.live) {
    obsController.switchScene(map.live);
  } else if (ev === "UpdateState" && map.postMatch) {
    // Match-end heuristic: Game.Winner becomes a non-empty team name.
    // Fire once per match by stashing the last GUID we switched on.
    const data = env.data || {};
    const winner = data.Game && data.Game.Winner;
    const guid = data.MatchGuid;
    if (winner && guid && onGameEventForObs._lastEnded !== guid) {
      onGameEventForObs._lastEnded = guid;
      obsController.switchScene(map.postMatch);
    }
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
    try {
      const r = runSetup();
      console.log("[rivalry] stats API config:", r.ok ? "written" : "RL folder not found yet");
    } catch (e) {
      console.error("[rivalry] setup error:", e.message);
    }

    applyFirstRunAutostart();
    bridgeHandle = startBridge({ mock: process.argv.includes("--mock") });
    collector = startReplayCollector({});
    startHttpServer(__dirname);
    createWindow();
    createTray();
    setupAutoUpdate();
    setupObsIntegration();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // Stay alive in the tray when the window is closed; quit only via tray.
  app.on("window-all-closed", () => {});
}
