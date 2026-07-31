/* =============================================================================
 * Beta build config — NSIS target with the same channel/auto-update setup
 * as production, just published as prereleases under the 'beta' channel.
 *
 * Reverted from Squirrel.Windows because electron-updater doesn't support
 * Squirrel — see the comment in electron-builder.js for the full reasoning.
 *
 * Side-by-side install (different appId / productName / install dir /
 * userData) keeps the beta out of the production app's way. Each PR push
 * publishes a GitHub prerelease so installed betas auto-update via
 * electron-updater (allowPrerelease + channel='beta' in main.js).
 * ===========================================================================*/

"use strict";

module.exports = {
  appId: "gg.rivalry.casterverse.beta",
  productName: "RIVALRY Casterverse Beta",
  directories: { output: "dist-beta" },
  files: [
    "main.js",
    "bridge/**/*",
    "overlay/**/*",
    "control/**/*",
    "config/**/*",
    "assets/**/*",
    // Multi-scene overlay system: ship scenes + sdk + shared + the PUBLIC key.
    "overlays/**/*",
    "!overlays/keys/*-private.pem", // NEVER ship the signing private key
    "!overlays/_template/**/*", // authoring starter, not a real scene
    "!overlays/_prototype-*.html", // throwaway design galleries
    "!overlays/_prototype-assets/**/*", // screenshots backing the galleries
    "!overlays/**/*.md", // authoring docs (CONTRACT / MANIFEST-SPEC / README)
  ],
  extraMetadata: {
    name: "rivalry-casterverse-beta",
    productName: "RIVALRY Casterverse Beta",
    ...(process.env.BUILD_VERSION ? { version: process.env.BUILD_VERSION } : {}),
    ...(process.env.BUILD_SHA ? { buildSha: process.env.BUILD_SHA } : {}),
  },
  win: {
    target: ["nsis"],
    icon: "build/icon.ico",
    artifactName: "RIVALRY-Casterverse-Beta-Setup-${version}.${ext}",
  },
  nsis: {
    oneClick: true,                       // silent install, no wizard
    perMachine: false,                    // per-user, no admin / UAC
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "RIVALRY Casterverse Beta",
    installerIcon: "build/icon.ico",
    uninstallerIcon: "build/icon.ico",
    deleteAppDataOnUninstall: false,
  },
  publish: [
    {
      provider: "github",
      owner: "DrunkCookies0",
      repo: "rivalry-overlays",
      releaseType: "prerelease",
      vPrefixedTagName: true,
      channel: "beta",                    // writes beta.yml instead of latest.yml
    },
  ],
};
