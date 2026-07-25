# RIVALRY Overlay

A Rocket League broadcast suite for league play, shipped as a single Windows installer. It reads Rocket League's official Stats API (Psyonix's sanctioned broadcast interface), so it is EAC-safe: no mods, no injection, nothing touches the game. One install gives you 7 broadcast scenes, a control panel that docks inside OBS, and OBS integration that can build and switch your scenes for you.

---

## Install and set up

This section is for broadcast producers. Total time: about five minutes.

1. Download `RIVALRY-Overlay-Setup-<version>.exe` from [Releases](../../releases).
2. Run it. Windows SmartScreen will warn you. Click **More info**, then **Run anyway**. This is expected: the installer is not code-signed yet, and buying a signing certificate is what would remove the warning.
3. Launch **RIVALRY Overlay**. A guided setup wizard opens on first launch:

| Step | What the app does | What you do |
|---|---|---|
| 1. Rocket League | Writes RL's stats config file automatically, then waits for the game. | Restart Rocket League once. The wizard shows "waiting for Rocket League", then goes green. |
| 2. OBS | Offers a ready-made OBS scene collection (also available from the control panel). | Download it, then in OBS: **Scene Collection** menu, **Import**. All 7 scenes arrive pre-wired. Alternative: connect obs-websocket and click **Create all OBS scenes**. |
| 3. Control panel | Shows you the panel URL. | In OBS: **Docks**, **Custom Browser Docks**, add `http://localhost:49080/`. Or open that URL in any browser. |

That is the whole setup. To re-run the wizard at any time: tray icon, **Setup guide**.

The app lives in the system tray and starts with Windows by default, so it is ready before OBS opens. Closing the window does not quit it; the tray menu has **Quit** when you really want it gone.

---

## Running a broadcast

### The 7 scenes

Each scene is a 1920x1080 OBS Browser Source. The pre-made scene collection wires all of them; URLs are also one click away in the panel's Scenes card.

| Scene | What it shows |
|---|---|
| Starting Soon | Pre-stream holding screen with event title, teams, and start time. |
| Match Preview | Pre-match VS graphic with team names, logos, seeds, and records. |
| Casters | Caster frames with names, roles, handles, and live cams. |
| Gameplay | The live in-match overlay: scorebug, series pips, clock, boost, player tags, stat pops, kickoff countdown, and the full goal sequence (flash, banner, replay card). |
| Post-Game Results | Box score and MVP, frozen automatically the moment the match ends. |
| Up Next | Schedule of up to 4 upcoming matches. |
| Be Right Back | Break screen. |
| Bracket | Single-elimination playoff bracket with champion slot. |

### The control panel

Open it as an OBS dock (or in a browser) at `http://localhost:49080/`. Fill in the cards, click **PUSH TO OVERLAY**, and every scene updates live. The panel remembers everything you type across app restarts.

| Card | What it controls |
|---|---|
| Overlays / Scenes | Every scene with Copy URL and Preview buttons, plus the Manual / Match mode toggle. |
| Team A / Team B | Name, logo, tag, seed, record, series games won. Logos: paste a URL or upload a file (drag-drop or file picker). |
| Series | Best of, event title strip, round subtitle, start time. |
| Casters | Up to 3 casters with names, roles, handles, and cam feeds. |
| Up Next | The schedule shown on the Up Next scene. |
| Player Titles | Per-player title and badges shown on that player's goal banner (name must match the in-game name exactly). |
| Bracket | Playoff matchups and champion. |
| OBS integration | obs-websocket connection, **Create all OBS scenes**, a scene deck for one-click live switching, and optional auto-switch on game events. |

### Manual mode vs Match mode

- **Manual (default):** you type team names, logos, and series info yourself. Everything in this app works fully in Manual mode, for any league. The tool is not locked to the RIVALRY website.
- **Match (league):** enter your league API key, pick a scheduled match, and team names, logos, and series info auto-fill from the RIVALRY website. Honest status: the league endpoints are still rolling out server-side, so Match mode may not be live for your league yet. Until it is, Manual mode is the path, and nothing else in the app depends on it.

### Caster cams

Caster cams run through VDO.Ninja, free and browser-based, no accounts or extra software. Set a room name in the Casters card, click **Generate caster links**, send each caster their personal push link, and their cams appear on the Casters scene.

### Replay archive

The app watches Rocket League's Demos folder and copies each new replay into `Documents\RIVALRY Replays`, organized by event and matchup, with a JSON sidecar carrying the match context (event, teams, game number, timestamp). **Open replays folder** is in the tray menu. This uses only the files RL writes natively, so it is EAC-safe; if your RL only saves a replay when you click "Save Replay", click it each game.

---

## If something's not working

| Symptom | What to check |
|---|---|
| Overlay is blank in OBS | Is the app running? Look for the tray icon. Was Rocket League restarted once after install? Then right-click the Browser Source and refresh. |
| Gameplay scene shows no live numbers | It only renders live data during a match (playing or spectating). Saved replays emit nothing. |
| SmartScreen blocks the installer | Click **More info**, then **Run anyway**. Expected for an unsigned installer. |
| "Port already in use" dialog at launch | Another app is holding port 49080, 49124, or 49777. The dialog names the port. Close the other app and relaunch. |
| Logos not loading | A pasted URL must point directly at an image file. If in doubt, upload the file in the panel instead, then push again. |
| Boost meters show `--` | Boost data only exists on the PC that is spectating the match. That is a Rocket League limit, not a bug. |
| Need the setup wizard again | Tray icon, **Setup guide**. |
| Can't find the OBS import | OBS top menu bar: **Scene Collection**, then **Import**, then pick the downloaded file. |

---

## Screenshots

<!--
screenshots to capture and drop into docs/img/ (1920x1080 window grabs unless noted):
- setup-wizard-rl-connected.png : wizard step 1 in the green "connected" state
- obs-scene-collection-import.png : OBS Scene Collection menu open on Import
- control-panel-dock.png : control panel docked inside OBS, Scenes card visible
- scenes-card-copy-url.png : close crop of the Scenes card with Copy URL / Preview buttons
- gameplay-live.png : gameplay scene over a live match
- postgame-results.png : post-game box score scene
-->

![Setup wizard, Rocket League connected](docs/img/setup-wizard-rl-connected.png)

![Control panel docked in OBS](docs/img/control-panel-dock.png)

![Gameplay overlay over a live match](docs/img/gameplay-live.png)

![Post-game results scene](docs/img/postgame-results.png)

---

## For developers

### How the data flows

```
Rocket League               RIVALRY Overlay app             OBS
[Stats API]   raw TCP  ->   bridge + web server    ->   Browser Sources
:49123        JSON          :49124 game feed (ws)       http://localhost:49080
                            :49777 control bus (ws)     /overlays/<id>/index.html
                            :49080 web server (http)
```

1. On launch the app writes `DefaultStatsAPI.ini` into the Rocket League config folder (`Port=49123`, non-zero `PacketSendRate`). One RL restart turns the feed on.
2. RL streams raw TCP (not WebSocket): back-to-back JSON envelopes `{ "event": "...", "data": ... }` on `127.0.0.1:49123`. `data` is sometimes a JSON-encoded string needing a second parse.
3. Browsers can't open raw TCP, so the Electron main process frames the stream into whole JSON objects and re-broadcasts each over WebSocket on 49124. The control panel pushes branding and series data to overlays over a second relay WebSocket on 49777.
4. The HTTP server on 49080 serves the scenes and control panel, so OBS points at stable URLs regardless of install location. The root URL redirects to the control panel.

Feed limits to design around: boost is spectator-scoped (render `--` when absent), there is no position data (no live minimap from this source), and only live matches emit events (saved replays are silent).

### Ports

Change in `bridge/rl-bridge.js` and `main.js` if they collide.

| Port | Carries |
|---|---|
| 49123 | Rocket League Stats API (raw TCP, must match the ini) |
| 49124 | Game feed WebSocket (overlays subscribe) |
| 49777 | Control bus WebSocket (control panel to overlays) |
| 49080 | HTTP server (scenes, control panel, `/overlays/registry.json`) |

### npm scripts

```bash
npm install
```

| Command | Does |
|---|---|
| `npm start` | Run the app |
| `npm run mock` | Run the app with fake match data (no Rocket League needed) |
| `npm test` | Unit + HTTP gate tests (`node --test tests/`) |
| `npm run verify:render` | Headless render verification |
| `npm run dev:bridge` | Bridge only, with mock data on the WebSocket ports |
| `npm run pack` | Unpacked build in `dist\win-unpacked\` for quick local testing |
| `npm run dist` | Build the NSIS installer (Windows machine required) |
| `npm run overlay:keygen` / `overlay:sign` / `overlay:verify` | Overlay signing toolchain (see below) |

### Dev mode (live-edit against a packaged app)

The tray gains a **Dev: serve overlay from local folder** toggle when the app runs unpacked or with `RIVALRY_DEV=1` set. When on, the HTTP server serves overlay and control HTML from your local repo folder instead of the packaged files, so edits go live in OBS after a browser-source refresh. No reinstall loop.

### Overlay authoring and the signing gate

Overlays live in `overlays/`, one folder per scene, each with a `manifest.json`. Start with [overlays/README.md](overlays/README.md) (the authoring kit) and [overlays/CONTRACT.md](overlays/CONTRACT.md) (the versioned data contract). The SDK has a built-in mock, so designers need neither the app nor Rocket League.

Signing model in one line: every overlay folder is Ed25519-signed after review; the packaged app's loader verifies signatures at boot and serves only approved overlays, while unsigned or edited ones load in dev mode only, with a preview badge.

Legacy note: the shipped gameplay overlay is `overlays/rivalry-gameplay/index.html`. The old `/overlay/overlay.html` path is still served as a silent fallback so pre-migration OBS sources keep working; do not use it for anything new.

### Build, release, CI

- `npm run dist` builds `dist\RIVALRY-Overlay-Setup-<version>.exe` via electron-builder (NSIS). Bump `version` in `package.json` per release.
- **Beta channel:** `pr-build.yml` builds and publishes a beta installer as a GitHub prerelease on every PR to `main` and every push to `feat/**` branches. Beta uses a separate appId and product name ("RIVALRY Overlay Beta") so it installs alongside production. The 5 newest prereleases are kept.
- **Production:** `release.yml` builds and publishes on `v*` tags. Auto-update ships via electron-updater.
- The installer is unsigned, so SmartScreen warns on first run. A code-signing certificate (`win.certificateFile` in the build config, or an EV/cloud signer) would remove that.

---

## License

PolyForm Noncommercial 1.0.0. See [LICENSE](LICENSE).
