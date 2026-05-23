# Handoff: GitHub auto-update + CI release for RIVALRY Overlay

## Goal

Make the installed RIVALRY Overlay app update itself automatically when we publish a
new version, and make publishing a new version a one-step action (push a git tag).

We use `electron-updater` pointed at GitHub Releases, and a GitHub Actions workflow that
builds the Windows installer on a clean runner and publishes the release.

Target repo: `https://github.com/DrunkCookies0/rivalry-broadcaster`
(owner `DrunkCookies0`, repo `rivalry-broadcaster`).

## Background (what already exists)

This is an Electron app. The relevant files at the project root:

- `package.json` - electron-builder is already configured to produce an NSIS Windows
  installer (`RIVALRY-Overlay-Setup-<version>.exe`). Has `build.win`, `build.nsis`,
  `build.files`, and a `dist` script (`electron-builder --win`).
- `main.js` - Electron main process. It already calls `app.whenReady().then(() => { ... })`
  to start things, has a `buildTrayMenu()` that returns a `Menu.buildFromTemplate([...])`,
  and keeps a single window that hides to the system tray on close (the app keeps running
  in the tray; it only fully quits via the tray "Quit" item).
- `bridge/`, `overlay/`, `control/`, `assets/`, `config/`, `build/icon.ico` - app content.

There is currently NO auto-update. Updating means rebuilding and reinstalling by hand.
This task adds auto-update.

## Repo layout requirement

Push the CONTENTS of the `rivalry-overlay` project folder to the repo ROOT, so that
`package.json` and `main.js` sit at the top level of `rivalry-broadcaster`. The CI
workflow below assumes the project is at the repo root. (If you instead keep the project
in a subfolder, add `defaults: { run: { working-directory: <subfolder> } }` to the
workflow job and adjust accordingly.)

---

## Change 1 - package.json

1. Add `electron-updater` to **dependencies** (NOT devDependencies; it is required at
   runtime and must be packaged into the app):

```json
"dependencies": {
  "ws": "^8.18.0",
  "electron-updater": "^6.3.9"
}
```

2. Add a `release` script next to the existing `dist` script:

```json
"scripts": {
  "start": "electron .",
  "mock": "electron . --mock",
  "dev:bridge": "node bridge/rl-bridge.js --mock",
  "setup": "node bridge/rl-bridge.js --setup",
  "dist": "electron-builder --win",
  "release": "electron-builder --win --publish always"
}
```

3. Add a `publish` block inside the existing `"build"` object (alongside `win`, `nsis`,
   `files`, etc.). `releaseType: "release"` makes the GitHub Release publish immediately so
   auto-update can see it. (If you prefer to review each release before it goes live, use
   `"draft"` instead, but then auto-update will not pick it up until you click Publish on
   the release in GitHub.)

```json
"publish": [
  {
    "provider": "github",
    "owner": "DrunkCookies0",
    "repo": "rivalry-broadcaster",
    "releaseType": "release"
  }
]
```

---

## Change 2 - main.js (auto-update logic)

Add the `electron-updater` import near the other requires at the top of `main.js`:

```js
const { autoUpdater } = require("electron-updater");
```

Add this helper function (anywhere at module scope, e.g. near the other helpers):

```js
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
```

Call it inside the existing `app.whenReady().then(() => { ... })` block, after the window
and tray are created. Find the lines that already call `createWindow();` and
`createTray();` and add the call right after:

```js
    createWindow();
    createTray();
    setupAutoUpdate();   // <-- add this line
```

(Optional, nice to have) Add a "Check for updates" item to `buildTrayMenu()`'s template
array, near the other items:

```js
    { label: "Check for updates", click: () => { try { autoUpdater.checkForUpdates(); } catch (e) {} } },
```

Notes:
- Do not call `autoUpdater.quitAndInstall()` automatically. The default
  `autoInstallOnAppQuit = true` applies the update when the operator fully quits the app
  from the tray, so an update never interrupts a live broadcast.
- The app hides to tray on window close, so "quit" means the tray Quit item.

---

## Change 3 - .github/workflows/release.yml (CI build + publish)

Create this file. It builds the Windows installer on a clean Windows runner (which also
avoids the local `winCodeSign` "cannot create symbolic link" error that happens on some
Windows dev machines) and publishes the GitHub Release.

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write   # needed for electron-builder to create/upload the release

jobs:
  build-and-publish:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: npm install

      - name: Build and publish Windows installer
        run: npm run release
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

The built-in `GITHUB_TOKEN` (provided automatically to the workflow) plus the
`contents: write` permission is enough for electron-builder to publish to GitHub Releases.
No personal access token is required.

---

## Change 4 - .gitignore

Create (or update) `.gitignore` at the repo root:

```
node_modules/
dist/
*.log
.DS_Store
```

---

## Release process (how we ship an update after this is set up)

1. Make your code changes and test locally with `npm run mock`.
2. Bump `"version"` in `package.json` (for example `1.0.0` to `1.0.1`). The version MUST
   match the git tag you push in the next step.
3. Commit, then create and push a matching tag:
   ```
   git add -A
   git commit -m "v1.0.1: <summary>"
   git tag v1.0.1
   git push origin main --tags
   ```
4. The `Release` workflow runs, builds `RIVALRY-Overlay-Setup-1.0.1.exe`, and publishes a
   GitHub Release containing that installer and a `latest.yml` file.
5. Every installed copy of the app checks the release feed on launch (and every 30 min),
   downloads the update in the background, and applies it the next time the operator quits
   the app from the tray. New installs just download the latest installer from the repo's
   Releases page.

`latest.yml` is the file `electron-updater` reads to detect new versions. electron-builder
generates and uploads it automatically as part of `npm run release`. Do not delete it from
the release.

---

## Acceptance criteria

- Pushing a tag like `v1.0.1` produces a published GitHub Release on
  `DrunkCookies0/rivalry-broadcaster` containing `RIVALRY-Overlay-Setup-1.0.1.exe` and
  `latest.yml`.
- Installing an older version, then publishing a newer one, results in the running app
  detecting and downloading the update, and applying it after the app is quit and relaunched.
- `npm install` then `npm run dist` still builds locally (unchanged behavior).

## Test plan

1. Set version to `1.0.0`, push tag `v1.0.0`, confirm the release is created with the
   `.exe` and `latest.yml`. Install it on a Windows machine.
2. Set version to `1.0.1`, push tag `v1.0.1`, confirm the new release.
3. Launch the installed `1.0.0` app, wait for it to check (or use the tray "Check for
   updates" item), confirm the log shows "update downloaded", then quit from the tray and
   relaunch. Confirm it is now `1.0.1` (the version shows in the app/installer).

## Notes / gotchas

- `electron-updater` must be in `dependencies`, not `devDependencies`, or it will not be
  packaged and the app will crash on `require`.
- The installer is unsigned. Auto-update works fine unsigned on Windows; SmartScreen only
  warns on a fresh manual install, not on silent updates. Code signing can be added later
  via `build.win.certificateFile` if desired.
- Keep `package.json` `version` and the git tag in sync; a mismatch makes electron-builder
  publish to a release name that does not match the tag.
- Do not build releases on the local Windows dev machine if it hits the `winCodeSign`
  symlink error; use the CI workflow (the runner has the needed privilege). Local
  `npm run dist` for test builds still works if Developer Mode is enabled or the build runs
  from an elevated terminal.
