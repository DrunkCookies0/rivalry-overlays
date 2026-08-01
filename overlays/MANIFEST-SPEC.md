# Overlay Manifest Spec - v1

Every overlay is a **folder** containing a `manifest.json` plus its assets
(`index.html`, CSS, JS, images). The folder name should be a kebab-case id that
matches `manifest.id`. The app discovers overlays by scanning the `overlays/`
directory and reading each manifest.

```
overlays/
  rivalry-starting-soon/
    manifest.json
    index.html
    overlay.css
    assets/…
```

## Fields

```jsonc
{
  "schemaVersion": 1,                 // manifest format version (currently 1)
  "id": "rivalry-starting-soon",      // kebab-case, unique, == folder name
  "name": "Starting Soon",            // human label shown in the control panel
  "author": "RIVALRY",                // who made it
  "version": "1.0.0",                 // overlay's own version (semver)
  "scene": "starting-soon",           // one of the scene types below
  "entry": "index.html",              // file the app serves as the overlay
  "needs": ["control"],               // which buses it consumes: "game" and/or "control"
  "contract": "1.x",                  // data contract version it targets (see CONTRACT.md)
  "description": "Pre-stream holding scene.",
  "approval": null                    // filled in by signing - see below. null = unsigned
}
```

### `scene` types

These map to the scenes a broadcast needs. The control panel groups overlays by
scene so a producer can pick one per slot.

| `scene` | Purpose | Typically `needs` |
|---|---|---|
| `starting-soon` | Pre-stream holding screen | `["control"]` |
| `brb` | Break / be-right-back | `["control"]` |
| `caster` | Caster intro / talking-head frame | `["control"]` |
| `match-preview` | Marquee pre-match VS graphic (teams, seeds, records) | `["control"]` |
| `up-next` | Schedule / upcoming matches | `["control"]` |
| `gameplay` | Live in-match overlay (scorebug, boost, stat pops) | `["game", "control"]` |
| `postgame` | Post-match results / stats (replaces in-game screen) | `["game", "control"]` |
| `bracket` | Playoff bracket (type reserved; no shipped scene in v1.0, returns for playoffs) | `["control"]` |

Most scenes are **control-only** - they never touch live RL telemetry. Only
`gameplay` and `postgame` need the game feed.

## The `approval` block (curated/signed gate)

An overlay can be **built** by anyone, but only **functions in the packaged app**
after Alex reviews and signs it. `approval` is `null` until signed; signing
writes a block like:

```jsonc
"approval": {
  "algo": "ed25519",
  "contentHash": "…sha256 hex over the whole folder…",
  "signature": "…base64 ed25519 signature over contentHash…",
  "keyId": "…short fingerprint of the signing key…",
  "signedAt": "2026-06-17T00:00:00.000Z"
}
```

- The signature covers the manifest (minus `approval`) **and every other file in
  the folder**. Change one byte → the signature is void → it drops back to
  preview-only until re-signed. You cannot edit an overlay after approval and
  keep the approval.
- **Unsigned / tampered overlays** still load in **dev mode** with a
  `PREVIEW - NOT APPROVED` badge, so designers get a full local loop. The
  packaged production app refuses to serve them.
- The signing key is held only by Alex. See [README.md](README.md) for the
  review → sign → ship flow.
- A second gate exists on top of signing: the packaged app also requires
  access-key activation before serving any scene, independent of overlay
  signing.

Verify what the app will decide, any time:

```
npm run overlay:verify -- overlays/your-overlay
```
