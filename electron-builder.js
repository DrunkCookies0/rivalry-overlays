/* =============================================================================
 * Production build config — NSIS target (not Squirrel.Windows).
 *
 * Why NSIS, not Squirrel: electron-updater's update flow only supports
 * NSIS / AppImage / DMG. Squirrel.Windows builds don't write the
 * `app-update.yml` file electron-updater needs to find the channel, so
 * the auto-updater dies with ENOENT on every check. NSIS works cleanly:
 *   - Differential updates via .blockmap. The updater downloads only the
 *     changed bytes, not the full 75MB installer.
 *   - oneClick: true means the installer runs without a wizard — a brief
 *     loader appears, app installs, app starts. Near-silent UX without
 *     giving up updater compatibility.
 *   - perMachine: false = per-user install into %LocalAppData%. No admin
 *     prompt, no UAC.
 *
 * JS form (not YAML) so CI can inject BUILD_SHA via env without fighting
 * PowerShell's `-c.extraMetadata.foo=bar` tokenization.
 * ===========================================================================*/

"use strict";

module.exports = {
  appId: "gg.rivalry.overlay",
  productName: "RIVALRY Overlay",
  directories: { output: "dist" },
  files: [
    "main.js",
    "bridge/**/*",
    "overlay/**/*",
    "control/**/*",
    "config/**/*",
    "assets/**/*",
  ],
  // CI sets BUILD_SHA so the tray + control panel show "v0.2.2 (a3b9c1d)"
  // instead of "v0.2.2 (dev)". Local dev builds skip it and show "dev".
  extraMetadata: {
    ...(process.env.BUILD_SHA ? { buildSha: process.env.BUILD_SHA } : {}),
  },
  win: {
    target: ["nsis"],
    icon: "build/icon.ico",
    artifactName: "RIVALRY-Overlay-Setup-${version}.${ext}",
  },
  nsis: {
    oneClick: true,                       // silent install, no wizard
    perMachine: false,                    // per-user, no admin / UAC
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "RIVALRY Overlay",
    installerIcon: "build/icon.ico",
    uninstallerIcon: "build/icon.ico",
    deleteAppDataOnUninstall: false,      // preserve OBS settings + auth token
  },
  publish: [
    {
      provider: "github",
      owner: "DrunkCookies0",
      repo: "rivalry-overlays",
      releaseType: "release",
    },
  ],
};
