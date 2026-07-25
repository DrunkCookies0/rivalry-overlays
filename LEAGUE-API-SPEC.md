# RIVALRY Casterverse <-> League API: requested endpoints

Spec for the overlay app's integration with the league backend (`rivalry-dev/rivalry-web`). Written against the backend models as of 2026-06-17. Most of this is "expose existing data via key-gated endpoints," not new data modeling, except where called out.

Audience: Cynical (backend). Author: overlay side.

> **Status (2026-06-17, per Cynical):** the underlying data already exists; the match endpoints just need to be built. Cynical is fixing the player IDs in the replay parser, then deploying + testing, after which the match APIs are realistically good. His answers from that exchange are folded in below (resolved items in §7).

---

## 1. Context and goal

The overlay app spectates a live Rocket League match and renders broadcast graphics. Today it is fully operator-driven (the producer types team names, logos, seeds, records, player titles into the control panel). We want the producer to instead **select a pre-arranged match** and have the overlay auto-fill team branding, rosters, records, and per-player identity (avatar, title, ranks).

Broadcast data (teams, matches, rosters, logos, records) is not key-gated yet; the `/api/v1` (`x-api-key`) surface today is `users` + `user-ranks`. Cynical confirmed the data exists and the match endpoints below just need building. This spec lists what we need exposed.

---

## 2. The binding problem (read first, it shapes everything)

Rocket League's native Stats API gives us **only `Name`, `Shortcut` (spectator slot index), and `TeamNum`** per player. There is **no stable account/platform ID in the live feed** (verified via capture 2026-06-17). So:

- We **cannot** auto-bind a live RL player to a league account by ID, because RL never tells us the account.
- We **will not** bind by display name, because players change their in-game/Steam names often (false matches and false flags).

**Confirmed 2026-06-17:** human matches expose nothing extra either, the overlay only ever sees what Epic's Stats API shows. (Still worth one human-match capture to be 100% sure, but plan as if there is no ID.)

**Therefore the binding must come from the match roster, with producer confirmation:**

1. Producer selects the match (or it is assigned via Casterverse later).
2. API returns the two rosters: the expected players, each with `name`, `userId`, and identity (avatar, title, ranks).
3. The overlay maps the (<=6) live RL slots to the (<=6) roster players and shows that mapping to the producer to **confirm or correct** once per match. No silent name-matching, no auto-flagging.

To make step 3 less manual over time, also expose each roster player's **linked accounts** (platform IDs + current display names) so the overlay can pre-fill the slot mapping (Cynical agreed to expose these; see P2).

---

## 3. Conventions

- **Auth:** `x-api-key` header (existing). Read endpoints below should accept the same service key as `/api/v1/users`.
- **Base:** `/api/v1/...`, documented in Swagger (`/api/docs`) like the existing routes.
- **Join key:** `matchId` is the key for all match-scoped routes (confirmed).
- **Images:** a backend image service resolves logo object keys to ready-to-use URLs (overlay sets `img.src` directly). **Caveat (confirmed):** these URLs **expire (~15 min default)**. So the overlay must NOT persist them; if a scene is reloaded after expiry, re-fetch `GET /matches/:id` to get fresh URLs. Player avatars: Discord avatar hash works (overlay builds `cdn.discordapp.com/avatars/{discordId}/{hash}.png`); a resolved `avatarUrl` is preferred.
- **Derived fields:** team record (W-L, and game W-L) and seed are not stored on Team/Roster and are not modeled. If derived from Match results and returned (P2) we'll use them; otherwise they stay operator-entered.

---

## 4. Endpoints, by priority

### P1 - Match selection + full broadcast context (the core ask)

Backend status: data exists; endpoints just need building (Cynical: fix parser ids -> deploy -> test).

**`GET /api/v1/matches`** - list matches the producer can pick.
- Query: `status` (`scheduled|in_progress|completed`), optional `circuitId`, `seasonId`, `from`/`to` date, pagination.
- Each item: `matchId`, `round`, `status`, `scheduledDate`, `circuit`/`tier`/`season` names, and both sides resolved from the rosters: `{ rosterId, name (lockedName), logoUrl, seriesWins }`.
- Source models: `Match` (status, round, scheduledDate, team1/2RosterId, team1/2Score), `Roster` (lockedName, lockedLogo), `MatchResult` (team1/2SeriesWins).

**`GET /api/v1/matches/:id`** - everything the overlay needs to run the broadcast for one match:
```jsonc
{
  "matchId": "...",
  "status": "in_progress",
  "round": 3,
  "event": { "season": "Season 1", "circuit": "Pro", "tier": "Tier 1", "roundLabel": "Upper Bracket - Round 1" },
  "scheduledDate": "2026-06-20T00:00:00Z",
  "teams": [
    {
      "rosterId": "...",
      "name": "FROST",               // Roster.lockedName
      "logoUrl": "https://.../frost.png",  // resolved, EXPIRES ~15m (re-fetch on reload)
      "seriesWins": 2,               // from MatchResult
      "players": [ /* PlayerIdentity[] - see section 5 */ ]
      // seed + record are NOT in the API (see notes) -> operator-entered for now
    },
    { /* team 2 */ }
  ]
}
```
- This single call replaces the producer typing team names/logos AND gives the roster for binding.
- **bestOf is NOT in the API** (hardcoded backend-side, not modeled). The overlay keeps it operator-entered (already shipped).

### P1 - Resolve logo URLs
- Done: the image service returns usable URLs (with the ~15m expiry caveat in §3). Wherever a logo is returned (`Roster.lockedLogo`, `Team.logo`, `Season.logo`), return the resolved URL, not the R2 key.

### P2 - Player titles + badges (NEW data model)
- The overlay shows a per-player **title** (a subtitle line) and up to **3 badges** on the goal banner. Confirmed: the website does not model these yet.
- Eventually add, per player (on `User`, and/or overridable per `Roster` player for season-specific titles): `title: string`, `badges: string[]` (cap 3); expose in `PlayerIdentity` (§5).
- Until then the producer sets titles manually in the control panel (already shipped overlay-side).

### P2 - Per-roster-player linked accounts (optional soft binding aid)
Cynical will expose each user's **linked accounts** (platform IDs + display names) from `User.linkedAccounts` / `User.discordConnections`. For us this is only a **soft binding aid**: the overlay can fuzzy-match a live in-game name against a roster player's known display names to *suggest* a slot mapping, which the producer still confirms. Low value (the live feed has no IDs, so it stays name-based) but free, since Cynical exposes them anyway.

> **Integrity / alt-account detection: DROPPED** (Alex, 2026-06-17). It can't be done overlay-side (no account/platform ID in the live feed; EAC so no Bakkesmod), and we're not pursuing the server-side replay-based version either.

### ~~P2 - Teams (standalone)~~ - DROPPED
Cut per Cynical: the roster already carries everything a team needs, so a standalone `GET /teams/:id` is redundant.

**Non-RV matches: supported via manual mode.** The baseline scenes are **general-purpose**. For a non-RV match the producer just enters team names/logos/seeds/etc. in the control panel (no API). RV matches get the same scenes auto-filled from the API. The overlays are not RV-locked.

### ~~P3 - Replay upload~~ - DEFERRED (no reliable auto-capture)
There's no reliable way to auto-save `.replay` files anymore (Alex, 2026-06-17), so an auto-upload endpoint has little value right now. Park it as a **future feature** if Psyonix restores auto-save. (`POST /api/v1/matches/:id/replays`, route key `matchId`, would wire onto the existing parse pipeline when revisited.)

### P3 - Post-game stats
The post-game results scene (box score: goals / assists / saves / shots / demos per player, final score, MVP) is built from the **live Stats API data the overlay already collects** (`UpdateState.Players[]`), so it does **NOT** depend on replays or this API. It can be built today.
**`GET /api/v1/matches/:id/stats`** stays a **future enhancement** for richer parsed-replay stats (boost / movement / positioning), only relevant once replay capture exists again.

---

## 5. The `PlayerIdentity` object (shape the overlay wants per player)

```jsonc
{
  "userId": "...",
  "name": "Samba",                    // Roster.players[].name (registered in-game name)
  "title": "Team Frost - Captain",    // P2 (new, not modeled yet) - operator-entered until then
  "badges": ["MVP", "Top Scorer"],    // P2 (new, not modeled yet), cap 3
  "avatarUrl": "https://cdn.discordapp.com/avatars/.../...png",
  "ranks": { "1v1": 1450, "2v2": 1600, "3v3": 1720, "tracker": "https://..." },  // from UserRank
  "platformIds": { "steam": "76561198...", "epic": "..." },     // P2 (binding aid)
  "platformNames": ["Samba King"]                                // P2 (binding aid)
}
```

---

## 6. Priority summary

| P | Item | Status |
|---|---|---|
| P1 | `GET /matches`, `GET /matches/:id` (resolved rosters) | Data exists; endpoints to be built (parser id fix -> deploy -> test) |
| P1 | Resolved logo URLs | Done via image service (~15m expiry -> re-fetch on reload) |
| P2 | `title` + `badges` on player | Not modeled yet; operator-entered for now |
| P2 | Per-player linked accounts | Cynical will expose; optional soft binding aid only |
| P3 | `GET /matches/:id/stats` | Future — post-game scene uses LIVE feed; this adds richer replay stats later |
| ~~P2~~ | ~~`GET /teams/:id`~~ | Dropped (roster suffices; non-RV uses manual mode) |
| ~~P3~~ | ~~`POST /matches/:id/replays`~~ | Deferred — no reliable replay auto-capture; revisit if Psyonix restores |

---

## 7. Resolved with Cynical (2026-06-17)

1. **bestOf / series format** - not in any model; hardcoded backend-side. -> Overlay keeps it operator-entered (already does).
2. **Seed** - not modeled. Cynical: "why seed anyone?" Our context: playoff seed for the scoreboard, plus the season record shown like `3-2 (9-4)`. -> Operator-entered for now; revisit deriving from match results later (future).
3. **Scoped read-only key** - no. Keys are unscoped by design and will stay that way. -> Mitigation is on us: the app must not expose the key or proxy writable data ("don't let your app expose data"). Ties to the open-client + server-gate strategy.
4. **Account ID in a human match** - none expected; the feed only shows Epic Stats API fields. -> Live binding stays roster + producer-confirm (§2).
5. **Replay upload route key** - `matchId`.
6. **Logo URLs** - image service resolves them, but they expire ~15 min -> re-fetch on reload (§3).
7. **Teams standalone** - dropped (roster suffices).

### Decisions (Alex, 2026-06-17)
- **Non-RV match support: YES, via manual mode.** Baseline scenes are general-purpose — non-RV = manual control-panel entry, RV = API auto-fill. Not RV-locked.
- **Integrity / alt-detection: DROPPED.** Not viable overlay-side; not pursuing server-side either.
- **Replay auto-capture: DROPPED for now.** No reliable RL auto-save; future feature only if Psyonix adds it. Post-game stats come from the live feed instead, so the post-game scene is not blocked.
