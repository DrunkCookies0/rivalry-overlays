# RIVALRY Overlays: authoring kit

> **INTERNAL AND FUTURE.** This kit builds RIVALRY's own scenes. It is not
> currently open to outside designers; the workflow below is kept for when
> that changes.

This directory is the home for **multiple overlays** (in-house and community) and
the shared tooling to build them. The goal: let designers build their own
overlays for the RIVALRY broadcast system, while keeping a hard gate so nothing
goes live without Alex's review.

> The shipped gameplay overlay lives here too, at
> `overlays/rivalry-gameplay/index.html`. The legacy `overlay/overlay.html`
> has been removed from the repo; all work happens in this directory.

## What's here

| Path | What it is |
|---|---|
| [CONTRACT.md](CONTRACT.md) | The published, versioned data contract. The real API. Start here. |
| [MANIFEST-SPEC.md](MANIFEST-SPEC.md) | The `manifest.json` format + scene types + the signing gate. |
| [sdk/rivalry-overlay-sdk.js](sdk/rivalry-overlay-sdk.js) | The browser runtime: connect, reconnect, normalize, mock, helpers. |
| [sdk/rivalry-bind.js](sdk/rivalry-bind.js) | Declarative binder: `data-field`/`data-bg`/`data-mono`/`data-slot` → control feed. |
| [sdk/rivalry-fit.js](sdk/rivalry-fit.js) | Scale-to-fit: scales the 1920×1080 design to any source size (16:9 preserved). |
| [shared/rivalry-theme.css](shared/rivalry-theme.css) | Shared RIVALRY design tokens (`--rv-*`, fonts, Rivalry Cut). |
| [_template/](_template/) | Copy this folder to start a new overlay. Works out of the box. |
| keys/ | Signing keys (public committed, private gitignored). |

## Resolution independence

Overlays are designed once at a fixed **1920×1080** reference and `rivalry-fit.js`
scales them uniformly to fill whatever the OBS Browser Source size is, pixel-perfect
at 720p / 1080p / 1440p, 16:9 always preserved. A non-16:9 source is centered with a
transparent letterbox (never distorted). Add `?fit=cover` to the source URL to
fill-and-crop instead. Set the Browser Source to 1920×1080 (recommended) or any 16:9 size.

## What you give a designer

1. This whole `overlays/` folder (or just the contract + SDK + template).
2. Point them at **CONTRACT.md** (what data exists) and the top of the **SDK file**
   (how to consume it). They never need to read the Electron app or the bridge.
3. They copy `_template/`, rename it, and build. The SDK's built-in mock means
   they need **neither Rocket League nor the app running** to design.

## Build → review → ship workflow

```
designer copies _template/  ─►  builds against SDK + mock  ─►  hands folder to Alex
                                                                      │
                            Alex reviews the code/visuals  ◄──────────┘
                                       │
                       npm run overlay:sign -- overlays/their-overlay
                                       │
                              ships in the next build
```

- A **signed** overlay loads in the packaged app.
- An **unsigned or edited** overlay loads only in dev/preview, with a
  `PREVIEW - NOT APPROVED` badge, and is refused in production.

### One-time setup (Alex)

```
npm run overlay:keygen        # mint the Ed25519 keypair (once, ever)
```
Commit `overlays/keys/rivalry-overlay-public.pem`. Back up the private key
somewhere safe and never commit it (it's gitignored).

### Per-overlay commands

```
npm run overlay:sign   -- overlays/<id>     # approve for production (Alex only)
npm run overlay:verify -- overlays/<id>     # check what the app will decide (anyone)
```

## Try the template right now

- **No app needed:** open `_template/index.html` in a browser → it auto-mocks and
  shows a live scorebug + event log.
- **Real data:** run the app in dev mode pointed at this repo, then add
  `http://localhost:49080/overlays/_template/index.html` as a 1920×1080 OBS
  Browser Source.

## Scenes the system targets

`starting-soon`, `brb`, `caster`, `match-preview`, `up-next`, `gameplay`,
`postgame`, `chrome`, `standings`
(see [MANIFEST-SPEC.md](MANIFEST-SPEC.md)). Most are control-bus-only and far
simpler than the live `gameplay` overlay.

## Status: wired into the app

The gate is enforced at serve time, not just via the CLIs:

- **Loader + gate:** `main.js` loads the public key at boot and scans this
  directory via `bridge/overlay-registry.js` (manifest read + signature
  verify, cached at scan). In production the app serves only **approved**
  folders and injects `__RIVALRY_SIGNED__ = true` into the served bytes of an
  approved entry HTML (disk untouched, signature stays valid). Unsigned or
  tampered overlays are refused in production and load in dev mode only, with
  the preview badge.
- **Registry + panel:** `GET /overlays/registry.json` exposes the cached
  registry, and the control panel's Overlays / Scenes card lists every scene
  from it with copy-URL and preview buttons plus an approved/preview pill.
- **Gameplay migrated:** the shipped gameplay overlay lives at
  `overlays/rivalry-gameplay/` (the legacy `overlay/overlay.html` has been
  removed from the repo).
