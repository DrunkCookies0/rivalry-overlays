# Handoff: shipping state, auto-updater, dev tooling (session of 2026-05-23)

A handoff for whoever picks up next (me, future Claude, or Alex). Covers the
current release state, exactly what the auto-updater will and will not do, the
ritual for cutting a tag, what was installed locally this session, and the open
decisions still on the table.

---

## 1. TL;DR current state

| Thing                                 | State                                                                |
| ------------------------------------- | -------------------------------------------------------------------- |
| Repo                                  | github.com/DrunkCookies0/rivalry-overlays (default branch: `main`)   |
| `main` HEAD                           | `34b6fb2` (squash merge of PR #1: the actual app + docs)             |
| `package.json` version                | `1.0.0` (unbumped, never tagged)                                     |
| Git tags                              | NONE                                                                 |
| GitHub Releases                       | NONE                                                                 |
| CI release workflow runs              | NEVER fired (only a Copilot review run exists)                       |
| Installer published anywhere          | NO                                                                   |
| Auto-updater in code                  | Wired, but inert until a Release exists with `latest.yml`            |
| Code signing                          | NOT configured (SmartScreen will warn on first run)                  |
| Local dev tooling added this session  | Playwright + Chromium, 3 Claude skills (see section 6)               |

Bottom line: nothing has shipped yet. The first thing pushed up as `v1.0.0` will
be the actual first release. The auto-updater code already in `main.js` only
matters AFTER the first installer is published.

---

## 2. How the auto-updater actually works

Code lives in [main.js:158-169](main.js#L158-L169) (`setupAutoUpdate()`).

- Runs ONLY when `app.isPackaged === true`. `npm start` / `npm run mock` skip
  it silently, no log, no error. This is intentional (no update feed in dev).
- Uses `electron-updater` with the `github` provider from `package.json`
  (`owner: DrunkCookies0`, `repo: rivalry-overlays`, `releaseType: release`).
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
# launch dist\win-unpacked\RIVALRY Overlay.exe and click through

# 2. tag and push - this is the one step that actually ships
git tag v1.0.0
git push origin v1.0.0
```

That tag push triggers `.github/workflows/release.yml`, which on
`windows-latest`:
1. `npm install`
2. `npm run release` (`electron-builder --win --publish always`)
3. Uploads `RIVALRY-Overlay-Setup-1.0.0.exe` AND `latest.yml` AND a `.blockmap`
   to a new GitHub Release `v1.0.0`, using the workflow's `GITHUB_TOKEN`.

Once that Release exists, any installed copy of the app on the planet will
pick it up at next launch (or the user can hit "Check for updates" in the tray).

**Do NOT** tag a version that does not match `package.json`'s `version` field.
electron-updater compares against `package.json` baked into the installed app;
mismatches cause confusing "no update found" / "update available" loops.

---

## 4. Versioning going forward (semver)

`package.json` is currently `1.0.0`. Bump it BEFORE tagging. The tag is just
`v<that-version>`.

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
- Open `http://localhost:49080/overlay/overlay.html` -> scorebar, boost,
  statfeed, goal banner should render and update.
- Open `http://localhost:49080/control/control.html` -> set team names/logos,
  watch them push to the overlay.
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

### Claude Code skills (user-global, at `D:\Repositories\.claude\skills\`)

| Skill                | Purpose for this project                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `webapp-testing`     | Drive Chromium against `localhost:49080` overlay/control, screenshot, watch console errors.         |
| `changelog-generator`| Read `git log` between two refs, draft a release-notes block. Use on every tag.                     |
| `code-reviewer`      | Structured review of a diff using 6 reference checklists. Use before pushing release tags.          |

Skills do NOT hot-load mid-conversation. After installing them this session,
Claude Code probably needs a restart before they show up as invocable.

### OBS MCP (dev-only)

[`.mcp.json`](.mcp.json) at the repo root registers [`obs-mcp`](https://www.npmjs.com/package/obs-mcp)
so Claude Code can drive your local OBS during development (switch scenes,
add browser sources, refresh sources after editing overlay HTML).

Setup, once:

1. In OBS: Tools -> WebSocket Server Settings -> Enable -> set a password.
2. Set the password in your shell profile:
   ```powershell
   $env:OBS_WEBSOCKET_PASSWORD = "<your-password>"
   ```
3. Restart Claude Code so it attaches the new MCP server.
4. Verify: ask Claude to "list OBS scenes."

End-users never see this. The MCP is for Claude<->OBS, not the shipped app.

---

## 6.5 OBS integration in the shipped app (new)

Producers can now connect the RIVALRY Overlay to OBS via obs-websocket from
the control panel ("OBS INTEGRATION" card). Once enabled and connected:

- **"Create OBS scene"** button creates a `RIVALRY - Live` scene with the
  overlay URL pre-wired as a 1920x1080 Browser Source. Idempotent (safe to
  re-run; existing scenes/sources are left alone).
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

The match-end heuristic (Winner field) is unverified against real RL data.
Test against a real match before relying on it for a live broadcast.

---

## 6.6 Dev mode broken without env tweak

`npm run mock` and `npm start` crash inside `electron-updater` if the shell
env var `ELECTRON_RUN_AS_NODE=1` is set (it makes `require('electron')`
return a path string, so `app` is undefined everywhere). This var is set
inside the VS Code terminal + Claude Code's bash harness on this machine.

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

## 7. Open decisions / next moves

- [ ] **Do a packaged-build smoke test before tagging v1.0.0?** Options:
  - Run `npm run pack`, click through `dist\win-unpacked\RIVALRY Overlay.exe`,
    then tag. Safer.
  - Just tag and let CI build. Faster. If broken, yank the release and tag
    `v1.0.1` (you cannot reuse a tag).
- [ ] **Code signing.** Currently unsigned. SmartScreen will warn on first run
  ("More info" -> "Run anyway"). Acceptable for an indie tool. To remove:
  buy a code-signing cert and add `win.certificateFile` /
  `certificatePassword` to `build` in `package.json`. Skip unless casters
  complain.
- [ ] **Set up a CHANGELOG.md** before v1.0.0 so the first release has real
  notes, not a default GitHub blob. The `changelog-generator` skill is
  installed for this.
- [ ] **Confirm the GitHub Actions `release.yml` works end-to-end** by tagging
  a throwaway prerelease first if you want belt-and-braces, e.g. `v0.9.0-rc1`.
  Optional.

---

## 8. Gotchas to remember

- **Direct push to `main` is blocked** by Alex's Claude Code deny rules.
  Always go feat branch + PR. Squash-merge is the default that worked here.
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
- **PowerShell is on Alex's deny list for Claude Bash.** Use bash with POSIX
  syntax when running things on his behalf.
- **`AUTO-UPDATE-HANDOFF.md` references repo `rivalry-broadcaster`.** That
  was an earlier working name; the real repo is `rivalry-overlays`. The
  shipped `package.json` is correct (`owner: DrunkCookies0`,
  `repo: rivalry-overlays`). Don't trust the old handoff on that one point.
