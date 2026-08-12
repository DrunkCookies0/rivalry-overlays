# RIVALRY Casterverse - Design Spec

> Scope note: this spec covers the gameplay overlay only. The other scenes and
> the chrome frame live in `overlays/`, with shared design tokens in
> `overlays/shared/rivalry-theme.css`.

Reference for designers making custom assets for the broadcast overlay.
All positions are relative to a **1920 x 1080** canvas (the size OBS
sets the Browser Source to). Designer-friendly summary, not a CSS dump.

---

## Canvas

| | |
|---|---|
| Target resolution | **1920 x 1080** (16:9) |
| Background | Fully transparent (it composites over RL's game capture in OBS) |
| Safe zone | Keep critical content within a 1840 x 1020 box (40px padding all sides) so it's never clipped on a stream encoded at a different aspect |

---

## Color palette

The overlay reads colors from CSS variables in [`overlays/rivalry-gameplay/index.html`](overlays/rivalry-gameplay/index.html). Swap these for full re-skin.

| Variable | Default | Purpose |
|---|---|---|
| `--blue` | `#2f7dff` | Team A accent (overridden live from the loaded league match) |
| `--red` | `#e6324f` | Team B accent (overridden live from the loaded league match) |
| `--panel` | `rgba(10,13,18,.94)` | Default panel fill (scorebar, statbar) |
| `--panel-solid` | `#0a0d12` | Solid panel fill (event title strip) |
| `--bar` | `#0c1118` | Inner bar fill |
| `--ink` | `#f3f7fc` | Primary text |
| `--muted` | `#9fb1c4` | Secondary text |
| `--gold` | `#f6c64a` | Goal-text accent |
| `--seg-off` | `#26323f` | Empty series-pip color |
| `--shadow` | `0 10px 34px rgba(0,0,0,.55)` | Drop shadow used everywhere |
| `--goalc` | (set dynamically) | Goal-banner color, becomes the scoring team's color at goal time |

---

## Persistent elements (visible throughout the match)

### 1. Event title strip

| | |
|---|---|
| Position | Top center, sits directly above the scorebar |
| Size | Auto-width (fits text). Padding 5px top/bottom, 26px left/right |
| Height | ~24px |
| Font | Segoe UI / Roboto, 12px, **bold**, 3px letter-spacing, UPPERCASE |
| Fill | `--panel-solid` |
| Content | Producer-typed string like `RIVALRY SEASON 1 \| PLAYOFFS \| UPPER ROUND 1` |
| Designer hooks | Font choice (system fonts swappable in `font-family`), padding/height in CSS |

### 2. Scorebar (top scoreboard)

| | |
|---|---|
| Position | Top center, just below the event title strip |
| Height | **62px** |
| Width | Variable (~840px total at default settings) |
| Layout | `[Team A Logo + Name] [Score A] [Clock] [Score B] [Logo + Name Team B]` |
| Logos | **42 x 42 px**, filled from the locked league match (served via the app's local logo proxy) |
| Team-name font | 26px, **800 weight**, UPPERCASE, 0.5px letter-spacing |
| Score font | 38px, **800 weight**, white on team color |
| Clock font | 30px, **800 weight**, dark text on light panel (`#f4f7fb` bg) |
| OT clock | Renders in `--red` with a `+` prefix |
| Designer hooks | Team logos and colors (from the loaded league match), scorebar background (`--panel`) |

### 3. Series subbar (below scorebar)

| | |
|---|---|
| Position | Directly under the scorebar |
| Content | `[Region tag - Series pips left] ........... [Series pips right - Region tag]` |
| Region tag | 11px **800 weight**, 1px letter-spacing, on `#161d26` rounded pill |
| Pip dimensions | **22 x 7 px**, 4px gap, rounded 2px |
| Pip-off color | `--seg-off` |
| Pip-on color | `--blue` / `--red`, with a 7px glow shadow |

### 4. Side player rails (boost meters)

| | |
|---|---|
| Position | Left rail at `top:18px, left:18px`. Right rail mirrored. |
| Width | **250px** each rail |
| Player row height | ~36px including padding |
| Layout | `[Name] ............. [Boost %]` with a colored fill bar at the bottom |
| Fill | Animates left-to-right as boost value changes |
| Active player highlight | Adds a CSS `.active` class (currently spectated player) |
| Designer hooks | Rail background (`--panel`), fill color (team color), name/value typography |

### 5. Focused player statbar

| | |
|---|---|
| Position | Horizontal center, just above the screen midline (`top:48%`) |
| Visibility | Only when RL fires `Game.Target` for a specific player |
| Layout | `[Player Name (colored)] [GOALS] [SHOTS] [ASSISTS] [SAVES] [DEMOS]` |
| Width | Variable (~720-800px depending on name length) |
| Height | ~58px |
| Designer hooks | Stat icons could be added (currently text-only), background `--panel`, dividers `#1c2632` |

### 6. Radial boost gauge

| | |
|---|---|
| Position | Bottom right (`bottom:22px, right:30px`) |
| Size | **118 x 118 px** |
| Ring weight | 9px |
| Track color | `#1a2330` (dark gray) |
| Value color | Team color (blue or red depending on focused player) |
| Center label | 34px **800 weight** boost number (0-100) |
| Visibility | Only when RL fires `Game.Target` (same as statbar) |
| Designer hooks | Ring weight, sizes, font; could swap to custom SVG ring with brand details |

---

## Transient elements (goal sequence)

The full sequence, in order, with the **timing** your designer should match for matching motion / audio assets:

```
T+0.0s    Goal happens. RL fires "GoalScored" event.
T+0.0s    Our banner starts the wipe-in animation.
T+0.28s   Banner fully visible (bg done sliding in).
T+0.38s   Banner text fully faded in (text starts 0.10s after bg).
T+0.0 to ~T+3.0s    Banner stays visible covering RL's "X SCORED" text.
~T+2-3s   RL fires "GoalReplayStart" (varies by game length).
~T+2-3s   Banner starts wipe-out (~0.28s). Stinger wipe fires.
~T+3.0s   Banner gone. Replay scene begins.
+~6-8s    Replay plays.
          RL fires "GoalReplayEnd".
+~0.0s    Stinger wipe fires again (transition back to live).
+~1.0s    Stinger done.
          RL fires "CountdownBegin" (kickoff).
          All goal-sequence visuals cleared.
```

### Goal banner (the painted slab)

| | |
|---|---|
| Position | Vertical center at `top:18%` (so band runs roughly y=130 to y=430 on 1080p) |
| Size | **Full width (1920px) x 300px tall** |
| Background | `--goalc` (solid, set to scoring team's color at goal time) |
| Border | 3px black top + bottom |
| Box shadow | Soft 60px black glow |
| Text | 88px **900 weight** UPPERCASE, 6px letter-spacing, white with dark drop shadow |
| Text content | Producer-typed template, default `{SCORER} SCORES`. Placeholders: `{SCORER}`, `{TEAM}`, lowercase variants keep casing |
| Show animation | bg wipes horizontally in (0.28s, ease), text fades + slides up (0.26s starting +0.10s) |
| Hide animation | reverse of show (same durations) |
| **Designer hooks** | Background image / gradient overlay, team logo placement inside the band, particle/sparkle layer on top via a transparent PNG, custom typography |

### Stinger wipe (transition effect)

| | |
|---|---|
| Position | Full screen overlay, `z-index:120` (above everything) |
| Trigger 1 | `GoalReplayStart` (covers the cut from live to replay) |
| Trigger 2 | `GoalReplayEnd` (covers the cut from replay back to live) |
| Total duration | **0.9 seconds** per fire |
| Visual | Two skewed colored panels sweep left-to-right across the screen, a centered RIVALRY logo flashes in the middle |
| Panel 1 | `--red` color, skewed -12deg, sweep ease curve `cubic-bezier(.6,0,.2,1)` |
| Panel 2 | `#0e1218` (almost-black), follows Panel 1 with a 0.06s delay |
| Logo | 230 x 155 px, fades in from 0 to full opacity at the midpoint, then fades back to 0 |
| **Designer hooks** | Replace `assets/rivalry-logo.svg` with the custom logo (keep transparent background, recommended 1024x1024 source for crispness). Swap panel colors via the CSS rules. Swap the sweep keyframes for non-linear / multi-panel choreography |

---

## Asset file conventions

Drop replacements into `assets/` with the same filename. The app picks them up automatically.

| Filename | Used by | Recommended format |
|---|---|---|
| `assets/rivalry-logo.svg` | Stinger center logo | **SVG** (vector, scales cleanly). PNG also works (transparent, 1024x1024) |
| `assets/rivalry-wordmark.svg` | Control panel header | **SVG**. PNG fallback ok (transparent, ~400x80) |
| `assets/tray.png` | System tray icon | **PNG**, transparent, 256x256 source (Windows downsamples to 16x16) |

To add a new asset (e.g. a goal sound effect, particle PNG, video sting):
1. Drop the file into `assets/`
2. Reference it from `overlays/rivalry-gameplay/index.html` (we'll wire it up, let me know what and when)
3. Rebuild the installer

---

## "Goal scene" (OBS-side, the polished alternative)

For the most polished result, **RL's in-game text never reaches the broadcast at all**: at goal time, OBS auto-switches to a dedicated scene that has no game capture. Just your overlay over a static background, video sting, or graphics.

Designer-deliverable for this:
- A 1920 x 1080 static background **OR** an MP4 video sting (transparent or solid)
- Optional: a custom "Goal" lower-third graphic overlay
- The producer wires this up in OBS as a new scene and enters its name in the control panel under OBS Integration -> Goal scene

The overlay's banner + stinger still play during this time, layered on top of whatever the Goal scene's content is.

---

## Quick reference: every timing in one place

| Asset | Show duration | Animation in | Animation out | Trigger |
|---|---|---|---|---|
| Goal banner | up to 3.0s (or until `GoalReplayStart`) | 0.28s wipe + 0.26s text fade | 0.28s wipe + 0.26s text fade | `GoalScored` |
| Stinger wipe | 0.9s total | sweep `cubic-bezier(.6,0,.2,1)` | sweep continues offscreen | `GoalReplayStart`, `GoalReplayEnd` |
| Stinger logo | 0.9s (matched) | fade-in to midpoint | fade-out from midpoint | (within stinger) |
| Statbar / radial gauge | continuous while RL spectates a player | hard show | sticky 1.5s after target goes null, then hard hide | `Game.Target` populates |
| Boost meter rails | continuous during match | width-only animation per change | per-frame | every `UpdateState` |
| Scorebar / event title / subbar | always visible during match | none | none | bridge connected |

If your designer wants to suggest changes to any of these timings, that's a code change - let me know what you'd want and I'll wire it up.
