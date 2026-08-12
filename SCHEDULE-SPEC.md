# Broadcast schedule: importable JSON shape

Status: **spec only, no importer UI in v1.0.** This documents the exact shape a
future exporter (for example a Casterverse bot "tonight's broadcast" export)
must produce so the control panel can load a whole night in one action. The
shape is deliberately identical to the `schedule` field the panel already
broadcasts on the control bus (see `overlays/CONTRACT.md`), so importing is
"fill the panel from this object" and nothing more.

## The document

```jsonc
{
  "version": 1,                          // this spec; bump only on breaking change
  "event": {
    "season": "SUMMER CIRCUIT 2026",     // free text, shown in chrome + scenes
    "circuit": "3V3 EAST",
    "tier": "TIER 1"
  },
  "series": [
    {
      "matchId": "68a1f0c4e2b7431d9c001001",  // league match id, REQUIRED (see rule 1)
      "teamA": { "name": "FROST",  "logo": "", "tag": "", "seed": "", "record": "4-1" },
      "teamB": { "name": "EMBER",  "logo": "", "tag": "", "seed": "", "record": "3-2" },
      "bestOf": 5,                        // odd int; operator-owned, not in the league API
      "round": "Summer 2026 | 3v3 East | Round 3",
      "startTimeIso": "2026-08-01T00:30:00.000Z",  // sortable truth
      "startTimeDisplay": "8:30 PM ET"    // what renders; regenerate client-side if absent
    }
  ]
}
```

## Rules an importer must follow

1. **`matchId` is required.** The schedule holds league matches only; there is
   no manual-pairing fallback. An entry without a `matchId` is invalid and the
   panel drops it. At load time the app re-resolves teams, records and logos
   from the league API (via the local logo proxy), so stale exported names or
   logos never reach air. The inline `teamA`/`teamB` are display fallback only
   for when the API is unreachable.
2. **`startTimeIso` is the ordering key.** `startTimeDisplay` is presentation
   only; if it is missing, the panel derives it from the ISO value in the
   producer's locale.
3. **`bestOf` is operator territory.** The league API does not carry it; an
   exporter should emit the league's configured default and expect the producer
   to correct it.
4. **Logos are URLs or empty.** Never export a presigned league CDN URL (they
   expire in ~15 minutes); export `""` and let rule 1 fill it, or a stable URL.
5. **Unknown fields are ignored, never fatal.** Additive evolution, same as the
   control-bus contract.
6. **Caster assignment is deliberately absent from v1.0.** When it arrives it
   will be an additive `casters` array per series entry, not a change to any
   existing field.

## Where it would plug in

- Panel side: a "Load schedule from file" action on the Broadcast schedule card
  that maps `series[]` onto the existing queue entries (`id` generated locally)
  and `event` onto the once-per-night fields, then pushes.
- The queue entry shape in the panel is `{ id, matchId, teamA, teamB, bestOf,
  round, startTimeIso, startTime }`, so the mapping is 1:1 with
  `startTimeDisplay` renamed to `startTime`.
