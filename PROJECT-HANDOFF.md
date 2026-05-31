# RIVALRY Overlay - Project Handoff

A complete handoff for anyone taking over this project. It explains
what the app is, how it works, every file, how to run and ship it, what is done, what is
shaky, and what is next.

---

## 1. What this is and why it exists

RIVALRY Overlay is an in-house Rocket League broadcast overlay for the RIVALRY esports
league. It draws the on-stream scoreboard, boost meters, stat feed, goal graphics, and
stinger transitions, and it auto-collects match replays.

Background: Rocket League ships an OFFICIAL, sanctioned Stats API ("MatchStatsExporter_TA"),
and this project is built on that. No game injection, no mods, nothing that can get a player
banned. Fully under RIVALRY's control and tailored to the league experience.

---

## 2. How it works (architecture)

```
Rocket League                  RIVALRY Overlay app (Electron)          OBS
[Stats API]    raw TCP    ->   bridge: TCP -> WebSocket          ->    Browser Source (overlay)
:49123         JSON            :49124  game feed (ws)                  Custom Browser Dock (control)
                               :49777  control relay (ws)
                               :49080  local web server (http)
                               + replay collector (watches Demos folder)
                               + system tray, auto-start
```

The chain:

1. On launch the app writes `DefaultStatsAPI.ini` into the user's Rocket League config to
   turn the game's Stats API on. The user restarts Rocket League once.
2. Rocket League opens a RAW TCP socket on `127.0.0.1:49123` and streams concatenated JSON
   match events while a match is live. It is NOT a WebSocket, and a message's `data` field
   is sometimes itself a JSON string that needs a second parse.
3. Browsers cannot open raw TCP, so the app's bridge connects to 49123, frames the JSON by
   brace-matching, and re-broadcasts each message over WebSocket on `49124`.
4. The app also serves the overlay and control panel over `http://localhost:49080` so OBS
   can use a stable URL no matter where the app is installed.
5. The overlay (a web page) reads the game feed on 49124 and draws everything. The control
   panel pushes branding and series info to the overlay over a relay WebSocket on 49777.

This local-first design means the overlay works offline and is fully self-contained.

---

## 3. The Rocket League Stats API (the data source)

- Enabled via `Documents\My Games\Rocket League\TAGame\Config\DefaultStatsAPI.ini`
  (also `TAStatsAPI.ini`), section `[TAGame.MatchStatsExporter_TA]`, keys `Port` (default
  49123) and `PacketSendRate` (updates per second, 1 to 120; 0 disables). Restart RL after
  editing.
- Transport: raw TCP, concatenated JSON objects, envelope shape `{ event, data }`.
- It is READ-ONLY telemetry. It cannot change anything in the game (so the in-game
  "X Scored" text and the in-game scoreboard cannot be hidden via the API; we cover them
  with our own graphics instead).
- Events: `UpdateState` (the periodic scoreboard feed), `GoalScored`, `StatfeedEvent`
  (demos, saves, etc.), `BallHit`, `CrossbarHit`, `GoalReplayStart`, `GoalReplayWillEnd`,
  `GoalReplayEnd`, `MatchCreated`, `MatchInitialized`, `MatchEnded`, `MatchDestroyed`,
  `CountdownBegin`, `RoundStarted`, `PodiumStart`, `ClockUpdatedSeconds`, `ReplayCreated`,
  `MatchPaused`, `MatchUnpaused`.
- `UpdateState.data`: `Players[]` (Name, PrimaryId, TeamNum 0=blue/1=orange, Score, Goals,
  Shots, Assists, Saves, Touches, Boost) and `Game` (Teams[] with Name/Score, TimeSeconds,
  Ball, Winner). It also appears to carry which player is being spectated (see caveat #8.2).
- Known limits: Boost only appears on the spectating PC; no continuous car/ball positions
  (so no live minimap from this feed); live matches only (saved replays emit nothing); bot
  matches collapse every PrimaryId to one value.

Official docs: https://www.rocketleague.com/developer/stats-api (JavaScript-rendered).
A useful community reference: https://github.com/zomlit/rocket-league-stats-api

---

## 4. File-by-file

Project root (push these as the repo root of `DrunkCookies0/rivalry-broadcaster`):

- `package.json` - dependencies (`ws`, dev `electron`, `electron-builder`), npm scripts, and
  the electron-builder Windows/NSIS config (installer name, icon, files list).
- `main.js` - Electron main process. On ready it: writes the ini (`runSetup`), starts the
  bridge (`startBridge`), starts the replay collector, starts the local web server on 49080,
  opens the control panel window, and creates the system tray. Closing the window hides to
  tray (the bridge keeps serving); the app quits only via the tray. Auto-starts with Windows
  on first run. Tray menu: show panel, copy overlay URL, copy control panel URL, open
  replays folder, start-with-Windows toggle, quit.
- `bridge/rl-bridge.js` - the data bridge, importable + CLI.
  - `runSetup()` writes `DefaultStatsAPI.ini`, returns `{ written, ok }`.
  - `startBridge({ mock })` opens the game-feed WS (49124) and control relay WS (49777),
    and either connects to Rocket League on TCP 49123 or emits mock data.
  - Contains the `JsonFrameBuffer` (brace-matching framer) and `decodeEnvelope`.
  - Mock mode emits schema-accurate UpdateState (with a rotating spectated `Target`),
    StatfeedEvent demos, and a full goal sequence (GoalScored, GoalReplayStart,
    GoalReplayWillEnd, GoalReplayEnd, CountdownBegin) for testing without the game.
  - CLI: `node bridge/rl-bridge.js --setup | --mock`.
- `bridge/replay-collector.js` - watches the RL `Demos` folder; when a new `.replay` appears
  it copies it into `Documents\RIVALRY Replays\<Event>\<TeamA-vs-TeamB>\...Game<N>...replay`
  and writes a `.json` sidecar (event, teams, game number, timestamp) for future match-page
  upload. Gets team/event context by subscribing to the control relay (49777). Ignores
  replays that existed before launch (only collects the current session).
- `overlay/overlay.html` - the OBS Browser Source. Single self-contained file (CSS + JS).
  Connects to the game feed (49124) and control relay (49777). Renders: top scorebar (event
  title strip, team names/logos, colored scores, white clock, region tags, segmented series
  pips), per-player boost tags down each side (blue left / red right) with the spectated
  player highlighted, a bottom stat feed bar (focused player Goals/Shots/Assists/Saves/Demos),
  a radial boost gauge (bottom right), the custom goal banner, and the stinger wipe. Goal
  sequence is event-driven (see section 6).
- `control/control.html` - the control panel, also usable as an OBS Custom Browser Dock.
  Sets team names, logos (URL), accent colors, region/seed tags, best-of, series score,
  event title, and the goal-sequence toggle + banner text template. Pushes state live over
  the relay (49777). Responsive so it works docked narrow. Has an "Add to OBS" card with the
  overlay URL and a copy button.
- `config/DefaultStatsAPI.ini` - reference copy of the snippet the app writes.
- `assets/` - `tray.png` (system tray icon), `rivalry-logo.svg` (RV monogram, used by the
  stinger), `rivalry-wordmark.svg` (used in the control panel header).
- `build/icon.ico` - app + installer icon (RV monogram on the navy tile).
- `README.md` - end-user + build + dock instructions.
- `AUTO-UPDATE-HANDOFF.md` - separate handoff for wiring up GitHub auto-update + CI
  (electron-updater). Not yet implemented; see Roadmap.

Ports (defined in `bridge/rl-bridge.js` and `main.js`): 49123 RL TCP, 49124 game WS,
49777 control WS, 49080 http server.

---

## 5. Run, develop, build

Requires Node.js 18+ and (for building) a Windows machine.

```bash
npm install

# develop with fake data, no Rocket League needed:
npm run mock          # launches the Electron app with mock match data
# or run just the data bridge and open the HTML files in a browser:
npm run dev:bridge

# real use:
npm run setup         # writes DefaultStatsAPI.ini (or the app does it on launch)
npm start             # run the app against a real Rocket League

# build the Windows installer:
npm run dist          # produces dist\RIVALRY-Overlay-Setup-<version>.exe
```

OBS setup: add a Browser Source at `http://localhost:49080/overlay/overlay.html`
(1920x1080), and a Custom Browser Dock at `http://localhost:49080/control/control.html`.
The app must be running for both.

---

## 6. Feature status (what is built)

- RLCS-style scoreboard: event title strip, team names/logos, colored score blocks, white
  clock, region/seed tags, segmented best-of series pips. Done.
- Per-player boost tags, blue left / red right, with the spectated player highlighted. Done.
- Bottom stat feed bar for the focused player (Goals/Shots/Assists/Saves/Demos). Done.
  Demos are tallied from `StatfeedEvent` since they are not in `UpdateState`.
- Radial boost gauge for the focused player (bottom right). Done.
- Goal sequence (event-driven), all themeable. RL's canonical event names are
  `ReplayPlaybackStart` / `ReplayWillEnd` / `ReplayPlaybackEnd` (pre-v0.5.2 code listened
  for `GoalReplayStart` / `GoalReplayEnd` which never fired in real matches — fixed).
  - `GoalScored` -> scoreboard GOAL flash over the scoring team's name + custom banner
    sweeps across center with avatar, name, optional subtitle + badge slots (placeholder
    test data until league API). Banner text is a template (`{SCORER} SCORED!` default).
  - `ReplayPlaybackStart` -> banner hides; replay card timer left alive so the card
    appears mid-replay with goal stats + MPH + assister attribution.
  - `ReplayWillEnd` (~3s pre-warning) -> replay card hides early.
  - `ReplayPlaybackEnd` -> stinger wipe fires to mask the cut back to live.
  - `CountdownBegin` -> stinger backstop fires if needed; 3-2-1-GO! center countdown starts.
  - `RoundStarted` -> GO! lands on ball drop.
  Bot/freeplay matches don't emit `ReplayPlayback*` — fallback timers in `onGoalScored`
  drive the same sequence and get cancelled when (and if) real events arrive. Goal banner
  + replay card + stat pop visuals all dedup against RL's double-fire of `GoalScored`.
  Done.
- Match-state indicators:
  - OVERTIME state strip (red pulse below the pip row) — hybrid OT detector handles RL
    matches that never set `Game.IsOT` (bot/private/freeplay) via clock-direction hysteresis.
  - KICKOFF state strip (gold) during pre-round countdown.
  - 3-2-1-GO! center-screen kickoff countdown with three delay regimes (first / fresh /
    post-goal) tuned against bot matches.
  - Final-10s upper-center gold pulsing seconds counter; suppressed during OT.
  Done.
- Stat-event pops (GOAL/AST/SAV/SHT/DMO) next to player tags on `StatfeedEvent`, with
  per-event-type dedup. Done.
- Control panel with live push, OBS-dock-friendly responsive layout. Done.
- System tray, close-to-tray (bridge keeps running), auto-start with Windows. Done.
- Replay collector with metadata sidecar. Done.
- RIVALRY branding (icon, wordmark, colors). Done.
- Mock mode for testing the whole thing without the game. Done.

---

## 7. Theming / customization quick reference

- Team colors, names, logos, tags, series, event title, and goal banner text are all set
  live in the control panel (no code change).
- Overlay visual style lives in the `<style>` block of `overlay/overlay.html` (CSS variables
  at the top: `--blue`, `--red`, `--panel`, `--gold`, etc.). Team accent colors are also
  driven by the control panel via CSS variables.
- The stinger uses `assets/rivalry-logo.svg`; swap that file to rebrand it.
- App/installer icon is `build/icon.ico`; tray icon is `assets/tray.png`.

---

## 8. Caveats and things to verify against a real match

This was developed and tested heavily in mock mode. The event names and high-level data
shapes are confirmed against Psyonix's API and a community client, but a few inner field
names were inferred and should be confirmed against a real spectated match. The cheapest way
to do that is to log the raw frames once (the bridge already frames every message; add a
`fs.appendFile` of each frame to a file, spectate a real match, then inspect).

1. Demos: `overlay/overlay.html` `onStatfeed()` looks for the demolition under a few likely
   field names (`Attacker.Name`, `Victim.Name`, `MainTarget.Name`). Confirm the real
   `StatfeedEvent` shape and tighten if needed.
2. Spectated player: `overlay/overlay.html` `getTargetName()` checks several likely
   locations (`data.Target`, `Game.Target`, `Spectated`, `Spectator.PlayerName`, etc.).
   This drives the stat feed bar and the radial boost gauge. Confirm the real field and
   simplify. If it is wrong, the stat bar/gauge may show the wrong or no player.
3. Overtime / clock: confirmed via live captures (v0.5.1 + v0.5.2) — `Game.IsOT` is never
   set in bot/private/freeplay matches (43k+ frames, zero hits). `onUpdateState()` now uses
   a hybrid detector: explicit `IsOT` fast path + a clock-direction hysteresis fallback
   (clockHitZero breadcrumb + N consecutive ascending frames). Threshold `OT_ASCEND_HYSTERESIS`
   is conservatively tuned at 3 frames against ONE bot OT capture. Re-tune against a real
   human OT match when one is captured. The OT kickoff timing regime has not been added
   for the same reason.
4. Boost is only present when the broadcast PC is spectating; render `--` when absent (the
   overlay already does this).
5. Installer is unsigned, so Windows SmartScreen warns on first manual install ("More info"
   then "Run anyway"). Silent auto-updates are not affected. Code signing can be added later.
6. Local `npm run dist` can fail on some Windows machines with a `winCodeSign` "cannot create
   symbolic link" error. Fix: enable Windows Developer Mode or run the build from an elevated
   PowerShell, and delete `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign` once. The CI
   workflow in the auto-update handoff avoids this entirely (clean runner has the privilege).

---

## 9. Roadmap / next steps

- Auto-update + CI: implement per `AUTO-UPDATE-HANDOFF.md` (electron-updater + GitHub
  Releases + a Windows build workflow on `DrunkCookies0/rivalry-broadcaster`). This is the
  recommended next task.
- Verify the inferred fields in section 8 against a real match and tighten the parsers.
- End-of-game results / podium screen driven by `MatchEnded` + `PodiumStart` (final score,
  series state, MVP). RLCS shows this between games.
- Replay upload to match pages: the collector already writes a metadata sidecar per replay;
  build the uploader that posts the `.replay` + metadata to the league's match pages.
- Optional custom stinger video: support dropping in a `.webm`/`.mov` stinger that overrides
  the built-in CSS wipe.
- Optional hybrid hosting: serve the overlay/control from a website so UI tweaks
  go live instantly without shipping an app update. Tradeoff: requires internet and a host.
- Lower-thirds / replay tag (player + goal speed) shown during the goal replay.

---

## 10. Repo setup checklist

1. Wipe and repurpose `https://github.com/DrunkCookies0/rivalry-broadcaster`.
2. Push the CONTENTS of the `rivalry-overlay` folder as the repo root (so `package.json` and
   `main.js` are at the top level).
3. Add a `.gitignore` (`node_modules/`, `dist/`, `*.log`).
4. Follow `AUTO-UPDATE-HANDOFF.md` to add auto-update and the release workflow.
5. First release: set `version` in `package.json`, push tag `v1.0.0`, let CI build and
   publish the installer.

---

## 11. v0.5.x current state (as of v0.5.3)

The 0.5.x line is a resilience + match-state polish series driven by live-capture audits
of bot matches. Highlights of what each patch did:

- **v0.5.0** — Goal experience polish (scoreboard GOAL flash, banner subtitle/badges, stat
  pops, replay card with assist + MPH, OVERTIME/KICKOFF state strips, 3-2-1-GO! countdown,
  final-10s big number, MatchEnded handler for golden-goal cleanup).
- **v0.5.1** — Goal speed unit fix (GoalSpeed is KPH, not UU/s — was displaying ~2 MPH);
  README feature list expanded.
- **v0.5.2** — Resilience patch from live-capture audit. Critical fixes:
  - Real RL replay event names (`ReplayPlayback*`, not the never-emitted `GoalReplay*`)
  - `GoalScored` 100ms per-scorer dedup that preserves `GoalSpeed`
  - `StatfeedEvent` Demolition 1000ms dedup
  - WS disconnect tears down the goal sequence
  - `clearGoalSequence` covers all timers (banner, exit, both flash pairs, deferred show)
    but deliberately leaves the stinger animation alone
  - `CountdownBegin` 500ms debounce
  - `hideReplayCard` scrubs `has-assist` + assister text
  - `resetMatch` wipes cross-match bleed state
  - Bridge mock + main.js OBS auto-switch updated to canonical RL event names.
- **v0.5.3** — OT detection hybrid (this patch). RL's `Game.IsOT` is never set in bot/
  private/freeplay matches, so OVERTIME state strip + clock `+` prefix + `.ot` class were
  unreachable in Alex's primary testing environment. Detector now uses explicit `IsOT`
  fast path + `clockHitZero` breadcrumb + N-frame ascend hysteresis. Final-10s counter
  gated on `!clockHitZero` so it stops the moment regulation ends; placeholder `OT` text
  during the limbo frame.

**Audit + analysis workflow** (lives in this session's transcript history):

- Capture stack documented in the `live-capture-workflow` memory: Playwright observer
  for JSONL event log + OBS MP4 recording, ffmpeg for frame extraction, alignment via
  anchoring on goal moments.
- ffmpeg installed at `C:\Users\Cookies\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_*\
  ffmpeg-8.1.1-full_build\bin\` (not on PATH; reference by full path).
- The audit found 14+ resilience issues across two live captures. Ship-ready fixes landed
  in v0.5.2 + v0.5.3; bridge synthesis improvements (deduping at the relay layer, synthetic
  OvertimeBegin / GoalReplayEnd) are held for v0.6.0+ pending overlay-side stability.

**Held for v0.5.4+ (needs more capture data):**

- Kickoff lead-in re-tuning vs human matches (current values tuned against bots; see the
  `kickoff-timing-bot-vs-human` memory for diagnostic shortcut and constant references).
- OT-specific kickoff regime — no real human OT data yet, would violate `dont-call-guesses-fixes`.
- Bridge-level dedup + synthesis for double-fire goals, demolitions, and `OvertimeBegin`.

**Memories that are load-bearing for this work:**

- `ot-detection-hybrid` — hybrid OT detector design, hysteresis tuning notes
- `rl-event-quirks` — canonical event names, double-fire patterns, empty-scorer phantoms
- `live-capture-workflow` — capture stack, ffmpeg recipes, alignment procedure
- `kickoff-timing-bot-vs-human` — kickoff delay constants, bot-vs-human caveat
- `dont-call-guesses-fixes` — don't ship timer-value tweaks without verification
- `overlay-baby-steps` — small focused patches over big refactors

If you're picking this up in a fresh session, read those memories first.
