# Producer Install Checklist

This is the checklist the producer runs on their own machine the first time they install RIVALRY Casterverse. It proves the whole chain works on a machine DrunkCookies has never touched, before the first real broadcast depends on it.

- Who runs it: the producer, alone, on their own Windows machine.
- What it needs: the installer, your league API key, OBS, and Rocket League. Nothing else. No repo, no npm, no developer tools.
- How long: well under an hour, including one exhibition match.
- If any step's "Expected" does not happen and the "If not" line does not fix it: run the Export diagnostics step at the bottom, send the file to DrunkCookies, and stop there. Nothing later in the list will go better than the step that just failed.

Keep PRODUCER-SETUP.md open next to this; it explains each screen in more detail. This file is just the script.

---

## Before you start (DrunkCookies side)

Done by DrunkCookies on the dev machine before anything ships to the producer:

- [ ] Send the producer: the installer, their league API key (starts with `rv_`), PRODUCER-SETUP.md, and this checklist.

Everything below is the producer's script.

---

## The checklist

Work top to bottom. Tick each box only when the "Expected" line actually happened.

### 1. Install

- [ ] Double-click `RIVALRY-Casterverse-Setup-<version>.exe`. Windows shows a blue **"Windows protected your PC"** screen. Click **More info**, then **Run anyway**. This warning is expected and safe (the installer is unsigned).

  **Expected:** the installer runs with no further prompts, and the app opens on its own with a RIVALRY icon in the system tray.

  **If not:** if the blue screen has no "More info" link, or the app never opens, take a photo of the screen and call DrunkCookies.

### 2. First launch

- [ ] The app opens straight onto the 3-step setup wizard (no activation screen: access keys were retired in favor of the league key and match gate).

  **If not:** if anything else appears first, take a screenshot and call DrunkCookies.

### 3. Wizard step 1: Rocket League

- [ ] Look at the status box on the Rocket League step.
  - If it shows **RESTART ROCKET LEAGUE**: quit Rocket League completely (all the way out of the game, not just to the main menu) and launch it again. The wizard notices on its own.
  - If it says **"Rocket League folder not found"**: launch Rocket League once, quit it, then click **Retry**.

  **Expected:** the step turns green ("Rocket League feed is live", or "Connected to Rocket League" if you are not in a match, both count).

  **If not:** click **Retry** once more with Rocket League fully closed. Still not green: Export diagnostics (step 14) and send to DrunkCookies.

### 4. Wizard step 2: OBS

- [ ] Make sure OBS is installed, then click **SET UP OBS FOR ME**. Type no passwords; it never asks for one.

  **Expected:** the five checklist items tick green one by one (find OBS, switch on its connection, start OBS, connect, build the scenes). OBS ends up with a scene collection named **RIVALRY Casterverse** containing every scene, each with the chrome frame layered on top and the game capture already scaled inside the chrome's interior window.

  **If not:** the checklist names the item that failed. Click **SET UP OBS FOR ME** once more (a freshly started OBS sometimes needs a second try, especially if it opened a "Crash Detected" dialog you had to answer). Still failing: open **"Do it manually instead"** in the same wizard step, click **DOWNLOAD SCENE COLLECTION**, then in OBS: **Scene Collection** menu, **Import**, pick the downloaded file, switch to **RIVALRY Casterverse**. If the imported collection is missing scenes or the chrome, Export diagnostics and send to DrunkCookies.

### 5. Control panel dock

- [ ] In OBS: **View** menu, **Docks**, **Custom Browser Docks**. Add a row named **RIVALRY** with the address `http://localhost:49080/` and click **Apply**. Then click **FINISH SETUP** in the wizard.

  **Expected:** the control panel appears inside OBS as a dock, with the **Load your match** card at the top and the team cards below.

  **If not:** open `http://localhost:49080/` in a normal browser tab instead. If it loads there but not in the dock, re-check the address in the dock row for typos. If it loads nowhere, the app is not running (no tray icon): start it and retry.

### 6. League key and find matches

- [ ] In the control panel, open the **Setup** tab and, in the **League API key** card, paste your league API key (starts with `rv_`) and click **Save key**. Then switch back to the **Show** tab and click **Find matches** in the **Load your match** card.

  **Expected:** status reads **"Key OK"** plus a masked key, and the real league schedule appears with circuit and "when" filter chips.

  **If not:** the status line tells you what is wrong. What each message means:
  - **"That's an old Casterverse access key (retired — no longer needed)..."** You pasted a retired `RCV1.` key. Paste the `rv_` league key instead.
  - **"No key saved. Paste your league API key above."** The save did not take. Paste the key and click **Save key** again.
  - **"Key rejected by the league site. Check it and save again."** The `rv_` key itself is wrong. Re-copy it from where DrunkCookies sent it, save again. Still rejected: call DrunkCookies, the key may need reissuing.
  - **"Can't reach the league site. Check your internet connection."** Your machine is offline or the league site is down. Check that a normal website loads. If the internet is fine, the league site is the problem: call DrunkCookies. A match that was already loaded keeps broadcasting from cache; only loading a new one needs the site back.
  - **"No matches found."** The key works but the search returned nothing. Try clicking **Find matches** with an empty search box, or the **All** chip. A between-seasons schedule can genuinely be empty; confirm with DrunkCookies what you should be seeing.

### 7. Build a 2-series schedule

- [ ] In the **Broadcast schedule** card, fill Season, Circuit, and Tier. Then, from the match list, click **Add to queue** on two different matches.

  **Expected:** both series appear in the Broadcast schedule card in order, and the **Up Next** card fills itself from the schedule.

  **If not:** if Add to queue does nothing, refresh the dock (right-click the dock, reload, or restart OBS) and try again. Still nothing: Export diagnostics and send to DrunkCookies.

### 8. Load series 1

- [ ] Click **Load next series**.

  **Expected:** the Team A and Team B cards fill with the first series' names, logos, and records, the series score resets to 0-0, and the change shows up everywhere: switch OBS to **RIVALRY - Starting Soon** and to **RIVALRY - Match Preview** and both show the loaded teams.

  **If not:** click **PUSH TO OVERLAY** and re-check the scenes. If a scene still shows old or blank teams, right-click that scene's browser source in OBS and refresh it. Still wrong: Export diagnostics and send to DrunkCookies.

### 9. Play one match

- [ ] Set **Best of** and seeds by hand (the league does not send those). Switch OBS to the **Live** scene. Start an exhibition or private match in Rocket League (playing or spectating, either works) and watch the overlay through at least one goal.

  **Expected:** at kickoff, a kickoff countdown appears on the overlay. When a goal is scored: GOAL flashes over the scorebug, the goal banner shows the scorer, the replay gets a green frame and a replay card, and the stinger covers the cut back to live. The scorebug score and clock track the game the whole way.

  **If not:** if the overlay shows nothing at all during the match, wizard step 1 probably never went green: tray icon, **Setup guide**, re-check step 1 (Rocket League must have been restarted once after install). If the scorebug works but a goal graphic misbehaves, note exactly what you saw (or clip it) and send it to DrunkCookies with the diagnostics file. Boost meters showing `--` for players is normal unless you are the one spectating.

### 10. Post-game stats

- [ ] Finish the match (play it out or forfeit). Switch OBS to the **Post-Game** scene.

  **Expected:** the stats are there, frozen from the moment the match ended: the final score, the team totals and the player of the game.

  **If not:** if the scene is blank or shows a stale match, refresh the scene's browser source. Still wrong: Export diagnostics and send to DrunkCookies, noting how the match ended (played out vs forfeit).

### 11. Add the game to the series

- [ ] On the control panel's **Show** tab, find the **Game results** card. Click **Add to series**. Then switch OBS to **RIVALRY - Series Update**.

  **Expected:** the card had already noticed the match end on its own and was asking "Game 1 just ended: ... Add it to the series?" with the right winner and score. After **Add to series**, the series score shows 1-0 to the winner, and the Series Update scene lists Game 1 with its score and the series MVP so far.

  **If not:** if the card never asked, note how the match ended (played out vs forfeit) and add the game by hand under **Add a game by hand** so the rest of the checklist can go on. Send that note with the diagnostics file at the end: the app is meant to catch every finished game by itself.

### 12. Advance to series 2

- [ ] Click **Load next series** again.

  **Expected:** the team cards flip to the second series' teams, the series score resets to 0-0, the Game results list empties, and Up Next updates.

  **If not:** same recovery as step 8: PUSH TO OVERLAY, refresh the affected browser source, then diagnostics if still wrong.

### 13. Restart the app

- [ ] Right-click the tray icon, **Quit**. Confirm the tray icon is gone, then start RIVALRY Casterverse again from the Start menu.

  **Expected:** the app comes back with no wizard, and everything is exactly as you left it: the schedule, both series, which series was on air, team names, logos, casters, all of it. The overlays in OBS reconnect on their own.

  **If not:** if the wizard reappears, or any typed value is gone, that is exactly the kind of bug this checklist exists to catch. Export diagnostics and send to DrunkCookies before touching anything else.

### 14. Export diagnostics

- [ ] Right-click the tray icon and click **Export diagnostics** (it is also in the control panel).

  **Expected:** a file named `casterverse-diagnostics.json` is saved. It contains no secrets; the league key inside is masked.

  **If not:** if the export itself fails, grab the log file at `%APPDATA%\RIVALRY Casterverse\logs\casterverse.log` and send that to DrunkCookies instead, along with a note that the export failed.

Send the diagnostics file to DrunkCookies even on a clean pass, with a one-line "all green". It gives him a baseline snapshot of your machine.

---

## Result log

| Date | Machine | Build | Result | Notes |
|---|---|---|---|---|
| | | | | |
| | | | | |
| | | | | |
