# RIVALRY Overlay System — Plan of Attack

Season-ready plan for the **multi-scene overlay system** (the broadcast scenes + the kit + the serving/signing/packaging infrastructure that ships them). The live **gameplay-overlay correctness** work (timing engine, league-API wiring, WS hardening) lives in [ROADMAP.md](ROADMAP.md) and runs as a parallel track; this doc references it but doesn't repeat it.

Grounded in a 6-subsystem audit (2026-06-17). Effort tags: **S** ≈ <½ day, **M** ≈ 1-2 days, **L** ≈ 3+ days.

---

## ✅ BUILT 2026-06-18 (overnight, autonomous) — Phases 0-6 complete & verified

All seven phases below were implemented and verified. Summary:
- **Phase 0** — keypair minted (`overlays/keys`, key `c0a7dcbac0f9b754`); `overlays/**` packaged in both build configs with the private key excluded (verified in a real `npm run pack`); 5 baseline scenes signed; stale `AUTO-UPDATE-HANDOFF.md` deleted.
- **Phase 1** — `bridge/overlay-registry.js` (scan/verify/cache + classify + flag-inject) wired into `main.js`: boot scan, gated serving, `__RIVALRY_SIGNED__` injection, `/overlays/registry.json`. **20 unit + 9 HTTP gate tests pass.**
- **Phase 2** — control panel `Overlays / Scenes` card (registry-driven, copy-URL + preview, approved/preview pills, manual/match toggle stub). Verified.
- **Phase 3** — gameplay overlay migrated to `overlays/rivalry-gameplay/` + scale-to-fit (fixed elements scale via the stage transform — **no fixed→absolute rewrite, no JS/timing touched**); **legacy `overlay/overlay.html` kept untouched** as a fallback; `main.js` repointed. Verified at 720p/1080p/1440p/16:10 with a full goal sequence via fake-socket.
- **Phase 4** — `overlays/rivalry-postgame/` (live-feed latch, box score, MVP by Score, demo tally); OBS post-match trigger fixed to fire on `MatchEnded`/`PodiumStart` (was the broken `Game.Winner` heuristic); mocks emit a match-end cycle. Verified.
- **Phase 5** — `overlays/rivalry-bracket/` (8-team single-elim, winner highlight); additive `bracket` contract field; control-panel Bracket card; mock bracket sample. Verified.
- **Phase 6** — producer scene-deck (one-click switch via `obs-action`), `obs-controller switch` action, `setupObsScenes` now builds the full scene set from the registry.

**All 8 overlays signed + approved.** All JS passes `node --check`.

**Still open (next):** OBS scene-name dropdowns from `list-scenes` (text inputs today); the **human-match capture** (verifies post-match events + kickoff/OT timing); league-API wiring; ROADMAP P1-4 goal-sequence timing engine. The decision defaults below were applied (e.g. Kinetic Bold, MVP=Score, 8-team single-elim, switch-on-deck not auto) — adjust any on review.

---

---

## Where we are

**Done:** the authoring kit (CONTRACT, SDK, `rivalry-bind`, `rivalry-fit`, theme, `_template`, manifest spec, Ed25519 sign/verify lib + CLIs); 5 baseline scenes committed in **Kinetic Bold** (starting-soon, brb, casters, match-preview, up-next), resolution-independent + control-driven; control panel extended with the new fields; LEAGUE-API-SPEC reconciled with the backend.

**The gap:** none of it is *enforced or shipped* yet. No keypair exists, the build doesn't bundle `overlays/`, there's no loader/registry, and (important) because nothing sets `window.__RIVALRY_SIGNED__`, **every scene currently renders the "PREVIEW — NOT APPROVED" badge** — they are not air-safe as-is. Two scenes (post-game, bracket) aren't built. The gameplay overlay isn't in the system or resolution-independent.

---

## Critical path (do in order)

### Phase 0 — Foundation & packaging (unblock everything) · **S**
Nothing downstream works until these land.
- [ ] **Run `npm run overlay:keygen` once** (Alex). Commit `overlays/keys/rivalry-overlay-public.pem`; back up the private key off-machine (it's gitignored). *(blocks all signing/verify)*
- [ ] **Bundle `overlays/` in the build.** Add `overlays/**/*` to the `files` array in **both** `electron-builder.prod.js` and `electron-builder.beta.js`, with `!overlays/keys/*-private.pem` (electron-builder packs the working tree, not git — without this negation a private key on the build machine ships in the installer). Also exclude dead weight: `_template/`, `_prototype-*.html`, `*.md`.
- [ ] **Sign the 5 baseline scenes** (`npm run overlay:sign -- overlays/rivalry-<id>`).
- [ ] Delete/archive the stale `AUTO-UPDATE-HANDOFF.md` (wrong repo name; auto-update is already wired).
- [ ] Smoke-test: `npm run pack`, confirm the private key is **not** in `dist/win-unpacked`, and a scene + its `../shared` + `../sdk` assets all return 200.

**Done when:** a packed build serves the 5 scenes, signed, with the public key bundled and the private key excluded.

### Phase 1 — Loader + signing gate + registry (the keystone) · **M**
Turns the advisory gate into a real one and kills the on-air PREVIEW badge.
- [ ] `bridge/overlay-registry.js`: `scanOverlays(dir, publicKeyPem)` reads each `manifest.json`, runs `verifyOverlay` **once**, caches `{id, dir, entry, scene, needs, approved, reason, version, url}`. *(verify-per-request would re-hash whole folders on every Browser-Source load — must cache at scan)*
- [ ] `main.js`: load the public key at boot, scan at startup. Rewrite the `/overlays/...` request path to: **prod** → serve only `approved` folders and **string-inject `<script>window.__RIVALRY_SIGNED__=true</script>` into the served bytes of an approved entry HTML** (disk untouched, so the signature stays valid); **dev** → serve unsigned with the preview badge; keep the path-traversal guard.
- [ ] `GET /overlays/registry.json` returns the cached registry (for the control panel).
- [ ] Dev rescan when dev-mode root changes; optional `fs.watch` to auto-rescan on edits.
- [ ] Verify: signed scene → no badge + `__RIVALRY_SIGNED__===true`; unsigned → preview in dev, refused in prod.

**Done when:** signed scenes are air-safe (no badge) and unsigned ones can't masquerade as approved. *(Decision: list all overlays with an approved flag, or only approved — see Decisions.)*

> **Season stopgap if Phase 1 slips:** pass `{badge:false}` in each first-party scene's `connect()` to suppress the badge for RV's own (trusted) scenes. Proper fix is the loader; only do this if season timing forces it.

### Phase 2 — Control panel: scene list / switchboard · **M** · *after Phase 1*
- [ ] Scene-list card that fetches `/overlays/registry.json`, groups rows by scene, each with **copy-URL** + **open-preview** buttons and an **approved/preview** indicator (mirrors the LeagueOS resources panel). Purely additive — do not touch the existing `payload()`/`push()`/field listeners.
- [ ] Make it responsive in the OBS dock (reuse existing `.card`/`.row` tokens).
- [ ] Groundwork stub: a **Manual / Match (league)** segmented toggle, "Match" disabled with "coming soon" until the league API lands.

**Done when:** a producer can discover and copy every scene URL from the panel, signed vs preview clearly marked.

### Phase 3 — Gameplay overlay → the system + scale-to-fit · **M** · *can run alongside Phase 2*
Keep it **self-contained** (do NOT adopt the SDK/bind in this step — it's 2108 lines of tuned timing logic; rewriting the data layer is a separate, risky change).
- [ ] Create `overlays/rivalry-gameplay/` + `manifest.json` (scene `gameplay`, needs `["game","control"]`).
- [ ] Copy `overlay.html` → `index.html` **unchanged** first; fix only asset paths (`../assets` → `../../assets`, 3 refs). Verify it still renders at native size.
- [ ] Wrap content in `.rv-stage`, switch `html,body` to fill-viewport, convert the **10 `position:fixed` elements to `position:absolute`**, add `RivalryFit('.rv-stage')`.
- [ ] Update the 4 path references atomically (`main.js` ×3 + `control.html`); keep `/overlay/overlay.html` as a redirect during transition so existing OBS sources don't break.
- [ ] **Verify a full goal sequence** (mock) at 1920×1080 / 720p / 1440p / 1920×1200 — goal banner, replay card, stinger, kickoff all intact. Sign it.

**Done when:** the gameplay overlay scales like the others, with zero timing/goal-sequence regression. *(Highest risk: don't perturb the tuned timing — this is layout-only.)*

### Phase 4 — Post-game results scene (Alex's priority) · **L** · *after Phase 3 pattern*
Built from the **live feed** (no replays). Replaces RL's in-game results screen, auto-shown at match end.
- [ ] Scaffold `overlays/rivalry-postgame/` (scene `postgame`, needs `["game","control"]`).
- [ ] **Latch the last-good `UpdateState`**: keep updating while live; **freeze on the FIRST of `MatchEnded`/`PodiumStart`** (RL streams a zeroed UpdateState at podium — must snapshot before that and ignore the rest).
- [ ] Render box score per player (Goals/Assists/Saves/Shots/Demos/Score, Space Mono), final team score, **MVP**, both teams in Kinetic Bold. Demos come from a match-long `StatfeedEvent` tally (the live `Players[].Demos` is unreliable).
- [ ] Extend **both** mocks (`rl-bridge.js` + SDK `startMock`) with a match-end sequence + a realistic varied final box score so it's designable off-disk.
- [ ] **Fix the OBS post-match trigger** (currently broken): `onGameEventForObs` keys off `Game.Winner`, which the mock never sets and is unverified in real RL. Switch it to fire on `MatchEnded`/`PodiumStart`.
- [ ] Live-capture verify the podium zero-out timing + that the latch grabs the right frame (ties to the human-match capture below).

**Done when:** finishing a match auto-cuts to an accurate, frozen box-score scene. *(Decisions: MVP metric, Demos column, how it dismisses — see Decisions.)*

### Phase 5 — Bracket scene · **M**
Control-driven, single-elim, low data risk.
- [ ] Additive `bracket` control field in CONTRACT (`{ rounds:[{ name, matchups:[{teamA,teamB,scoreA,scoreB,winner}] }] }`) — stays v1.
- [ ] Scaffold `overlays/rivalry-bracket/` (control-only `connect({game:false})` + RivalryFit), single-elim 1920×1080 layout in Kinetic Bold.
- [ ] Add a **Bracket** card to the control panel (rounds → matchup rows; reuse the Up Next / stepper patterns).

**Done when:** a producer can fill a bracket in the panel and show it on air. *(Decision: 8-team single-elim v1 vs double-elim/16 — materially changes layout + contract.)*

### Phase 6 — OBS orchestration polish · **M** · *after Phases 1-2*
- [ ] Control-panel **scene deck**: one button per scene that sends an `obs-action` switch — gives the producer one-click scene control instead of blind free-text.
- [ ] Populate the scene-name inputs from OBS's live scene list (`list-scenes` plumbing already exists) → dropdowns + validation (a typo silently disables a trigger today).
- [ ] Extend `setupObsScenes` to optionally create the full scene set (gameplay + each presentation scene) with browser sources at the right URLs.

**Done when:** a producer can set up and drive all scenes from the panel. *(Decisions: switch PROGRAM vs PREVIEW; how much auto vs operator-driven.)*

---

## Parallel track — gameplay correctness + league API (existing [ROADMAP.md](ROADMAP.md))
Independent of the system phases; pull in as bandwidth allows.
- **ROADMAP P0** — one **human-match live capture** (kickoff/OT timing, `Game.Target`, and crucially whether `MatchEnded`/`PodiumStart`/`Game.Winner` carry usable data). **This is a shared prerequisite** — it also gates Phase 4's post-match verification. Recipe in the `live-capture-workflow` memory.
- **ROADMAP P0** — PacketSendRate 60→100 experiment.
- **ROADMAP P1-4** — timing-engine overhaul (goal-sequence wall-clock + Worker tick; kickoff half already done v0.6.8). Do **after** the Phase 3 migration is stable, not together.
- **ROADMAP P1-6** — wire the league API once Cynical ships the match endpoints (auto-fill control data, **re-fetch logo URLs on reload — they expire ~15 min**, roster→live-slot binding with producer confirm, avatars/ranks). Flips the Phase 2 toggle from stub to real.
- **ROADMAP P1-7** — WS reconnect hardening + game-feed last-state retention.
- **ROADMAP P2** — local CSS theme system, manual-override/preview, design audit (incl. the "Best of N" heavy-italic numeral legibility tweak).

---

## Decisions needed (with recommendations)

| # | Decision | Recommendation | Affects |
|---|---|---|---|
| 1 | Registry lists all overlays or only approved? | **All**, with an approved/preview flag (better operator UX) | Phase 1/2 |
| 2 | Control-panel "Launch" semantics | **Copy-URL + Open-preview-in-browser** (true add-to-OBS-via-websocket is a bigger feature) | Phase 2 |
| 3 | Code-sign the installer (kill SmartScreen)? | **Stay unsigned this cycle**, document the "More info → Run anyway" step | Phase 0 |
| 4 | Post-game **MVP** metric | **Highest RL Score** (it's RL's own all-around metric) — note it can crown a 0-goal playmaker | Phase 4 |
| 5 | Post-game **Demos** column | **Keep**, sourced from a match-long StatfeedEvent tally; drop only if it proves unreliable in capture | Phase 4 |
| 6 | Post-game **dismissal** | **Hold until the producer switches scene** (or next `MatchCreated`) | Phase 4/6 |
| 7 | **Bracket** format for v1 | **8-team single-elim** (3 rounds + champion); expand to double-elim/16 later | Phase 5 |
| 8 | OBS auto-switch target | **Switch PREVIEW, not PROGRAM** (producer cuts manually — safer on a live broadcast); lean operator-scene-deck over heavy automation | Phase 6 |

---

## Suggested sequencing

1. **Phase 0** (half a day, unblocks the rest) → you can ship the 5 scenes in a build.
2. **Phase 1** (kills the PREVIEW-on-air problem) → scenes are genuinely air-safe.
3. **Phase 3 + Phase 2** in parallel (gameplay into the system; panel scene list).
4. **Phase 4** (post-game — your priority) once the scene pattern + OBS trigger fix are in.
5. **Phase 5** (bracket) and **Phase 6** (orchestration polish) as playoffs approach.
6. **Parallel track** throughout; do the **human-match capture early** since Phase 4 and several ROADMAP items all wait on it.

**Fastest path to "usable this season":** Phases 0 → 1 → 4 (+ the human-match capture). That gives signed, air-safe baseline scenes plus the post-game results screen, with manual data entry that already works.
