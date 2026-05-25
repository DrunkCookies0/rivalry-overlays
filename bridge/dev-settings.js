/* =============================================================================
 * RIVALRY Dev Settings: persists the dev-mode HTTP root override
 * -----------------------------------------------------------------------------
 * Only used when the dev-mode tray toggle is exposed (i.e. running unpacked or
 * with RIVALRY_DEV=1 in the environment). Stores:
 *   { enabled: bool, path: string }
 * If enabled and `path` points at an existing directory, main.js swaps the
 * static-file HTTP root to it on startup so overlay edits in the local repo go
 * live for OBS without a reinstall.
 * ===========================================================================*/

"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULTS = { enabled: false, path: "" };

function settingsPath(userDataDir) {
  return path.join(userDataDir, "dev-settings.json");
}

function load(userDataDir) {
  try {
    const raw = fs.readFileSync(settingsPath(userDataDir), "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(userDataDir, settings) {
  try {
    fs.writeFileSync(
      settingsPath(userDataDir),
      JSON.stringify(settings, null, 2),
      "utf8"
    );
    return true;
  } catch (e) {
    console.error("[rivalry] could not save dev-settings:", e.message);
    return false;
  }
}

module.exports = { load, save, DEFAULTS };
