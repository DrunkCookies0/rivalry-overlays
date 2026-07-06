/* =============================================================================
 * RIVALRY league settings: load/save to <userData>/league-settings.json
 * -----------------------------------------------------------------------------
 * Mirrors obs-settings.js: league-client.js stays purely transport and this
 * file owns disk persistence. Returns sensible defaults when the file is
 * missing or corrupt so the first launch never errors out.
 *
 * SECURITY: the apiKey lives ONLY in <userData>/league-settings.json — never
 * in the repo, never in logs, never in error messages. Anything that shows
 * connection status must go through mask() so the raw key can't end up in a
 * screenshot or a pasted bug report.
 * ===========================================================================*/

"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  apiKey: "",
  baseUrl: "https://therivalry.gg",
  // Mock mode serves spec-verbatim fixtures from config/league-fixtures/ so
  // the whole league flow can be built and demoed before the match endpoints
  // exist on the backend (they are specced but not live yet).
  mock: false,
};

function settingsPath(userDataDir) {
  return path.join(userDataDir, "league-settings.json");
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
    // e.message only — never the settings object (it contains the key)
    console.error("[rivalry] could not save league-settings:", e.message);
    return false;
  }
}

// For status displays only: "" stays "", anything else shows just the last
// 4 chars behind bullets so a producer can confirm WHICH key is loaded
// without the key itself ever being rendered.
function mask(key) {
  if (!key) return "";
  return "••••" + String(key).slice(-4);
}

module.exports = { load, save, mask, DEFAULTS };
