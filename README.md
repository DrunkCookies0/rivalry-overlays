# RIVALRY Casterverse

The RIVALRY league's broadcast suite for Rocket League, shipped as a single Windows installer. It reads Rocket League's official Stats API (Psyonix's sanctioned broadcast interface), so it is EAC-safe: no mods, no injection, nothing touches the game. One install gives you 8 broadcast scenes, a control panel that docks inside OBS, live RIVALRY league data, and OBS integration that builds and switches your scenes for you.

Current version: 0.6.x, heading to 1.0.0.

---

## For producers: quickstart

Full walkthrough with expected results at every step: [PRODUCER-SETUP.md](PRODUCER-SETUP.md). The short version:

1. **Install.** Download `RIVALRY-Casterverse-Setup-<version>.exe` from [Releases](../../releases) and run it.
2. **Get past SmartScreen.** Windows shows "Windows protected your PC". Click **More info**, then **Run anyway**. This is expected: the installer is unsigned, and the warning appears for every producer on first install.
3. **Activate.** The app opens on an activation gate. Enter the access key Alex issued you (it looks like `RCV1.<payload>.<signature>`). Keys are personal, do not share them; a shared key can be revoked remotely.
4. **Run the setup wizard.** It opens automatically on first launch:

| Step | What the app does | What you do |
|---|---|---|
| 1. Rocket League | Writes RL's stats config file (`DefaultStatsAPI.ini`) automatically, then waits for the game. | Restart Rocket League once. The wizard goes green when the feed connects. |
| 2. OBS | One-click **SET UP OBS FOR ME** builds the full RIVALRY scene collection, no password typing. A downloadable scene-collection file is the fallback. | Click the button, or import the file in OBS (**Scene Collection**, **Import**). |
| 3. Control panel | Shows the dock URL. | In OBS: **Docks**, **Custom Browser Docks**, add `http://localhost:49080/`. |

To re-run the wizard later: tray icon, **Setup guide**. The app lives in the system tray and starts with Windows, so it is ready before OBS opens; **Quit** is in the tray menu.

---

## The scenes

Each scene is a 1920x1080 OBS Browser Source. The scene collection wires all of them; URLs are one click away in the panel's Scenes card.

| Scene | What it shows |
|---|---|
| Starting Soon | Pre-stream holding screen with event title, teams, and start time. |
| Match Preview | Pre-match VS graphic with team names, logos, seeds, and records. |
| Casters | Caster cam wall via VDO.Ninja (names, roles, handles, live cams). |
| Gameplay | The tuned live overlay: scorebug, series pips, clock, boost, player tags, stat pops, kickoff countdown, and the full goal sequence. |
| Post-Game Results | Box score and MVP built from the live feed, frozen the moment the match ends. |
| Up Next | Upcoming matches, filled automatically from the broadcast schedule. |
| Be Right Back | Break screen. |
| Chrome | Always-on persistent frame: side rails, bottom ticker, lower thirds, and the branded wipe. |

**About the Chrome scene:** it is not a scene you switch to. It is added in OBS as one browser source layered on top of every scene, so the rails, ticker, and lower thirds persist through scene switches. **Build RIVALRY scene collection** (and the downloadable scene-collection file) place it automatically, and the game capture is pre-scaled into the chrome's interior window: 1792x1008 at position 64,0, exactly 16:9, no letterboxing.

There is no Bracket scene in v1.0. It lives in git history and returns for playoffs.

---

## Running a broadcast

### Match-first (the only mode)

The control panel opens on the **match finder**, and loading a real league match is the way into a broadcast: the packaged app serves no overlay scene until one is loaded. Enter your league API key once (issued from the league site, starts with `rv_`, sent in the `x-api-key` header), search for tonight's match, and load it. Loading locks the broadcast to that match and fills team names, logos, records, rosters, and event metadata across every scene at once. Logos are served through a local proxy because the upstream logo URLs expire in about 15 minutes.

**Load once, then cache.** The loaded match and its logos are cached to disk the moment they load. If the league site goes down mid-show (or the app restarts), the broadcast keeps running on the cached match; only *switching to a different match* needs the league reachable.

Fields that stay operator-entered because the API does not carry them: **best-of**, **seeds**, the **series score**, and **casters**.

### Broadcast schedule

The **Broadcast schedule** card lines up the whole night: add each series with its start time, and set the once-per-night season, circuit, and tier fields once. Loading a series from the schedule updates every scene at once, and the Up Next scene fills itself from the schedule. An importable JSON shape for schedules is documented in [SCHEDULE-SPEC.md](SCHEDULE-SPEC.md) (spec only for now).

### Overlay looks (sets)

Overlays ship in visual families. **Kinetic Bold** is the house look; community sets (like Moldybanana's **SC26**) provide alternate looks for some scene types. Pick a look in the Overlays / Scenes card and rebuild the OBS scene collection; scene types the chosen look doesn't cover fall back to the house look automatically.

### Caster cams

Caster cams run through VDO.Ninja, free and browser-based. Set a room name in the Casters card, click **Generate caster links**, send each caster their personal push link, and their cams appear on the Casters scene.

### Replay archive

The app copies each new replay into `Documents\RIVALRY Replays`, organized by event and matchup, with a JSON sidecar carrying the match context. **Open replays folder** is in the tray menu.

---

## If something's not working

| Symptom | What to check |
|---|---|
| Anything, before asking for help | Click **Export diagnostics** (control panel or tray). It writes a single `casterverse-diagnostics.json` (versions, ports, RL/OBS/league state with your key masked, overlay signature scan, recent log lines). Send that file. The full log is at `<userData>\logs\casterverse.log`. |
| SmartScreen blocks the installer | Click **More info**, then **Run anyway**. Expected for an unsigned installer. |
| Overlay is blank in OBS | Is the app running? Look for the tray icon. Was Rocket League restarted once after install? Then right-click the Browser Source and refresh. |
| Gameplay scene shows no live numbers | It only renders live data during a match (playing or spectating). Saved replays emit nothing. |
| "Port already in use" dialog at launch | Another app is holding port 49080, 49124, or 49777. The dialog names the port. Close the other app and relaunch. |
| Overlay shows "No league match is loaded" | That is the match gate: open the control panel, find your match, and load it. The source refreshes itself once a match is locked. |
| Match finder can't reach the league | Check the API key (starts with `rv_`) and your connection. A match that is already loaded keeps running from cache; only loading a *different* match needs the league site reachable. |
| Logos not loading | League logos go through the app's local proxy and are cached with the loaded match; refresh the Browser Source. |
| Boost meters show `--` | Boost data only exists on the PC that is spectating the match. That is a Rocket League limit, not a bug. |
| Need the setup wizard again | Tray icon, **Setup guide**. |
| Can't find the OBS import | OBS top menu bar: **Scene Collection**, then **Import**, then pick the downloaded file. |

---

## For developers

### How the data flows

```
Rocket League               RIVALRY Casterverse app             OBS
[Stats API]   raw TCP  ->   bridge + web server    ->   Browser Sources
:49123        JSON          :49124 game feed (ws)       http://localhost:49080
                            :49777 control bus (ws)     /overlays/<id>/index.html
                            :49080 web server (http)
```

1. On launch the app writes `DefaultStatsAPI.ini` into the Rocket League config folder (`Port=49123`, non-zero `PacketSendRate`). One RL restart turns the feed on.
2. RL streams raw TCP (not WebSocket): back-to-back JSON envelopes `{ "event": "...", "data": ... }` on `127.0.0.1:49123`. `data` is sometimes a JSON-encoded string needing a second parse.
3. Browsers can't open raw TCP, so the Electron main process frames the stream into whole JSON objects and re-broadcasts each over WebSocket on 49124. The control panel pushes branding and series data to overlays over a second relay WebSocket on 49777.
4. The HTTP server on 49080 serves the scenes and control panel, so OBS points at stable URLs regardless of install location. The root URL redirects to the control panel.
5. `bridge/league-client.js` talks to the RIVALRY league API (`therivalry.gg/api/v1`, `x-api-key` header) and proxies league logos locally because upstream URLs expire.

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
| `npm test` | Unit + HTTP gate tests. Run exactly this; never `node --test <dir>` (broken on this Node line) |
| `npm run verify:render` | Multi-resolution render gate. `--full` additionally proves the gameplay goal sequence at 720p/1080p/1440p/16:10 and is mandatory after any gameplay layout change |
| `npm run dev:bridge` | Bridge only, with mock data on the WebSocket ports |
| `npm run pack` | Unpacked build in `dist\win-unpacked\` for quick local testing |
| `npm run dist` | Build the NSIS installer (Windows machine required) |
| `npm run key:issue` / `key:list` / `key:revoke` / `key:verify` | Access-key toolchain (see RELEASE-HANDOFF.md section 6.8) |

`npm test` and `npm run verify:render` are the proof gate before any push.

### Dev mode (live-edit against a packaged app)

The tray gains a **Dev: serve overlay from local folder** toggle when the app runs unpacked or with `RIVALRY_DEV=1` set. When on, the HTTP server serves overlay and control HTML from your local repo folder instead of the packaged files, so edits go live in OBS after a browser-source refresh. No reinstall loop.

### The overlay kit

The kit under `overlays/` (SDK, template, data contract, signing CLIs) is internal tooling for building RIVALRY's own scenes; it is not currently open to third-party designers. Every shipped scene is Ed25519-signed and the packaged app serves only approved scenes, in addition to requiring access-key activation.

### Build, release, CI

- `npm run dist` builds `dist\RIVALRY-Casterverse-Setup-<version>.exe` via electron-builder (NSIS). Bump `version` in `package.json` per release.
- **Beta channel:** `pr-build.yml` builds and publishes a beta installer as a GitHub prerelease on every PR to `main` and every push to `feat/**` branches. Beta uses a separate appId and product name ("RIVALRY Casterverse Beta") so it installs alongside production. The 5 newest prereleases are kept.
- **Production:** `release.yml` builds and publishes only from a `v*` tag. Auto-update ships via electron-updater.
- The installer is unsigned, so SmartScreen warns on first run. A code-signing certificate (`win.certificateFile` in the build config, or an EV/cloud signer) would remove that.

---

## License

PolyForm Noncommercial 1.0.0. See [LICENSE](LICENSE).
