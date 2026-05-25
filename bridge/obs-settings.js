/* =============================================================================
 * RIVALRY OBS settings: load/save to <userData>/obs-settings.json
 * -----------------------------------------------------------------------------
 * Lives next to obs-controller.js so the controller stays purely transport
 * and this file owns disk persistence. Returns sensible defaults when the
 * file is missing or corrupt so the first launch never errors out.
 * ===========================================================================*/

"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  // Default ON so the app auto-attempts an OBS connection on first launch
  // (OBS WebSocket is built into OBS 28+ and listens on 4455 by default).
  // Failed connects are silent — the tray still shows "OBS: connecting...".
  enabled: true,
  url: "ws://localhost:4455",
  password: "",
  // Scene names a producer maps via the control panel. Empty string means
  // "don't auto-switch on this trigger" - the controller skips the call.
  sceneMap: {
    live: "",
    goal: "",      // briefly cut to this scene when a goal scores so
                    // RL's in-game "X Scored" text never reaches the broadcast
    replay: "",
    postMatch: "",
  },
  autoSwitchEnabled: false, // master kill switch for auto scene changes
};

function settingsPath(userDataDir) {
  return path.join(userDataDir, "obs-settings.json");
}

function load(userDataDir) {
  try {
    const raw = fs.readFileSync(settingsPath(userDataDir), "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULTS,
      ...parsed,
      sceneMap: { ...DEFAULTS.sceneMap, ...(parsed.sceneMap || {}) },
    };
  } catch {
    return { ...DEFAULTS, sceneMap: { ...DEFAULTS.sceneMap } };
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
    console.error("[rivalry] could not save obs-settings:", e.message);
    return false;
  }
}

module.exports = { load, save, DEFAULTS };
