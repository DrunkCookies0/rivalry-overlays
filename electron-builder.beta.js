/* =============================================================================
 * Beta build config — Squirrel.Windows target.
 *
 * Squirrel gives us silent in-place updates (no installer dialog, no UAC,
 * just download a small .nupkg delta and swap files on next launch). For
 * the beta channel that's even more important because we push new builds
 * frequently and we don't want a producer to see an install wizard every
 * few hours.
 *
 * Side-by-side install (different appId / productName / install dir /
 * userData) keeps the beta out of the production app's way. Each PR push
 * publishes a GitHub prerelease so installed betas auto-update via
 * electron-updater (allowPrerelease + channel='beta' in main.js).
 *
 * JS form (not YAML) so CI can inject BUILD_VERSION + BUILD_SHA via env
 * vars instead of fragile "-c.extraMetadata.foo=bar" CLI args.
 * ===========================================================================*/

"use strict";

module.exports = {
  appId: "gg.rivalry.overlay.beta",
  productName: "RIVALRY Overlay Beta",
  directories: { output: "dist-beta" },
  files: [
    "main.js",
    "bridge/**/*",
    "overlay/**/*",
    "control/**/*",
    "config/**/*",
    "assets/**/*",
  ],
  // extraMetadata is written into the built package.json. Forces app.getName()
  // to return "RIVALRY Overlay Beta" at runtime; baked-in version + sha let
  // the tray + control panel show "v0.2.0-beta.N (a3b9c1d)". CI sets the env
  // vars; local `npm run dist:beta` falls back to defaults.
  extraMetadata: {
    name: "rivalry-overlay-beta",
    productName: "RIVALRY Overlay Beta",
    ...(process.env.BUILD_VERSION ? { version: process.env.BUILD_VERSION } : {}),
    ...(process.env.BUILD_SHA ? { buildSha: process.env.BUILD_SHA } : {}),
  },
  win: {
    target: ["squirrel"],
    icon: "build/icon.ico",
  },
  squirrelWindows: {
    // Squirrel requires the icon as a hosted URL (embedded into Setup.exe
    // + uninstall registry entry). Repo is public.
    iconUrl: "https://raw.githubusercontent.com/DrunkCookies0/rivalry-overlays/main/build/icon.ico",
    msi: false,
  },
  publish: [
    {
      provider: "github",
      owner: "DrunkCookies0",
      repo: "rivalry-overlays",
      releaseType: "prerelease",
      vPrefixedTagName: true,
      // Writes `beta.yml` (the channel manifest electron-updater fetches)
      // to each prerelease, separate from the stable channel's `latest.yml`.
      // main.js sets autoUpdater.channel = 'beta' for IS_BETA installs.
      channel: "beta",
    },
  ],
};
