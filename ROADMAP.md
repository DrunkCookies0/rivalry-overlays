# RIVALRY Casterverse - Path to Perfect

> Strategy notes from June 2026, partly superseded: v1.0 is private-and-direct
> distribution, the league API is wired, and post-game shipped. Manual mode
> shipped at the time but has since been removed by the match-only pivot.
> Kept for the BARL analysis.

## Context

Goal: make RIVALRY the best-in-class Rocket League broadcast overlay on the official Stats API, local-first, monetized as an open client plus a paid league service.

This plan synthesizes four inputs:
- Landscape + architecture research (how RL overlays evolved since the Stats API; reference architecture; gap analysis vs our code).
- RL Stats API deep-research (event catalog, real timing, quirks, the PacketSendRate lever).
- A full competitive teardown of BARL v2.0.4 (the closest comparable shipping tool).
- This session's hands-on fixes against live capture.

It is opinionated and prioritized (P0/P1/P2). Each item lists what, why, effort, and source.

## Where we stand (resolved this session)

- **v0.6.2 replay event-name fix (the big one).** Live capture proved RL emits `GoalReplayStart` / `GoalReplayWillEnd` / `GoalReplayEnd`; our overlay had listened for `ReplayPlayback*` since v0.5.2, so all three replay handlers were dead and the stinger only ever fired from the 13.75s bot-fallback. This was the root cause of the entire stinger-timing saga, not the constants. Fixed + verified; memory corrected.
- OT detection hybrid (IsOT fast path + clock-direction fallback), layered goal-sequence ownership model, inline-SVG stat icons (offline-safe), scorebar/subbar layout fixes, final-10 hold-at-zero, red OT clock.
- Leak audit: empirically no memory/DOM/WS leak. Long-session timing drift is OBS timer throttling, not a leak.
- Confirmed our architecture is sound and security-conscious: loopback bind + Origin allowlist on both WS servers. (BARL does neither.)

## Competitive position (from BARL teardown + landscape)

BARL is a thin local Electron shell whose entire UI is a Firebase-hosted SPA, ingesting RL via a framing-only relay (no event parsing), shipping a scorebar-centric overlay with `/login` + `/pricing` paid tiers (premium design packs, no payment processor wired yet).

| Dimension | BARL | RIVALRY | Edge |
|---|---|---|---|
| RL ingestion | Framing relay, no parsing | Bridge parses + frames, event state machine | RIVALRY (capability) |
| Control panel | Hosted SPA, bricks offline | Local HTTP 49080, works offline | RIVALRY |
| Overlay features | Scorebar, series pips, boost, stats box | + goal/replay/OT/kickoff/statfeed cinematics | RIVALRY |
| Frame-drop resilience | Snapshot render, self-healing | Edge events, must handle quirks | BARL (for its scope) |
| OBS throttling exposure | Same (overlay is separate CEF) | Same | Tie |
| Offline safety | Hard internet gate, no fallback | Fully local | RIVALRY |
| Theming UX | CSS preset gallery + live editor + per-user persistence | Operator config, less depth | BARL |
| WS security | Binds 0.0.0.0, no auth | Loopback + Origin allowlist | RIVALRY |
| Monetization | Account + premium packs (Discord-gated) | Open client + paid league service | Different models |

**Differentiation thesis:** win on local-first reliability + the cinematic broadcast layer + league integration. Monetize via the league service (records, seeds, avatars, replay uploads) and pro design packs. Do not copy BARL's cloud-dependent shell.

## Roadmap

### P0 - correctness / robustness (do first)

1. **Capture a human match for kickoff + OT timing, with ball-drop in frame.** Why: FIRST/POSTGOAL kickoff delays are self-rated LOW confidence; OT ascend-hysteresis was tuned against a single bot capture and OT kickoff has never been measured with ball-drop visible. Per `dont-call-guesses-fixes`, no further timing-constant changes without this. Effort: med (paired Playwright observer + OBS, recipe in `live-capture-workflow` memory). Note: the replay event-name conflict that older research flagged as P0 is already RESOLVED (v0.6.2).

2. **Verify `Game.Target` resolution + StatfeedEvent field shapes in a real spectated match.** Why: if Target resolution is wrong, the statbar/gauge highlight the wrong player. Live capture confirmed StatfeedEvent uses `MainTarget` and demos double-fire (native + our synthetic); finish confirming the spectated-target path. Effort: low.

3. **PacketSendRate experiment (60 to 100).** Why: BARL uses 100; the API caps at 120. Higher rate means finer `TimeSeconds` resolution, which directly eases the quantization that caused our OT-detection and final-10 edge bugs. Effort: low (one line in `rl-bridge.js` ini writer + re-capture to confirm it helps and does not hurt render perf).

### P1 - highest-leverage features + robustness

4. **Timing engine: wall-clock anchoring + Web Worker tick + visibility re-sync.** Why: our single biggest technical liability. OBS browser sources inherit Chrome background-timer throttling when off the active scene / minimized; our kickoff + goal sequences are pure chained `setTimeout` with absolute delays and no re-sync, so they silently drift off ball-drop. Fix: drive sequences off absolute target timestamps, recompute `remaining = target - performance.now()` per tick; run the master clock in a Worker (Worker timers are not throttled); re-sync on `visibilitychange`. This also removes drift as a confound for P0-1. Effort: med-high. Source: leak audit + landscape research; this is the confirmed cause of "timing all over the place after long sessions."

5. **Post-match sequence (final score -> series result -> MVP -> next-up).** Why: the single biggest feature gap vs RLCS-grade broadcasts; today MatchEnded/PodiumStart only tear down. Effort: high. (Design held earlier per `no-hacks-just-proper`; this is the design + build.)

6. **Wire the league API** (records/seeds -> tag slot, avatars -> fallback chain, subtitle/badges on the goal banner). Why: everything broadcast-distinguishing currently runs on placeholder data. Effort: high, depends on Cynical's backend (`league-backend-cynical`).

7. **Harden WS reconnect + add game-feed last-state retention.** Why: 24/7 broadcast reliability. Today: fixed 1500ms retry, reconnect on every close, no heartbeat, and the game feed has no last-state retention so a reconnect blanks persistent UI until the next UpdateState. Fix: exponential backoff + jitter, ignore clean close 1000, heartbeat, and retain last UpdateState to hydrate reconnecting overlays. Effort: med.

### P2 - polish + breadth + strategy

8. **CSS theme system (borrowed from BARL, done local-first).** Why: BARL's single best idea and a natural paid-pack surface. Ship free community themes locally; gate pro design packs behind the paid service. Push raw CSS over the existing 49777 control bus (BARL's `header_data` + checksum pattern). Keep it fully local, no hosted dependency. Effort: med.

9. **Manual-override / no-RL operator mode + in-panel preview.** SUPERSEDED AND REJECTED by the match-only decision: team identity comes exclusively from the locked league match, and a manual operator mode will not be built. (Original rationale, kept for the record: caster hand-sets names/scores/series for pre-show, technical difficulties, demos; preview without OBS open; borrowed from BARL.)

10. **Design audit.** Unify easing (ease-out for all enter/exit), verify OT/clinch state colors cannot collide with team colors (add neutral fallback below 3:1 contrast), bump goal-banner dwell from 3000ms toward 3500-4000ms. Effort: low-med.

11. **Snapshot-reconcile fallback.** Periodically reconcile score/clock/state from UpdateState so a missed edge event self-heals (the one place BARL's snapshot model is structurally tougher). Pairs with P1-4 and P1-7. Effort: low-med.

**Deferred / out of scope:** anything BakkesMod-based (EAC blocks it in private matches; `eac-not-bakkesmod`); a live minimap or live ball-speed from continuous telemetry (the Stats API does not expose continuous positional data; only static impact/last-touch fields exist, feasibility uncertain); the installer-freeze bug (deferred per memory).

**Do NOT copy from BARL:** the hard hosted-panel dependency (bricks offline), the pastebin remote-config nag + dead version ping, 0.0.0.0 WS binds with no auth, and the null-renderer + remote-UI shell. Our local-first design is strictly better for broadcast.

## Verification

- **Timing (P0-1, P1-4):** paired capture (Playwright WS observer for exact event timestamps + OBS MP4 for ball-drop), focused vs minimized OBS, confirm 3-2-1-GO lands on ball-drop in both. Recipe in `live-capture-workflow`.
- **Event handling (P0-2, P0-3):** the WS event logger at `C:\Users\Cookies\AppData\Local\Temp\rl-event-capture\logger.js` reproduces ground-truth event names, payload fields, and UpdateState Hz.
- **Features (P1-5/6, P2-8/9):** `npm run mock` exercises the full event sequence (now retimed to real intervals); validate visually in OBS, then in a live spectated match.
- **Reliability (P1-7, P2-11):** kill/restart the bridge mid-match; confirm the overlay reconnects with backoff and rehydrates state without blanking.

## Critical files

- `overlays/rivalry-gameplay/index.html` - timing constants (kickoff delays, STINGER_LEAD), OT detector, goal-sequence handlers, WS reconnect, renderBoost, stat-pop map.
- `bridge/rl-bridge.js` - TCP framing, synthetic event derivation, dual WS servers, ini writer (PacketSendRate).
- `main.js` - OBS auto-switch, control bus, electron-updater.
- Control panel (for the P2-8 theme system; P2-9 was rejected by the match-only decision).

## Sources

Landscape/architecture research (workflow whjmi7zrm), RL Stats API deep-research (ws99kqoq2), BARL v2.0.4 teardown (w6ybirvax), and live captures this session. Full BARL report archived at `C:\Users\Cookies\AppData\Local\Temp\barl-report.md`.
