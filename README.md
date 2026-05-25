# RIVALRY Overlay

An in-house Rocket League broadcast overlay for the RIVALRY league, shipped as a
Windows installer. A control panel, a background bridge, and an OBS overlay you
can restyle however you like.

## How it actually works (the part worth understanding)

Rocket League ships an **official Stats API** (internally `MatchStatsExporter_TA`).
This is Psyonix's sanctioned, documented interface for broadcast tooling. No
game injection, no third party mod.

```
Rocket League                RIVALRY Overlay app           OBS
[Stats API]   raw TCP   ->   bridge + web server  -->  Browser Source
:49123        JSON           :49124 game feed (ws)      http://localhost:49080
                             :49777 control bus (ws)    /overlay/overlay.html
                             :49080 web server (http)
```

1. **Enable the exporter.** On launch the app writes `DefaultStatsAPI.ini` into the
   Rocket League config folder, setting `Port=49123` and a non-zero `PacketSendRate`.
   The user restarts Rocket League once.
2. **Rocket League streams raw TCP.** It is *not* a WebSocket. It writes JSON objects
   back to back on `127.0.0.1:49123`. Each is an envelope `{ "event": "...", "data": ... }`
   and `data` is sometimes a JSON-encoded string that needs a second parse.
3. **The app bridges TCP to WebSocket.** Browsers cannot open raw TCP sockets, so the
   Electron main process connects to 49123, frames the stream into whole JSON objects,
   and re-broadcasts each over WebSocket on 49124. This is the one piece you cannot
   skip.
4. **The overlay is a web page.** The app also serves `overlay/overlay.html` and
   `control/control.html` over `http://localhost:49080`, so OBS points at a stable URL
   regardless of where the app is installed. The control panel pushes team names,
   logos, series score, etc. to the overlay over a second relay WebSocket (49777).

### Events and data
`UpdateState` (live feed: players, boost, team scores, clock, spectated `Target`),
`GoalScored`, `StatfeedEvent` (demos etc.), `MatchCreated`, `MatchEnded`, and more.
`UpdateState.data` has `Players[]` (`Name`, `TeamNum` 0=blue/1=orange, `Score`,
`Goals`, `Shots`, `Assists`, `Saves`, `Touches`, `Boost`) and `Game`
(`Teams[]`, `TimeSeconds`, `Ball`, `Winner`).

### Limits to design around
- **Boost is spectator-scoped** (present only on the observing PC). Render `--` when absent.
- **No position data** in the feed, so no live minimap from this source alone.
- **Live matches only** (saved-replay viewing emits nothing).

---

## For end users (the people you ship to)

1. Run `RIVALRY-Overlay-Setup-<version>.exe` and install.
2. Launch **RIVALRY Overlay**. It enables the Rocket League stats feed automatically.
3. **Restart Rocket League once** (first time only) so the feed turns on.
4. In OBS add a **Browser Source**, width `1920`, height `1080`, URL:
   `http://localhost:49080/overlay/overlay.html` (the app's "Add to OBS" card has a copy button).
5. Set team names, logos, region tags, and series score in the app window. Start
   spectating a match and the scoreboard, boost meters, statfeed and goal banner go live.

### Run the control panel as an OBS dock (recommended)

Instead of the separate app window, you can dock the control panel inside OBS itself:

1. Make sure the RIVALRY Overlay app is running (it serves the panel and runs the bridge).
2. In OBS: **Docks → Custom Browser Docks…**
3. Add a dock named `RIVALRY` with URL `http://localhost:49080/control/control.html`, click Apply.
4. The panel appears as a dockable pane you can drag and snap anywhere in the OBS layout. OBS remembers it across restarts.

The panel layout is responsive, so it stays usable even in a narrow docked column. Note the
app still needs to be running for the dock to load and for live data to flow, so launch it
before (or alongside) OBS. The overlay itself stays a Browser Source in your scene as above.

### Runs in the background

The app lives in the system tray. Closing the window doesn't quit it; it keeps the bridge and
web server running so OBS keeps getting data. The tray icon menu has:

- **Show control panel** — reopen the window.
- **Copy overlay URL (OBS Browser Source)** and **Copy control panel URL (OBS Dock)** — the two URLs OBS needs.
- **Start with Windows** — on by default after first install, so it's ready before OBS opens. Toggle off here.
- **Quit RIVALRY Overlay** — fully exit.

### Handing it to a producer (the short version)

1. Send them `RIVALRY-Overlay-Setup-<version>.exe`. They install and launch it once.
2. They restart Rocket League once so the stats feed turns on.
3. In OBS: add a Browser Source with the overlay URL (in the scene), and add a Custom Browser
   Dock with the control panel URL. Both URLs are one click away in the tray menu and the app's
   "Add to OBS" card.

That's the whole setup. After that the app auto-starts with Windows and sits in the tray.

---

## For you (building and shipping the installer)

You build the `.exe` on a **Windows** machine. electron-builder produces the NSIS
installer natively there (no extra tooling).

```bash
cd rivalry-overlay
npm install            # pulls electron + electron-builder + ws
npm run dist           # builds dist\RIVALRY-Overlay-Setup-1.0.0.exe
```

The finished installer lands in `rivalry-overlay\dist\`. That single file is what you
hand to casters and team managers.

- Bump `version` in `package.json` for each release (it shows in the installer name).
- `npm run pack` makes an unpacked build in `dist\win-unpacked\` for quick local testing
  without producing the full installer.

### Code signing / SmartScreen
The installer is **unsigned**, so Windows SmartScreen will warn on first run
("More info" -> "Run anyway"). This is normal for indie tools. To remove the
warning, buy a code-signing certificate and add `win.certificateFile` /
`certificatePassword` (or an EV/cloud signer) to the `build` config. Optional.

### App icon
The RIVALRY icon is already wired up at `build/icon.ico` (used for the app, installer, and
uninstaller) and `assets/tray.png` (the system tray). To rebrand, replace those two files.

---

## Developing / testing without the game

```bash
npm install
npm run mock     # launches the app with fake match data (no Rocket League needed)
```

Or run just the data bridge and open the HTML files in a browser:

```bash
npm run dev:bridge      # bridge + fake data on the WebSocket ports
# then open overlay/overlay.html and control/control.html in a browser
```

## Replay collector

Rocket League writes `.replay` files to its Demos folder at
`Documents\my games\Rocket League\TAGame\Demos`. The app watches that folder and, when
a new replay appears, copies it into an organized archive at `Documents\RIVALRY Replays`:

```
RIVALRY Replays\<Event>\<TeamA-vs-TeamB>\<TeamA-vs-TeamB__Game3__2026-05-23_19-41-08.replay>
```

Alongside each replay it writes a `.json` sidecar with the match context (event, team names,
game number, timestamp) so the files can be auto-uploaded to match pages later. Team/event
names come from the control panel. Replays that already existed before launch are left alone,
so it only collects matches played during the session. "Open replays folder" is in the tray menu.

This works purely off whatever Rocket League writes natively to its Demos folder — no
modding, no game injection, EAC-safe. The Stats API itself can't export replays. If RL
on your setup only writes a replay when you click "Save Replay" after a match, click it
each game so the collector has something to pick up.

Different from third-party tools like rockpload, which authenticate against Epic Games
and pull replays directly from Psyonix's backend (RLAPI). That captures every game without
needing a local save, but doesn't carry the league event / team metadata that this app
attaches to each archived replay.

## Files
- `main.js` — Electron entry: writes the ini, starts the bridge + web server, opens the panel
- `bridge/rl-bridge.js` — TCP to WebSocket bridge + `runSetup()`; also a CLI (`--setup`, `--mock`)
- `bridge/replay-collector.js` — watches the RL Demos folder and archives replays + metadata
- `overlay/overlay.html` — the OBS browser source (RLCS-style scorebar, boost, statfeed, gauge, goal banner)
- `control/control.html` — operator control panel (team branding, series, OBS URL)
- `config/DefaultStatsAPI.ini` — reference copy of the snippet the app writes
- `assets/` — tray icon + RIVALRY logo and wordmark (used by the control panel)
- `build/icon.ico` — app / installer icon
- `package.json` — dependencies + electron-builder Windows config

## Ports (change in `bridge/rl-bridge.js` and `main.js` if they collide)
- `49123` Rocket League Stats API (raw TCP) — must match the ini
- `49124` game feed WebSocket (overlay subscribes)
- `49777` control bus WebSocket (control panel -> overlay)
- `49080` local web server (serves overlay + control to OBS / the app window)

## A note on legality
This uses Rocket League's own official, documented Stats API and does not modify or
inject into the game, so it is the supported path. All overlay code in this repo is
original RIVALRY work.
