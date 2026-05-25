/* =============================================================================
 * Beta build config (JS form so CI can inject version + sha via env vars
 * without dealing with PowerShell tokenizing "-c.extraMetadata.foo=bar"
 * args on the dot — which silently broke every CI build between 21:30
 * and 22:19 UTC on 2026-05-24).
 *
 * Builds a side-by-side install (separate appId / install dir / userData)
 * so testing a PR build never disturbs the production install. Published
 * to GitHub as a prerelease per PR push so the installed beta auto-updates
 * via electron-updater (main.js sets allowPrerelease=true on beta).
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
  // extraMetadata is written into the BUILT package.json. Forces app.getName()
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
    target: ["nsis"],
    icon: "build/icon.ico",
    artifactName: "RIVALRY-Overlay-Beta-Setup-${version}.${ext}",
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "RIVALRY Overlay Beta",
    installerIcon: "build/icon.ico",
    uninstallerIcon: "build/icon.ico",
  },
  publish: [
    {
      provider: "github",
      owner: "DrunkCookies0",
      repo: "rivalry-overlays",
      releaseType: "prerelease",
      vPrefixedTagName: true,
      // Writes `beta.yml` to each release instead of `latest.yml`. The
      // updater (main.js sets autoUpdater.channel = 'beta' for IS_BETA)
      // reads from this channel via a URL pattern that doesn't go through
      // /releases/latest — which 404s on this repo because it has no
      // stable releases yet, only prereleases. Without this, the updater
      // can't find any newer builds at all.
      channel: "beta",
    },
  ],
};
