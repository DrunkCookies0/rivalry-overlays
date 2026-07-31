/* =============================================================================
 * Broadcast geometry: the chrome safe area, published as one constant
 * -----------------------------------------------------------------------------
 * The persistent chrome (left rail, right rail, bottom ticker) frames every
 * scene. What remains is the SAFE AREA: the interior window the game capture
 * and every scene layout must respect. Nothing important may render outside it.
 *
 * The interior is deliberately EXACTLY 16:9 so the game capture scales into it
 * with no letterboxing and no cropping. That holds whenever
 * tickerHeight = railWidth * 1.125 (because 2 rails eat width, one ticker eats
 * height, and 1920/1080 = 16/9). With rails 64 and ticker 72:
 *   safe area = 1792 x 1008 at (64, 0), which is 16:9.
 *
 * MIRROR: overlays/shared/rivalry-geometry.js carries the same values for the
 * browser side. There is no mechanism for sharing a constant between the Node
 * bridge and static overlay pages, so the value lives in exactly these two
 * files and tests/broadcast-geometry.test.js fails the build if they drift.
 * ===========================================================================*/

"use strict";

const CANVAS = Object.freeze({ width: 1920, height: 1080 });
const RAIL_WIDTH = 64; // each side
const TICKER_HEIGHT = 72; // bottom, full width

const SAFE_AREA = Object.freeze({
  x: RAIL_WIDTH,
  y: 0,
  width: CANVAS.width - 2 * RAIL_WIDTH, // 1792
  height: CANVAS.height - TICKER_HEIGHT, // 1008
});

module.exports = { CANVAS, RAIL_WIDTH, TICKER_HEIGHT, SAFE_AREA };
