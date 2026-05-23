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
const { autoUpdater } = require("electron-updater");
const http = require("http");
const fs = require("fs");
const path = require("path");

const { runSetup, startBridge } = require("./bridge/rl-bridge");
const { startReplayCollector } = require("./bridge/replay-collector");

const HTTP_PORT = 49080;
const OVERLAY_URL = `http://localhost:${HTTP_PORT}/overlay/overlay.html`;
const CONTROL_URL = `http://localhost:${HTTP_PORT}/control/control.html`;
const TRAY_ICON = path.join(__dirname, "assets", "tray.png");

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 1040,
    minWidth: 360,
    autoHideMenuBar: true,
    title: "RIVALRY Overlay",
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

function buildTrayMenu() {
  const startsWithWindows = app.getLoginItemSettings().openAtLogin;
  return Menu.buildFromTemplate([
    { label: "RIVALRY Overlay", enabled: false },
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
    {
      label: "Check for updates",
      click: () => { try { autoUpdater.checkForUpdates(); } catch (e) {} },
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
    { type: "separator" },
    {
      label: "Quit RIVALRY Overlay",
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray() {
  let img = nativeImage.createFromPath(TRAY_ICON);
  if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip("RIVALRY Overlay");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", showWindow);
}

// Enable auto-start the first time the app ever runs (producer convenience).
function setupAutoUpdate() {
  // Only in the packaged app; running unpacked (npm start) has no update feed.
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // installs on full quit, never mid-broadcast
  autoUpdater.on("error", (e) => console.error("[rivalry] updater error:", e && e.message));
  autoUpdater.on("update-available", (i) => console.log("[rivalry] update available:", i && i.version));
  autoUpdater.on("update-downloaded", (i) => console.log("[rivalry] update downloaded:", i && i.version));
  autoUpdater.checkForUpdates().catch(() => {});
  // re-check every 30 minutes in case the app stays open across a release
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 30 * 60 * 1000);
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
    startBridge({ mock: process.argv.includes("--mock") });
    collector = startReplayCollector({});
    startHttpServer(__dirname);
    createWindow();
    createTray();
    setupAutoUpdate();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // Stay alive in the tray when the window is closed; quit only via tray.
  app.on("window-all-closed", () => {});
}
