# RIVALRY Casterverse, Producer Setup Guide

This is your copy of the broadcast software for the RIVALRY main stream. Follow this document top to bottom the first time. After that, match night is just "Your first broadcast" below.

If anything in here does not go the way the document says it will, stop and call Alex. Do not fight it alone.

---

## What you received

You should have three things:

- [ ] The installer: `RIVALRY-Casterverse-Setup-<version>.exe` (or the Beta variant, which installs side by side with the regular one)
- [ ] Your personal access key. It starts with `RCV1.` and was issued to you by name. Treat it like a password.
- [ ] This document.

You will also need a **league API key** (starts with `rv_`) before your first broadcast. It comes from the league site and is a different key from your access key. More on that below.

**The two keys, side by side, because mixing them up is the most common mistake:**

| Key | Starts with | What it does | Where it goes |
|---|---|---|---|
| Casterverse access key | `RCV1.` | Unlocks the app itself | The activation screen, once, right after install |
| League API key | `rv_` | Lets Match mode read the league schedule | The "Find your match" card in the control panel |

They look nothing alike, and the app will tell you if you paste one into the other's box.

---

## Install

1. Double-click the installer.
   **Expected result:** Windows shows a blue screen that says **"Windows protected your PC"**. This is normal. The installer is not code-signed yet, so Windows warns about it. It is expected and safe.
2. On that blue screen, click **More info**, then click **Run anyway**.
   **Expected result:** the installer runs. There is no wizard to click through and no admin password prompt.
3. Wait a few seconds.
   **Expected result:** the app opens on its own, and a RIVALRY icon appears in your system tray (bottom-right corner of the taskbar, you may need to click the little up arrow to see it).

The app lives in that tray icon. Closing its window does not quit it; the tray menu has **Quit** when you really want it gone.

---

## Activate

1. The first thing the app shows is a screen titled **"Enter your access key"**.
   **Expected result:** one text box and an **ACTIVATE** button. Nothing else is available yet, and that is on purpose. Until you activate, every overlay page shows an activation notice instead of scenes.
2. Paste your access key (the one starting with `RCV1.`) into the box and click **ACTIVATE**.
   **Expected result:** a green message saying **"Activated for"** followed by your name, and the setup wizard appears. You will never see the activation screen again on this machine.

If the key is refused, read the message it gives you, then call Alex. Do not retype the key by hand; copy and paste it.

---

## The wizard

The wizard has 3 steps and takes about two minutes. You can reopen it any time from the tray icon (**Setup guide**).

### Step 1: Rocket League

The app writes Rocket League's stats config file for you. No mods, no plugins, it uses the game's official broadcast output.

1. Look at the status box on this step.
   - If it says the config was written and shows **RESTART ROCKET LEAGUE**: Rocket League was running when the config was written, so quit RL fully (all the way out, not just to the menu) and launch it again. The wizard updates on its own.
   - If it says **"Rocket League folder not found"**: launch Rocket League once, quit it, then click **Retry**.
2. Wait for the status to settle.
   **Expected result:** a green **"Rocket League feed is live"** state (or green "Connected to Rocket League" if you are not in a match yet, which is fine). Click **NEXT: OBS**.

### Step 2: OBS

1. Click the one big button: **SET UP OBS FOR ME**.
   **Expected result:** a five-item checklist ticks itself green: find OBS, switch on its connection, start OBS, connect, build the scenes. There is no password to find or type, ever. When it finishes, OBS has a scene collection called **RIVALRY Casterverse** with every scene pre-wired, including the persistent chrome frame layered over each scene and the game capture already scaled to fit inside the chrome's interior window.
2. If the automatic setup fails (it will say so on the checklist), use the fallback inside the same wizard step: open **"Do it manually instead"**, click **DOWNLOAD SCENE COLLECTION**, then in OBS use the **Scene Collection** menu, click **Import**, pick the downloaded file, and switch to **RIVALRY Casterverse** from the same menu.
   **Expected result:** the same collection, same scenes, arrives pre-wired.
3. Click **NEXT: CONTROL PANEL**.

Your other OBS scene collections are left alone either way.

### Step 3: Control panel

This is where you run the show. Two ways to open it; the dock is the recommended one and is covered in the next section.

1. Follow the "Add the control panel dock" section below (the wizard shows the same address with a Copy button).
2. Click **FINISH SETUP**.
   **Expected result:** the wizard closes and the control panel opens.

---

## Add the control panel dock

The control panel docks inside OBS so match night is one window.

1. In OBS, open the **Docks** menu (top menu bar, under **View** on some versions, or directly in the menu bar).
2. Click **Custom Browser Docks**.
3. In a new row, type a name (**RIVALRY**) and paste this address:

   ```
   http://localhost:49080/
   ```

4. Click **Apply**.
   **Expected result:** the control panel appears as a panel inside OBS. Drag it wherever you like; OBS remembers.

Also works: open that same address in any browser tab, handy for a second monitor.

---

## Your first broadcast

The control panel is laid out top to bottom in the order you use it on a match night. Here is the whole run of show.

### Before the stream

1. Make sure the toggle at the top is on **Match (league)**. It is the default.
2. In the **Find your match** card, paste your league API key (starts with `rv_`) and click **Save key**. You only do this once, it is remembered.
   **Expected result:** the status reads **"Key OK"** followed by the masked key.
3. Click **Find matches** (optionally type a team name first to narrow it).
   **Expected result:** tonight's real schedule appears, with circuit and "when" filter chips you can click to narrow the list.
4. In the **Broadcast schedule** card, fill in **Season**, **Circuit**, and **Tier** once for the night.
5. For each series on tonight's slate, in schedule order: find it in the match list and click **Add to queue** (or **Use now** for the one starting first).
   **Expected result:** the Broadcast schedule card lists the night's series in order, and **Up Next** fills itself from the schedule.
6. Click **Load next series** to put series 1 on deck.
   **Expected result:** the Team A and Team B cards fill with names, logos, and records; the series score resets to 0-0.
7. Set **Best of** and the seeds by hand. The league data does not carry those, so they are always typed.
8. Everything the league filled in stays hand-editable. Fix anything that looks off, then click **PUSH TO OVERLAY**.
9. In the **Casters** card: set the VDO.Ninja room name, click **Generate caster links**, and send each caster their personal link. Their cams appear on the Casters scene, no accounts or installs on their end.

### During the stream

Use the scene deck buttons in the **OBS integration** card (or click scenes in OBS directly, same thing). A typical night:

1. **Starting Soon** while you wait for the hour.
2. **Casters** for the desk open.
3. **Match Preview** for the head-to-head graphic.
4. **Live** for the games. The scorebug, clock, boost, goal banners, replay cards, and kickoff countdown all run themselves off the game feed.
5. **Post-Game** after each series; the box score freezes itself the moment the match ends.
6. **Up Next** to tease what follows.
7. Click **Load next series** in the Broadcast schedule card. The whole broadcast advances: teams, score reset, Up Next, all of it.
8. Repeat from **Match Preview** (or **Casters**) for each series.
9. **BRB** whenever you need a break.

Replays are collected for you automatically into `Documents\RIVALRY Replays`, organized by event and matchup. Nothing to click.

One more thing that runs itself: the app checks for updates every 30 minutes and installs them when you quit, never mid-broadcast. The tray icon shows update status.

---

## If the league site goes down mid-show

Manual mode is the escape hatch. Everything in the app works identically in Manual mode; the only thing you lose is auto-fill.

1. At the top of the control panel, click **Manual** on the mode toggle.
   **Expected result:** the "Find your match" card disappears. Nothing on air changes.
2. Type the team names into the Team A and Team B cards yourself.
3. For logos: paste an image URL, or click **Upload** and pick a file, or drag a file onto the card.
4. Fill in seeds, records, and best-of by hand.
5. Click **PUSH TO OVERLAY**.
   **Expected result:** every scene updates, exactly as it would in Match mode.
6. Keep running the show. The scene deck, goal graphics, post-game box score, and series score all work the same.
7. When the league site is back, flip the toggle back to **Match (league)** whenever you like.

---

## When something breaks

Do not describe the problem from memory. Export the diagnostics file and send it; it says more than any description can.

1. Right-click the tray icon (or use the control panel) and click **Export diagnostics**.
   **Expected result:** it saves a file called `casterverse-diagnostics.json`. It contains no secrets; your league key is masked.
2. Send that file to Alex, along with one sentence about what you were doing when it broke.
3. Call Alex.

Other things worth knowing:

- The app also keeps a running log at `%APPDATA%\RIVALRY Casterverse\logs\casterverse.log` if Alex asks for it.
- If a dialog appears at launch saying a port is already in use, it names the program holding the port. Close that program and relaunch. The app only uses three local ports (49080, 49124, 49777) and they never leave your machine.
- If an overlay looks blank in OBS: check the tray icon is there (app running), check Rocket League was restarted once after install, then right-click the browser source in OBS and refresh it.

---

## FAQ

**Do I need to install anything else?**
No. The installer, OBS, and Rocket League are the whole list. No runtimes, no plugins, no mods, nothing from the command line.

**Does this touch the game? Will it get me banned?**
No. It reads Rocket League's official Stats API, the broadcast interface Psyonix ships in the game. Nothing is injected, nothing is modified, it is EAC-safe. Private matches work.

**What if my OBS is already set up for other stuff?**
Fine. The RIVALRY Casterverse scene collection is its own separate collection. Your existing collections, scenes, and settings are untouched, and you can switch between collections from OBS's Scene Collection menu.

**What if Rocket League updates?**
Nothing to do. The app reads a stable official interface, not game files.

**Can I close the control panel mid-show?**
Yes. It is just a view. Everything you typed is saved by the app and survives closing the panel, restarting OBS, and restarting the app itself.
