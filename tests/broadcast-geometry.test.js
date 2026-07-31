/* The safe-area constant lives in two files by necessity (Node bridge vs
 * static browser overlays share no module system). These tests are the only
 * thing stopping the two copies from drifting apart, and they pin the one
 * property the whole chrome design depends on: the interior stays exactly
 * 16:9 so the game capture scales in with no letterboxing and no cropping. */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const bridgeGeo = require("../bridge/broadcast-geometry");

function loadBrowserGeometry() {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "overlays", "shared", "rivalry-geometry.js"),
    "utf8"
  );
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox);
  return sandbox.window.RivalryGeometry;
}

test("browser copy exists and exposes RivalryGeometry", () => {
  const geo = loadBrowserGeometry();
  assert.ok(geo, "overlays/shared/rivalry-geometry.js must set window.RivalryGeometry");
  for (const k of ["CANVAS", "RAIL_WIDTH", "TICKER_HEIGHT", "SAFE_AREA"]) {
    assert.ok(k in geo, `missing key ${k}`);
  }
});

test("bridge and browser copies carry identical values", () => {
  const geo = loadBrowserGeometry();
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(geo)),
    JSON.parse(JSON.stringify(bridgeGeo)),
    "bridge/broadcast-geometry.js and overlays/shared/rivalry-geometry.js drifted; edit both"
  );
});

test("safe area is exactly 16:9 and derived from rails + ticker", () => {
  const { CANVAS, RAIL_WIDTH, TICKER_HEIGHT, SAFE_AREA } = bridgeGeo;
  assert.strictEqual(SAFE_AREA.x, RAIL_WIDTH);
  assert.strictEqual(SAFE_AREA.y, 0);
  assert.strictEqual(SAFE_AREA.width, CANVAS.width - 2 * RAIL_WIDTH);
  assert.strictEqual(SAFE_AREA.height, CANVAS.height - TICKER_HEIGHT);
  // 16:9 exactness is the no-letterbox, no-crop guarantee.
  assert.strictEqual(
    SAFE_AREA.width * 9,
    SAFE_AREA.height * 16,
    "safe area must stay exactly 16:9; keep tickerHeight = railWidth * 1.125"
  );
});

test("safe-area scale relative to canvas is a clean uniform factor", () => {
  const { CANVAS, SAFE_AREA } = bridgeGeo;
  const sx = SAFE_AREA.width / CANVAS.width;
  const sy = SAFE_AREA.height / CANVAS.height;
  assert.ok(Math.abs(sx - sy) < 1e-9, "horizontal and vertical scale must match");
});
