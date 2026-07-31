/* =============================================================================
 * RivalryGeometry: the chrome safe area, browser-side copy
 * -----------------------------------------------------------------------------
 * The persistent chrome (left rail, right rail, bottom ticker) frames every
 * scene; the SAFE AREA is the interior window everything important must fit
 * inside. It is exactly 16:9 (1792 x 1008 at 64,0) so the game capture scales
 * in with no letterboxing and no cropping.
 *
 * MIRROR: bridge/broadcast-geometry.js is the Node-side copy of these values.
 * tests/broadcast-geometry.test.js fails the build if the two files drift.
 * ===========================================================================*/

(function () {
  "use strict";

  var CANVAS = { width: 1920, height: 1080 };
  var RAIL_WIDTH = 64; // each side
  var TICKER_HEIGHT = 72; // bottom, full width

  var SAFE_AREA = {
    x: RAIL_WIDTH,
    y: 0,
    width: CANVAS.width - 2 * RAIL_WIDTH, // 1792
    height: CANVAS.height - TICKER_HEIGHT, // 1008
  };

  window.RivalryGeometry = {
    CANVAS: CANVAS,
    RAIL_WIDTH: RAIL_WIDTH,
    TICKER_HEIGHT: TICKER_HEIGHT,
    SAFE_AREA: SAFE_AREA,
  };
})();
