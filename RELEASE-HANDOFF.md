# Handoff: shipping state, auto-updater, dev tooling

A handoff for whoever picks up next. Covers the current release state,
exactly what the auto-updater will and will not do, the ritual for cutting
a tag, what was installed locally, and the open decisions still on the table.

---

## 1. TL;DR current state

| Thing                                 | State                                                                |
| ------------------------------------- | -------------------------------------------------------------------- |
| Repo                                  | github.com/DrunkCookies0/rivalry-overlays (default branch: `main`)   |
| Current version                       | `0.6.x` on `feat/overlay-system`, heading to `1.0.0`                 |
| Git tags                              | 37+ exist                                                            |
| GitHub Releases                       | Beta prereleases exist, published by `pr-build.yml`                  |
| CI workflow runs                      | Has fired many times (beta channel)                                  |
| Installer published                   | Beta installers ship continuously; no production (`v*` tag) release yet |
| Auto-updater in code                  | Wired; matters for production once a `v*` Release exists with `latest.yml` |
| Code signing                          | NOT configured (SmartScreen will warn on first run)                  |
| Local dev tooling                     | Playwright + Chromium (see section 6)                                |

Bottom line: beta installers ship continuously from `pr-build.yml` (every PR to
`main` and every push to `feat/**`). Production has not shipped; the first `v*`
tag will be the first production release, and that is when the auto-updater in
`main.js` starts mattering for installed copies.

---

## 2. How the auto-updater actually works

Code lives in `setupAutoUpdate()` in [main.js](main.js).

- Runs ONLY when `app.isPackaged === true`. `npm start` / `npm run mock` skip
  it silently, no log, no error. This is intentional (no update feed in dev).
- Uses `electron-updater` with the `github` provider from
  `electron-builder.prod.js` (`owner: DrunkCookies0`, `repo: rivalry-overlays`,
  `releaseType: release`).
  On launch it fetches `https://github.com/DrunkCookies0/rivalry-overlays/releases/latest`,
  reads `latest.yml`, compares its `version` field to the installed app's
  `package.json` version.
- If newer, it auto-downloads the `.exe` in the background
  (`autoDownload = true`).
- It does NOT install mid-session. `autoInstallOnAppQuit = true` means the
  installer runs only when the user fully quits via the tray "Quit" item.
  This is deliberate so updates never restart the app mid-broadcast.
- While the app stays open it re-checks every 30 minutes.
- Tray menu "Check for updates" forces an immediate check.

What happens today if you launch the packaged app (assuming you somehow built
and installed it):
1. App opens normally.
2. Updater fetches `releases/latest` from the GitHub API.
3. Gets a 404 (no releases exist).
4. Logs an error via `autoUpdater.on('error', ...)`, swallowed by the `.catch(() => {})`.
5. App keeps running, nothing user-visible happens.

So the updater is harmless when there is nothing to update.

---

## 3. Cutting the first release (v1.0.0)

```bash
# 1. (optional but recommended) smoke-test the packaged build locally first
npm install
npm run pack            # builds dist\win-unpacked\ without producing the .exe
# launch dist\win-unpacked\RIVALRY Casterverse.exe and click through

# 2. tag and push - this is the one step that actually ships
git tag v1.0.0
git push origin v1.0.0
```

That tag push triggers `.github/workflows/release.yml`, which on
`windows-latest`:
1. `npm install`
2. `npm run release` (`electron-builder --win --publish always`)
3. Uploads `RIVALRY-Casterverse-Setup-1.0.0.exe` AND `latest.yml` AND a `.blockmap`
   to a new GitHub Release `v1.0.0`, using the workflow's `GITHUB_TOKEN`.

Once that Release exists, any installed copy of the app on the planet will
pick it up at next launch (or the user can hit "Check for updates" in the tray).

**Do NOT** tag a version that does not match `package.json`'s `version` field.
electron-updater compares against `package.json` baked into the installed app;
mismatches cause confusing "no update found" / "update available" loops.

---

## 4. Versioning going forward (semver)

Check the current `version` in `package.json` and bump it BEFORE tagging. The
tag is just `v<that-version>`.

| Change kind                                     | Bump   | Example                |
| ----------------------------------------------- | ------ | ---------------------- |
| Bug fix in existing behavior                    | PATCH  | `1.0.0` -> `1.0.1`     |
| New feature, backwards compatible               | MINOR  | `1.0.1` -> `1.1.0`     |
| Breaking change (config format, removed feature)| MAJOR  | `1.1.0` -> `2.0.0`     |

Rough mapping for this project:

- Overlay tweak, statfeed bug, reconnect fix -> PATCH
- New tray menu item, new overlay widget, new control panel field -> MINOR
- `DefaultStatsAPI.ini` schema change that breaks existing installs, drop a
  WebSocket port, rename a stored setting -> MAJOR

Pre-1.0 (which is past us now) would have been the time to break things freely.
From here, treat every release as live.

---

## 5. Pre-tag smoke test (lightweight)

Before pushing a release tag, the minimum check that's worth doing:

```bash
npm install
npm run mock                # launches Electron with fake match data
```

Then in OBS or a browser:
- Open `http://localhost:49080/overlays/rivalry-gameplay/index.html` -> scorebar,
  boost, statfeed, goal banner should render and update.
- Open `http://localhost:49080/` (redirects to the control panel) -> set team
  names/logos, watch them push to the overlay.
- Check the tray: control panel opens, both "Copy URL" items work, "Open
  replays folder" works (or fails cleanly if no replays yet), "Check for
  updates" is a no-op in dev (expected, see section 2), "Start with Windows"
  toggles cleanly.

Heavier option: drive the same flow through Playwright (see section 6).

---

## 6. Dev tooling installed this session

### Playwright (Python)

- Already on the machine at
  `C:\Users\Cookies\AppData\Roaming\Python\Python314\site-packages\` (1.59.0).
- Chromium browser binary downloaded this session.
- The CLI shim `playwright.exe` is NOT on PATH. Always invoke via
  `python -m playwright ...`. Verified working with a smoke test.

```powershell
# correct usage (always)
python -m playwright install chromium
python -m playwright --help
```

### OBS MCP (dev-only)

[`.mcp.json`](.mcp.json) at the repo root registers
[`obs-mcp`](https://www.npmjs.com/package/obs-mcp) so dev tooling can
drive your local OBS during development (switch scenes, add browser
sources, refresh sources after editing overlay HTML).

Setup, once:

1. In OBS: Tools -> WebSocket Server Settings -> Enable -> set a password.
2. Set the password in your shell profile:
   ```powershell
   $env:OBS_WEBSOCKET_PASSWORD = "<your-password>"
   ```
3. Restart your editor / MCP host so the server attaches.

End-users never see this. The MCP is dev-time only, not the shipped app.

---

## 6.5 OBS integration in the shipped app (new)

Producers can now connect RIVALRY Casterverse to OBS via obs-websocket from
the control panel ("OBS INTEGRATION" card). Once enabled and connected:

- **"Build RIVALRY scene collection"** (also surfaced in the setup wizard as
  **SET UP OBS FOR ME**) builds the full scene collection over obs-websocket
  with no password typing: all scenes pre-wired as 1920x1080 Browser Sources,
  the chrome layered on top, and the game capture pre-scaled into the chrome's
  interior window. Idempotent (safe to re-run; existing scenes/sources are
  left alone).
- **Auto-switch toggle** (OFF by default) maps three triggers to scene names:
  - `GoalReplayStart` -> "Replay scene"
  - `GoalReplayEnd` / `CountdownBegin` / `RoundStarted` -> "Live scene"
  - First `UpdateState` after `Game.Winner` populates -> "Post-match scene"
  Unmapped (blank) triggers silently do nothing. Producers can flip the
  master toggle off mid-broadcast without losing their scene-name config.
- **Settings persist** to `<userData>/obs-settings.json`. The connection
  starts disabled on first launch so existing installs aren't surprised.

Implementation:
- [`bridge/obs-controller.js`](bridge/obs-controller.js) - obs-websocket-js
  wrapper with auto-reconnect, status events, idempotent scene templating.
- [`bridge/obs-settings.js`](bridge/obs-settings.js) - disk persistence.
- [`bridge/rl-bridge.js`](bridge/rl-bridge.js) - now exposes `events`
  EventEmitter so the main process can observe game + control traffic.
- [`main.js`](main.js) - wires controller lifecycle, settings load/save,
  tray status row, "Set up OBS scenes" action, auto-scene-switch handler.

The match-end concern is resolved: match end is driven by the real
`MatchEnded` / `PodiumStart` events, verified against live captures. The old
Winner-field heuristic worry no longer applies.

---

## 6.6 Dev mode broken without env tweak

`npm run mock` and `npm start` crash inside `electron-updater` if the shell
env var `ELECTRON_RUN_AS_NODE=1` is set (it makes `require('electron')`
return a path string, so `app` is undefined everywhere). VS Code's
integrated terminal can set this in some configurations.

Workarounds:

```bash
env -u ELECTRON_RUN_AS_NODE npm run mock          # bash
```

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE; npm run mock  # PowerShell
```

A more permanent fix would be to lazy-require `electron-updater` only when
`app.isPackaged`. Already applied in [main.js](main.js): `getAutoUpdater()`
defers the require past app-init. That alone is enough; the env workaround
is for any future early-required Electron-only deps.

---

## 6.7 Beta build channel (test installs alongside prod)

Two co-existing installs on the same machine:

|                          | Production                                                 | Beta                                                             |
| ------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------- |
| `appId`                  | `gg.rivalry.casterverse`                                   | `gg.rivalry.casterverse.beta`                                    |
| Windows app name         | RIVALRY Casterverse                                            | RIVALRY Casterverse Beta                                             |
| Tray + window title      | RIVALRY Casterverse                                            | RIVALRY Casterverse (BETA)                                           |
| Installer file           | `RIVALRY-Casterverse-Setup-${version}.exe`                     | `RIVALRY-Casterverse-Beta-Setup-${version}.exe`                      |
| Settings folder          | `%AppData%\RIVALRY Casterverse\`                               | `%AppData%\RIVALRY Casterverse Beta\`                                |
| Where the installer comes from | Tag push -> [release.yml](.github/workflows/release.yml) | Every PR -> [pr-build.yml](.github/workflows/pr-build.yml) artifact |
| Auto-updater             | On, stable channel                                         | Off (each PR build is throwaway)                                 |

Build configs live in [electron-builder.prod.js](electron-builder.prod.js) (prod) and
[electron-builder.beta.js](electron-builder.beta.js) (beta).

### One-time note: the RIVALRY Casterverse rename (historical; landed in 153f8ff)

The app was renamed from "RIVALRY Overlay" to **RIVALRY Casterverse**, which
changes the Windows `appId`. Windows treats a new appId as a different program,
so an installed pre-rename build is **not** upgraded in place and the updater
will not offer the renamed build to it:

- Anyone running an older install should uninstall it once, then install the
  renamed build. Two installs otherwise fight over ports 49080 / 49124 / 49777
  (the app shows a port-conflict dialog when that happens).
- Their settings are preserved: on first launch the renamed app copies
  `control-state.json`, `obs-settings.json`, `league-settings.json`,
  `dev-settings.json`, the setup marker and `user-assets/` out of the old
  `%AppData%\rivalry-overlay\` (or `%AppData%\RIVALRY Overlay Beta\`) folder.
  See [bridge/userdata-migrate.js](bridge/userdata-migrate.js).
- OBS scenes are untouched, but the app now builds into a scene collection
  named **RIVALRY Casterverse**. The old "RIVALRY Overlays" collection is left
  in place; delete it in OBS once the new one is confirmed working.

### Building locally

```powershell
$env:ELECTRON_RUN_AS_NODE = $null
npm run dist          # prod installer -> dist\
npm run dist:beta     # beta installer -> dist-beta\
```

### Downloading the beta installer from a PR

1. Open the PR on GitHub.
2. The "PR Build (Beta installer)" workflow runs automatically. The bot
   leaves a comment on the PR with a link once the build finishes (~5 min).
3. Click through to the Actions run, scroll to "Artifacts", download the
   `rivalry-casterverse-beta-<sha>` zip. Inside is the `.exe` installer.
4. Install. The first run scaffolds its own settings folder, totally
   separate from the production install.

### When to use which

- **Testing a PR yourself:** beta install. Lets you keep using the production
  install for real broadcasts while a PR is in flight.
- **Pushing a fix you trust:** merge to main, tag, prod installer auto-builds.
- **Sharing a test build with a caster:** out of scope of beta CI artifacts
  (artifacts are only visible to people with repo access). Cut a GitHub
  prerelease tag for those, e.g. `v1.1.0-rc1`. See section 7 for the
  prerelease/code-signing discussion.

---

## 6.8 Handing out (and taking back) access keys

> **RETIRED 2026-08-11.** The access-key system was removed: the league API key
> plus the match-only gate is the product's entitlement now. This section stays
> as the record of how the RCV1 system worked while it existed; the key CLIs,
> license modules, revocation list and activation UI are gone from the tree
> (git history has them if it ever needs to come back).

The packaged app served overlay scenes only to someone holding a valid access
key. Everything was driven from this repo - there was no service to run.

```bash
npm run key:issue -- --name "Moldybanana"          # mint one, send them the line it prints
npm run key:issue -- --name "Yami" --tier producer # tiers: caster | producer | staff | dev
npm run key:list                                   # who holds what, and what is revoked
npm run key:revoke -- --name "Moldybanana"         # withdraw access
npm run key:revoke -- --name "Moldybanana" --undo  # give it back
npm run key:verify -- RCV1....                     # "is this key still good?" - same answer the app gives
```

**Keys do not expire** unless you pass `--expires 2026-12-31`. Withdrawal is by
revocation, not by expiry date.

### How revocation reaches installs

`key:revoke` rewrites `config/casterverse-revoked.json`, a **signed** list of
withdrawn key ids. Publishing it is a `git push` - installs fetch it from the
repo's raw URL on launch and every 6 hours.

Because the list is signed with the same private key as the access keys, it
cannot be forged or edited by whoever hosts it. That means it could live anywhere:
the repo (default, free, nothing to run), a static file on a self-hosted box, an
object store. Moving it meant changing the `REVOCATION_URL` constant in main.js
(removed with the retirement), or setting `RIVALRY_REVOCATION_URL` for a one-off
test. **You did not need to run a server**; a service would add an outage mode to
a broadcast tool for no benefit.

Design notes worth not undoing:

- **Fails open.** If the list can't be fetched, the last known-good one stands.
  This runs on machines that are mid-broadcast; a DNS blip must never black out
  someone's overlays. The cost is that a revoked holder who stays offline keeps
  working - accepted, and they'd lose live league data anyway.
- **No rollback.** A fetched list is only adopted if it is at least as new as
  the one already trusted, so an old (genuinely signed) list can't be replayed to
  un-revoke someone.
- **Three sources, newest wins:** the copy that shipped in the build, the last
  one successfully fetched (cached in userData), and a fresh fetch.

`keys/issued-keys.json` was the record of who holds which key id. It was
gitignored (real names) and it was what `key:list` and `key:revoke` read - back
it up alongside the private key if the system ever comes back.

---

## 7. Open decisions / next moves

- [ ] **Do a packaged-build smoke test before tagging v1.0.0?** Options:
  - Run `npm run pack`, click through `dist\win-unpacked\RIVALRY Casterverse.exe`,
    then tag. Safer.
  - Just tag and let CI build. Faster. If broken, yank the release and tag
    `v1.0.1` (you cannot reuse a tag).
- [ ] **Code signing.** Currently unsigned. SmartScreen will warn on first run
  ("More info" -> "Run anyway"). Acceptable for an indie tool. To remove:
  buy a code-signing cert and add `win.certificateFile` /
  `certificatePassword` to `electron-builder.prod.js`. Skip unless casters
  complain.
- [ ] **Set up a CHANGELOG.md** before v1.0.0 so the first release has real
  notes, not a default GitHub blob.
- [ ] **Confirm the GitHub Actions `release.yml` works end-to-end** by tagging
  a throwaway prerelease first if you want belt-and-braces, e.g. `v0.9.0-rc1`.
  Optional.

---

## 8. Gotchas to remember

- **Direct push to `main` is blocked.** Always go feat branch + PR.
  Squash-merge is the default that worked here.
- **`package.json` version and git tag must match.** Bump first, commit,
  THEN tag.
- **The auto-updater is silent in dev.** Don't try to "test" it from
  `npm start`; the `app.isPackaged` guard short-circuits it.
- **If you tag a broken build, you cannot reuse the tag.** Yank the GitHub
  Release, fix the code, bump to the next patch, tag again. (Force-pushing a
  tag is technically possible but `electron-updater` clients that already
  fetched the old `latest.yml` may get into a confused state.)
- **Playwright CLI is not on PATH.** Always `python -m playwright`, never
  bare `playwright`.
