# RIVALRY Overlay Data Contract — v1

This is the published, versioned contract every overlay codes against. It is a
**stable surface**: once a field is documented here, it does not change shape or
disappear without a contract version bump. The [SDK](sdk/rivalry-overlay-sdk.js)
is a convenience layer over this contract, not a replacement for it; you can
ignore the SDK and speak the raw protocol if you want.

> Source-agnostic, same fields. Since 2026-08 the app is match-first: team
> identity comes from a loaded RIVALRY league match (cached at load time), and
> operator-owned fields (series score, best-of, seeds, casters, chrome) come
> from the control panel. **The contract below did not change** when manual
> team entry was removed, and it will not change when new sources arrive. An
> overlay never knows or cares where a field's value came from — that is the
> whole point of the control bus being a defined contract.

---

## Endpoints

Two WebSocket servers, both loopback-only:

| Bus | URL | Direction | Carries |
|---|---|---|---|
| **Game feed** | `ws://localhost:49124` | app → overlay | live Rocket League match events + state |
| **Control bus** | `ws://localhost:49777` | producer → overlay | team branding, series score, event title |

### Origin restriction (read this)

The bridge rejects WebSocket handshakes whose `Origin` is not the app's own page
(`http://localhost:49080`). Two consequences:

- **Served by the app → real data.** Add your overlay as an OBS Browser Source
  at `http://localhost:49080/overlays/<your-id>/index.html`. OBS sends no Origin,
  which is allowed.
- **Opened off disk (`file://`) → no real data.** The browser's `file://` origin
  is blocked, so the live sockets won't connect. The SDK detects this and
  **falls back to its built-in mock automatically**, which is exactly what you
  want for a fast design loop. Append `?mock=1` to force mock even when served.

---

## Game feed (`ws://localhost:49124`)

Every message is a JSON envelope:

```json
{ "event": "<EventName>", "data": { /* event-specific */ } }
```

### Events

| Event | When | Key `data` fields |
|---|---|---|
| `UpdateState` | continuous, ~60 Hz (`PacketSendRate=60`); scenes must budget their per-message work accordingly | `MatchGuid`, `Players[]`, `Game{}`, `Target` |
| `GoalScored` | a goal is scored | `Scorer{Name, TeamNum}`, `GoalSpeed` |
| `GoalReplayStart` | goal replay begins (~3.5 s after goal) | — |
| `GoalReplayWillEnd` | replay about to end | — |
| `GoalReplayEnd` | replay ends | — |
| `CountdownBegin` | kickoff 3-2-1 begins | — |
| `RoundStarted` | camera cuts to play (NOT ball-drop) | — |
| `StatfeedEvent` | demo / save / shot / assist / special goal | `Type`, `MainTarget`/`MainPlayer{Name}`, `Attacker{Name}`, `Victim{Name}` |
| `MatchCreated` / `MatchInitialized` | new match | — |
| `MatchEnded` / `PodiumStart` | match over | — |

### `UpdateState.data` shape

```jsonc
{
  "MatchGuid": "string",
  "Target": "PlayerName",          // who's being spectated (may be "")
  "Players": [
    {
      "Name": "string",
      "TeamNum": 0,                  // 0 = blue, 1 = orange
      "Score": 314,                  // RL points (not goals)
      "Goals": 1, "Shots": 2, "Assists": 0, "Saves": 0, "Demos": 2,
      "Touches": 4,
      "Boost": 100                   // 0–100
    }
  ],
  "Game": {
    "Teams": [
      { "Name": "BLUE",   "TeamNum": 0, "Score": 3, "ColorPrimary": "3b8fff" },
      { "Name": "ORANGE", "TeamNum": 1, "Score": 2, "ColorPrimary": "ff7a2f" }
    ],
    "TimeSeconds": 210,              // counts DOWN in regulation, UP in OT
    "IsOT": false,                   // unreliable in bot/private — see quirks
    "Ball": { "Speed": 16.4, "TeamNum": 1 },
    "Winner": "",
    "Arena": "Stadium_P"
  }
}
```

Not every field is present in every mode (bot/private matches are sparser).
Always guard with defaults. `ColorPrimary` is a hex string **without** `#`.

### Synthetic events

Some modes (bot exhibitions, certain casual playlists) don't fire `GoalScored`
or demo `StatfeedEvent`s. The bridge watches `UpdateState` deltas and synthesizes
them so your overlay sees a goal either way. Synthesized events carry
`"_synthetic": true` in `data` — treat them identically unless you have a reason
not to.

### Quirks you must handle (hard-won from live captures)

- **`GoalScored` double-fires** (native + synthetic) within ~50 ms — debounce.
- **Empty-scorer `GoalScored`** can fire on `GoalReplayEnd` — ignore `Scorer.Name === ""`.
- **`IsOT` is unreliable** in bot/private matches (often never set). Don't trust
  it alone. The shipped overlay infers OT from a tied score + an ascending clock.
- **`RoundStarted` is NOT ball-drop.** It's the camera cut, landing 0.8–4.6 s
  before the ball actually drops depending on scenario. Don't anchor a "GO!" to it.
- **Demos double-fire**; dedupe by attacker+victim within a short window.

---

## Control bus (`ws://localhost:49777`)

Overlays **listen** here for branding/series metadata. The bus has last-state
retention: a freshly-loaded overlay is immediately sent the most recent control
message, so you don't render blank on reconnect.

Listen only for `type: "control"`. Other traffic exists on this bus
(`obs-settings`, `obs-action`) and is meant for the app, not overlays — ignore it.

```json
{
  "type": "control",
  "payload": {
    "teamA": { "name": "GUARDIANS", "logo": "https://…/a.png", "tag": "NA1", "seed": "#1", "record": "12-3" },
    "teamB": { "name": "SENTINELS", "logo": "https://…/b.png", "tag": "NA2", "seed": "#4", "record": "9-6" },
    "bestOf": 5,
    "series": { "a": 0, "b": 0 },
    "eventTitle": "RIVALRY SEASON 1 | PLAYOFFS",
    "round": "UPPER BRACKET • ROUND 1",
    "startTime": "8:00 PM ET",
    "casters": [ { "name": "ALEX 'COOKIES' TOLL", "role": "PLAY-BY-PLAY", "handle": "@cookies", "stream": "vdo-id-or-url", "avatar": "" } ],
    "upNext": [ { "teamA": "NOVA", "teamB": "ECLIPSE", "time": "9:30 ET", "round": "UB R1" } ],
    "brand": { "leagueName": "RIVALRY", "logo": "" },
    "bracket": { "rounds": [ { "name": "QUARTERFINALS", "matchups": [ { "teamA": "GUARDIANS", "teamB": "DRIFT", "scoreA": 3, "scoreB": 1 } ] } ], "champion": "" }
  }
}
```

| Field | Meaning |
|---|---|
| `teamA` / `teamB` | `{ name, logo (URL, may be ""), tag, seed, record }` — `seed`/`record` used by presentation scenes |
| `bestOf` | series length (odd number) |
| `series` | wins so far `{ a, b }` |
| `eventTitle` | free-text broadcast title |
| `round` | sub-title / bracket round (preview, starting-soon) |
| `startTime` | human-readable start time string |
| `casters` | array of `{ name, role, handle, stream, avatar }` — `stream` = VDO.Ninja view link or stream ID for that caster's cam, held for the producer's link workflow (the casters scenes do NOT embed it; they punch transparent holes and cams are placed OBS-side; 1-3 casters, layout adapts) |
| `upNext` | array of `{ teamA, teamB, time, round }` (up-next scene) |
| `brand` | `{ leagueName, logo }` — optional; scenes default to "RIVALRY" |
| `bracket` | `{ rounds:[{ name, matchups:[{ teamA, teamB, scoreA, scoreB }] }], champion }` — winner = higher score. **No shipped scene consumes this in v1.0** (the bracket scene returns for playoffs); the field stays documented because the contract is additive-only |
| `players` | array of `{ name, title, badges[] }` — per-player caption data keyed by in-game name (gameplay overlay shows title/badges on the goal banner). Sent by the panel's Player Titles card |
| `queue` | producer rundown: array of `{ id, matchId, teamA, teamB, bestOf, round, startTime }` plus sibling `queueActive` (id of the on-air entry). Producer-panel bookkeeping; overlays other than chrome may ignore it. Superseded in spirit by `schedule` below, kept for compatibility |
| `chrome` | `{ leagueName, seasonName, circuitName, streamLine, socials:[{ network, handle }], showcase:{ label, name, logo } }` — persistent-frame content, set once per event. `showcase` is a generic labelled slot (franchise showcase, future sponsor), never hardcoded to either. `streamLine` is the ticker's right-hand slot (for example "STREAM • TWITCH.TV/RIVALRY") |
| `ticker` | `{ manualLines:[string], items:[{ type, text, ... }] }` — bottom-ticker content. `manualLines` always works and is the baseline. `items` is a **discriminated list**: each item carries a `type` (`"schedule"`, `"result"`, `"text"`; future types such as `"live-cast"` may appear) and consumers MUST skip item types they do not recognize |
| `lowerThird` | `{ visible, kind, title, subtitle, durationSec, shownAt }` — producer-called lower third (`kind`: `"caster"`, `"announce"`, `"sponsor"`). `durationSec > 0` means auto-dismiss after that many seconds; `0` means hold until `visible:false`. `shownAt` is epoch ms stamped by the panel at call time; consumers show only the REMAINING time, so retained-state replay to a freshly loaded page cannot resurrect an expired lower third |
| `schedule` | `{ event:{ season, circuit, tier }, activeIndex, series:[{ id, matchId, teamA, teamB, bestOf, round, startTimeIso, startTimeDisplay }] }` — the broadcast night. Drives Up Next, Starting Soon, and ticker schedule items. `startTimeIso` is the sortable truth; `startTimeDisplay` is what renders |
| `standings` | `{ circuit:{ id, name, tier, season }, updatedAt, rows:[{ position, rosterId, name, logoUrl, wins, losses, record, gamesRecord, points, matchesPlayed, streak }] }` — circuit standings in the league's OFFICIAL order (consumers must never re-sort; `position` is authoritative). Dark-launched: only present once the league API serves standings (Ask 1 in ASKS-FOR-CYNICAL.md). `logoUrl` arrives empty from the panel until a roster-logo proxy exists |

`teamA`/`teamB`/`bestOf`/`series`/`eventTitle` are the original gameplay-overlay fields; `round`/`startTime`/`casters`/`upNext`/`brand`/`bracket` were **added (v1, additive)** for the presentation scenes; `players`/`queue` arrived with the panel features that send them; `chrome`/`ticker`/`lowerThird`/`schedule` were **added (v1, additive) in the v1.0 chrome work**. Overlays ignore fields they do not consume, and a scene that lacks data for a field keeps its placeholder (lists hide empty slots). The locked league match and the panel's operator-owned cards fill the **same** fields; per the match-first note at the top, an overlay never knows which source a value came from.

Payloads may be **partial** — merge into your current state, don't replace it.
The SDK does this merge for you.

---

## Versioning policy

- Contract version is **v1**. Overlays declare `"contract": "1.x"` in their manifest.
- Additive changes (new optional fields, new events) stay within v1.
- Any breaking change (renamed/removed field, changed type) bumps to v2 and is
  documented here. The SDK's `RivalryOverlay.CONTRACT` reports the version it targets.
