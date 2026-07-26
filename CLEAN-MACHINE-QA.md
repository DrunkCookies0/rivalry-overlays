# Clean-Machine QA Checklist

Cold-start QA for the installer. Run this on a machine (or sandbox) that has **never** seen the app, before every release candidate. The point is to catch everything a first-time producer would hit that a dev machine hides.

---

## Prep

Pick one environment:

**Option A: Windows Sandbox (fastest, resets on close)**

1. Enable it: Start, "Turn Windows features on or off", check **Windows Sandbox**, reboot.
2. Launch Windows Sandbox.
3. Drag the beta installer (`RIVALRY-Casterverse-Beta-Setup-*.exe`) into the sandbox window.
4. Install OBS inside the sandbox (download from obsproject.com, needs OBS 30+).
5. Note: Rocket League cannot realistically run in the sandbox, so RL-dependent steps are skipped there. Do a full pass on Option B before shipping.

**Option B: spare PC or VM with a GPU**

1. Fresh Windows user profile that has never run the app.
2. OBS 30+ installed.
3. Rocket League installed (required for the full pass).

**Which steps need Rocket League?** Wizard step 1 going green, the gameplay-feed check, and the post-game latch. Everything else (install, OBS import, control panel, persistence, logo upload, league degrade, update check, quit/relaunch) works without RL. Steps that need RL are marked **[RL]** below.

---

## The five-minute drill (run this one first)

The whole point of the product: hand someone the installer, they are streaming in
five minutes. Time it with a stopwatch, on a profile that has never run the app.
If a step needs explaining out loud, that step is the bug.

Before starting, from the repo: `npm run key:issue -- --name "Drill"` and keep
the key on the clipboard. You also need a league API key.

| # | Do this | Expect | Time |
|---|---------|--------|------|
| 1 | Run `RIVALRY-Casterverse-Setup-<version>.exe` | Installs with no wizard, no UAC, app opens on its own | |
| 2 | The window is on **Enter your access key** | Wizard is gated — no scene list, no steps visible yet | |
| 3 | Paste the key, click **ACTIVATE** | "Activated for Drill", wizard appears | |
| 4 | Step 1, Rocket League **[RL]** | Green once RL has been launched once and restarted | |
| 5 | Step 2, click **SET UP OBS FOR ME** | 5 ticks go green; OBS starts if closed; 7 scenes built. **No password is ever requested** | |
| 6 | Step 3, copy the dock URL into OBS (Docks, Custom Browser Docks) | Control panel appears inside OBS | |
| 7 | Click **FINISH SETUP** | Lands on the control panel | |
| 8 | Switch to **Match (league)**, paste the league API key, **Save key** | "Key OK ••••xxxx" | |
| 9 | Click **Find matches** | Real matches, circuit chips, records | |
| 10 | Click **Use now** on one | Team names, logos, records and rosters fill in | |
| 11 | In OBS, switch to **RIVALRY - Starting Soon** | Both teams, their logos and records, on air | |

**Stop the clock at step 11.** Anything past five minutes is a finding, not a
pass.

### Things that have actually gone wrong here

- **Stale copies of the app running.** The single-instance lock means a second
  launch quietly hands off to the one already running, so you can test a build
  that isn't the one you just made. Check with
  `tasklist /FI "IMAGENAME eq RIVALRY Casterverse.exe"` and kill all of them
  before a run.
- **Not a real first run.** Delete `%AppData%\RIVALRY Casterverse\` (or at least
  `license.json`, `league-settings.json`, `obs-settings.json`,
  `control-state.json`, `.setup-complete`) or the wizard is skipped and the
  activation gate never shows.
- **OBS stuck behind a dialog.** After an unclean shutdown OBS opens a "Crash
  Detected" prompt and never opens its websocket, so step 5 times out. Answer
  the dialog and retry — the app deliberately doesn't clear OBS's crash marker.
- **Placeholder text on air.** Blank fields must render blank. If a scene shows
  "NA", "12-3" or any other sample value that the panel doesn't contain, that is
  a bug (see `rivalry-bind.js`).

### Access keys

| Check | Expect |
|---|---|
| Launch with no key entered | Every overlay URL serves an "activation required" card, not a black frame |
| Enter a nonsense key | Refused with a readable reason, nothing stored |
| `npm run key:revoke -- --name "Drill"`, push, relaunch the app | Overlays go back to the activation card, naming who the key belonged to |
| `npm run key:revoke -- --name "Drill" --undo`, push, relaunch | Works again |
| Pull the network cable, relaunch | Still works — the revocation check fails open by design |

---

## Checklist

### Install

- [ ] SmartScreen warning appears on running the installer (expected, unsigned).
- [ ] "More info" then "Run anyway" proceeds without further blocks.
- [ ] Installer completes per-user (no admin/UAC elevation prompt).
- [ ] App launches after install; no freeze, no error dialog.
- [ ] Tray icon is present and its menu opens.

### Setup wizard

- [ ] Wizard opens automatically on first launch.
- [ ] Step 1, RL never launched on this machine: shows the "Rocket League folder not found" state (not a crash or blank).
- [ ] **[RL]** Launch Rocket League once, close it, retry in the wizard: the folder is found and the config file is written.
- [ ] **[RL]** Wizard shows the live "waiting for Rocket League" state.
- [ ] **[RL]** Restart Rocket League: the step goes green on its own.
- [ ] Step 2: scene collection download works from the wizard.
- [ ] Step 3: control panel URL shown; wizard can be completed.
- [ ] Tray icon, "Setup guide" reopens the wizard after completion.

### OBS import

- [ ] OBS: Scene Collection menu, Import, pick the downloaded file: import succeeds.
- [ ] All 7 scenes are present, in broadcast order: Starting Soon, Casters, Match Preview, Gameplay (Live), Post-Game Results, Up Next, Be Right Back.
- [ ] Each scene has its browser source, pointed at `http://localhost:49080/overlays/...`, 1920x1080.
- [ ] Presentation scenes (Starting Soon, BRB) render, not blank.
- [ ] **[RL]** Start a match or freeplay and spectate/play: the Gameplay scene shows live data. There is no mock on a clean machine (no npm), so this check needs real RL. Note: the gameplay scene shows live data only during a match; blank outside one is correct.

### Control panel dock

- [ ] OBS: Docks, Custom Browser Docks, add `http://localhost:49080/`: the panel loads in the dock.
- [ ] Type team names, push: a presentation scene (Starting Soon or Match Preview) updates live.
- [ ] Refresh the scene's browser source: the typed values are still shown (not reset to defaults).
- [ ] Quit the app from the tray, relaunch it: every value typed in the panel is still there.

### Logos

- [ ] Upload a logo file via the picker: it renders on a scene after push.
- [ ] Drag-drop a logo file onto the panel: same result.
- [ ] Paste a direct image URL: it renders after push.

### League Match mode

- [ ] Switch the Scenes card toggle to Match with no API key entered: clean degrade (an "enter your API key" or "not live yet" style message), no error dialog, no console spam.
- [ ] Switch back to Manual: everything still works.

### App health

- [ ] Tray auto-update row shows a sane status (up to date, or checking), not an error.
- [ ] If possible: start another process on port 49080 and relaunch the app; the port-conflict dialog appears and names the port. (Optional, skip if awkward to stage.)
- [ ] Quit from the tray: process fully exits (check Task Manager, no stray RIVALRY process).
- [ ] Relaunch: app comes up clean, wizard does NOT reopen, panel values persist.

---

## Result log

| Date | Build version | Machine | Pass/fail | Notes |
|---|---|---|---|---|
| | | | | |
| | | | | |
| | | | | |
