/* =============================================================================
 * RIVALRY control-state persistence: load/save <userData>/control-state.json
 * -----------------------------------------------------------------------------
 * The control bus retains the last `type:"control"` message in memory so a
 * freshly-loaded overlay never renders blank. This module persists that same
 * message across app restarts, so a producer's typed-in branding (team names,
 * logos, series, casters, bracket) survives a relaunch mid-event.
 *
 * Stored as the raw message TEXT (not a parsed object) because the bridge
 * retains and replays the exact wire bytes; round-tripping through JSON.parse
 * could reorder/renormalise and this keeps load() -> ws.send() byte-faithful.
 * ===========================================================================*/

"use strict";

const fs = require("fs");

// Returns the retained message text, or null when the file is missing,
// unreadable, or doesn't hold a valid `type:"control"` message (a corrupt
// file must never take the bridge down at boot).
function load(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(text);
    if (parsed && parsed.type === "control" && parsed.payload) return text;
    return null;
  } catch {
    return null;
  }
}

function save(file, text) {
  try {
    fs.writeFileSync(file, text, "utf8");
    return true;
  } catch (e) {
    console.error("[rivalry] could not save control-state:", e.message);
    return false;
  }
}

// Debounced saver: control pushes fire on every keystroke in the panel, so
// writing on each one would hammer the disk. Trailing-edge debounce is fine
// here — losing the last <750ms of typing to a hard crash is acceptable.
function createSaver(file, delayMs = 750) {
  let timer = null;
  let pending = null;
  return function scheduleSave(text) {
    pending = text;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (pending !== null) save(file, pending);
      pending = null;
    }, delayMs);
  };
}

module.exports = { load, save, createSaver };
