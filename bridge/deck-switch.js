/* =============================================================================
 * RIVALRY deck switcher
 * -----------------------------------------------------------------------------
 * The producer's scene deck cuts OBS under the chrome's branded wipe: wipe
 * first, switch once the panels cover the canvas, then let the sweep finish.
 *
 * Requests are serialized. A second click while a wipe was still running used
 * to restart the sweep from off-screen, so the first click's switch landed on
 * an uncovered canvas: a raw cut on air. Now:
 *   - a request for the scene already being switched to is dropped, so a
 *     double-click is one switch;
 *   - any other request waits for the running wipe to finish, and only the
 *     latest waiting one runs (a correction wins; a burst of clicks is one).
 *
 * Pure + injectable so it unit-tests without Electron or OBS.
 * ===========================================================================*/

"use strict";

// Mirrored from the chrome scenes (overlays/rivalry-chrome, rivalry-sc26-chrome):
// the panels cover the canvas ~450 ms into the sweep, and the wipe element
// clears at 1600 ms.
const WIPE_COVER_MS = 450;
const WIPE_TOTAL_MS = 1600;

// wipe():          broadcasts a chrome wipe; returns false when there is no
//                  chrome to wipe with (the switch then cuts straight away)
// switchScene(s):  the OBS switch; a rejection (unknown scene) is a no-op
function createDeckSwitcher({ wipe, switchScene, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let current = null; // scene the in-flight switch is going to
  let next = null; // latest request waiting for it

  async function run(scene) {
    current = scene;
    try {
      const wiped = wipe();
      if (wiped) await sleep(WIPE_COVER_MS);
      try { await switchScene(scene); } catch (e) { /* unknown scene -> no-op */ }
      if (wiped) await sleep(WIPE_TOTAL_MS - WIPE_COVER_MS);
    } finally {
      current = null;
      const n = next;
      next = null;
      if (n) run(n);
    }
  }

  return function request(scene) {
    if (!scene) return;
    if (current === null) return run(scene);
    next = scene === current ? null : scene;
  };
}

module.exports = { createDeckSwitcher, WIPE_COVER_MS, WIPE_TOTAL_MS };
