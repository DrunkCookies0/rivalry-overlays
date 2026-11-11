# RIVALRY Casterverse, Design Spec

The look of every broadcast scene: The Rivalry brand (Emerald, v1) as the app draws it. For designers making assets, for Broadcast approving scenes, and for anyone changing a scene.

All sizes are canvas pixels on the **1920 x 1080** OBS canvas unless a section says otherwise. Screenshots of every scene are in the [README](README.md#the-scenes).

---

## The brand

Everything below comes from one file, [`assets/brand/rivalry-brand.css`](assets/brand/rivalry-brand.css). Change a token there and every scene follows. Fonts are self-hosted, so nothing loads from the internet at show time.

### Color

| Token | Hex | Used for |
|---|---|---|
| `--rv-coal` | `#17191F` | Backgrounds, scorebug and card fills |
| `--rv-slate` | `#343B49` | 1px rules, empty series boxes and boost segments |
| `--rv-chalk` | `#F0EDE5` | Text, solid slabs (the clock, the GOAL block) |
| `--rv-emerald` | `#20B878` | The accent: tags, the ticker's live tag, outlined headline words, the replay frame |
| `--rv-coal-raised` | `#1F2229` | Raised rows and sub-bars (UI only) |
| `--rv-chalk-dim` | `#A9A79F` | Labels and secondary text (UI only) |
| `--rv-emerald-tint` | `#1B3329` | Highlighted rows, such as the teams on air in Standings (UI only) |
| `--rv-team-blue` | `#2D8CFF` | Team A (Blue). Thin stripes and boost fills only |
| `--rv-team-orange` | `#FF8A1F` | Team B (Orange). Thin stripes and boost fills only |

Team colors never fill a panel; a team shows as a 4 to 10px stripe, its series boxes and its boost fill. Status colors (a red for errors, a green for OK) are still an open brand item.

### Type

| Font | Role | Files |
|---|---|---|
| Barlow Condensed, 700, uppercase | Headlines and team names | `assets/fonts/barlow-condensed-*.ttf` |
| Inter | Body text and player names | `assets/fonts/inter-variable.ttf` |
| Space Mono | Scores, the clock, stats and small labels | `assets/fonts/space-mono-*.ttf` |

All three are OFL-licensed; the licenses sit next to the files in `assets/fonts/`.

### Shape

- Square corners everywhere (`--rv-radius: 0`).
- Panels are Coal on a 1px Slate line. No drop shadows, no gradients.
- Headlines pair a solid Chalk word with an outlined Emerald word that ends in a full stop: "STARTING **SOON.**", "UP **NEXT.**", "LOW ORBIT **WIN.**".

### Logo files

| File | Used for |
|---|---|
| `assets/brand/lockup-horizontal-emerald-on-dark.svg` | "THE RIVALRY gg" lockup at the top left of every full-screen scene, the control panel and the setup wizard |
| `assets/brand/logo-emerald-on-dark.svg` | The symbol: the chrome's left rail, and the stand-in on a team tile when the league has no logo for that team |
| `assets/brand/logo-mono-chalk.svg` | One-color Chalk symbol |
| `assets/brand/avatar-dark.svg` | Source art for the app icon and tray icon (`tools/build-icons.js` rasterizes it) |

`assets/rivalry-logo.svg` and `assets/rivalry-wordmark.svg` are from before the rebrand. No scene draws them.

### Team tiles

Every team appears as a square tile: the league logo when the loaded match has one, otherwise the brand symbol on Coal. The logo comes through the app's local logo proxy, because the league's own logo URLs expire after about 15 minutes.

---

## The canvas and the chrome

The **chrome** is one browser source that OBS layers on top of every scene, so the frame never moves when the producer switches scenes.

| Part | Size and place | Holds |
|---|---|---|
| Left rail | 64px wide, full height | The league: the brand symbol at the top, the event line (season, circuit, tier) running up the rail |
| Right rail | 64px wide, full height | Up to 5 social icons and "Follow @handle" running down the rail. Its bottom is kept free for sponsors pushed by the league |
| Ticker | 72px tall, full width, at the bottom | An Emerald tag naming the current item, the items separated by square markers, the stream line at the right |
| Lower third | Centered above the ticker | Producer-called, Chalk and Emerald |
| Window | **1792 x 1008 at (64, 0)**, exactly 16:9 | The game capture, scaled to fit with no letterboxing |

Rail rule: **left is the league, right is socials and sponsor.**

Full-screen scenes paint the whole canvas and the chrome sits on top, so their content keeps clear of the rails and the ticker: 64px on each side and 72px at the bottom.

---

## The scenes

| Scene | What it shows |
|---|---|
| Starting Soon | "STARTING SOON." with a countdown to the first kickoff, and an Up Next card with tonight's first series and the casters |
| Casters | One frame per cam with the caster's name and role on a plate below it. The frames are holes; the app places each VDO.Ninja cam behind its hole in OBS |
| Match Preview | The two teams side by side: tiles, names, records, seeds, sides and rosters |
| Gameplay | The live overlay inside the window (next section) |
| Post-Game | "TEAM WIN." with the final team totals bar by bar and the player of the game, frozen at the match end |
| Series Update | Between games: the big series score, each team's series boxes, every finished game, the next game, who's on the call and the series MVP so far |
| Up Next | The next series on the schedule, with times |
| Be Right Back | "BE RIGHT BACK." with the series score card |
| Standings | The league table. Built but switched off until the league publishes standings |

---

## Gameplay

Everything here sits inside the window. Coordinates in this section are measured from the window's top-left corner, in canvas pixels.

### Always on during a match

| Element | Place and size | Detail |
|---|---|---|
| Scorebug | Top center, 22px down, 940 x 66 | Team blocks with a 6px team stripe, a 42px tile and the name (Barlow 32). Scores in Space Mono 44. The clock is a 160px Chalk slab, Space Mono 38; in overtime it counts up with a `+` in front |
| Info row | Under the scorebug, 30px tall | The game label ("GAME 4 · BEST OF 5"), the series boxes (one 32 x 14 box per possible game, each team filling from its own side) and the event title |
| State tab | Under the clock, 160 x 30 | KICKOFF (outlined) or OVERTIME (solid Emerald) |
| Player boards | Top corners, 22px down, 340 wide | A header with the team name, then one 44px row per player: name (Inter 600, 17), boost bar, boost number. The spectated player's row is lit and tagged CAM |
| Spectated player card | Bottom left, 28px in, 640 wide | The player's tile and name (Barlow 40), then score, goals, assists, saves, shots and demos. Shows while RL is spectating a player |
| Boost block | Bottom right, 28px in, 300 wide | The spectated player's boost as a big number (Space Mono 62) over 10 segments |

Boost only exists on the PC that is spectating; everywhere else the boost slots read `--`.

### Moments

| Element | Place | Detail |
|---|---|---|
| Stat pops | In the player's board row | On a save, shot, demo, assist and the like, the word replaces that row's bar and number for 2 seconds. A goal holds its row for the whole goal sequence |
| Kickoff countdown | Center | 3, 2, 1 in Space Mono 220, then GO in Barlow 250, held 1.3 seconds. Mirrors RL's own countdown so it still works with the in-game HUD hidden |
| Final 10 | Under the scorebug | The last 10 seconds of regulation as a big ticking Chalk number (Space Mono 160). Hidden in overtime |
| GOAL flash | Over the scoring team's scorebug block | A Chalk slab reading GOAL wipes in from the score side and out the far side |
| Goal banner | Center, 330px down | A solid Chalk GOAL block (Barlow 170) with the scoring team's stripe, then the scorer's card: tile, name (Barlow 72), their title from therivalry.gg, and a line with the assist, the shot speed (MPH in NA, KPH elsewhere) and the new score |
| Replay | Whole window | A 6px Emerald frame and a REPLAY tag at the top left, then a replay card at the bottom center: scorer, assist, speed and the score |
| Stinger | Whole canvas | Covers the cut from the replay back to live (see below) |

### The goal sequence, in order

| When | What happens |
|---|---|
| 0 s | RL sends GoalScored. The scorer's board row turns to GOAL and holds |
| 0.75 s | The GOAL flash and the goal banner wipe in |
| up to 3.75 s | The banner wipes out after 3 seconds, or as soon as the replay starts |
| Replay starts | The replay frame and tag come on |
| 4.35 s | The replay card shows |
| 2.5 s after RL's "replay will end" | The stinger fires and covers the cut back to live. If that signal never comes, the replay's end fires it; with no replay events at all (bot and private matches), it fires 13.75 seconds after the goal |
| Kickoff | Everything from the goal clears and the kickoff countdown runs |

Kickoff countdown delays, from RL's CountdownBegin: 750 ms for the first kickoff, 900 ms after a goal, 4750 ms after an admin pause, 1800 ms for the overtime kickoff. The first two still need checking against a captured human match.

---

## The stinger

One stinger, shared: `.rv-sting` in `rivalry-brand.css`. The chrome plays it on a scene switch from the panel's scene deck; gameplay plays it on the cut from a replay back to live.

| | |
|---|---|
| Motion | Two panels skewed at -14 degrees close in from the left and the right. The left panel has a Chalk edge, the right a 4px Emerald outline edge, and the two halves of the symbol meet in the middle |
| Length | 900 ms, keyframes at 0, 44%, 62% and 100% |
| Full cover | 396 ms to 558 ms: the whole canvas is hidden |
| Scene switch | The app cuts the OBS scene at 450 ms, inside the cover, and accepts the next switch after 900 ms |

A cut must always land inside the cover window. Changing the stinger's keyframes means re-checking both of those cuts.

---

## Optional: an OBS goal scene

The panel can auto-switch OBS on game events (Setup tab, OBS integration, "Advanced: auto-switch on game events"). One of those triggers is a **Goal scene**: at goal time OBS cuts to a scene with no game capture, so RL's in-game "X SCORED" text never reaches the stream. The overlay's banner and stinger still play on top of it.

What a designer would deliver for it: a 1920 x 1080 still or a video loop for the scene's background.

---

## Changing a scene

- **Colors and fonts:** edit the tokens in `assets/brand/rivalry-brand.css`.
- **A scene's layout:** each scene is one folder in `overlays/`, with its own `index.html`.
- **Every scene folder is signed.** Any edit, even one character or the manifest's description, voids the signature, and the packaged app shows a black screen for an unsigned scene. Re-sign the folder after every edit with `npm run overlay:sign -- overlays/<folder>` (the signing gate is described in [overlays/MANIFEST-SPEC.md](overlays/MANIFEST-SPEC.md)).
- **Prove it before a push:** `npm test`, then `npm run verify:render -- --full` after any gameplay layout change.
