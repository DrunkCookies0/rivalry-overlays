/* =============================================================================
 * OBS settings store tests (bridge/obs-settings.js)
 * -----------------------------------------------------------------------------
 * publicView is what the main process puts on the control bus, which every
 * overlay page also listens to: the OBS password must never be in it.
 * ===========================================================================*/

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { publicView, DEFAULTS } = require("../bridge/obs-settings");

test("publicView drops the password and says whether one is saved", () => {
  const saved = { ...DEFAULTS, password: "hunter2", sceneMap: { ...DEFAULTS.sceneMap, live: "RIVALRY - Live" } };
  const view = publicView(saved);
  assert.equal("password" in view, false);
  assert.equal(view.hasPassword, true);
  assert.equal(view.sceneMap.live, "RIVALRY - Live");
  assert.equal(view.enabled, saved.enabled);
  assert.equal(saved.password, "hunter2", "the stored settings are not mutated");
});

test("publicView reports no password when none is saved", () => {
  assert.equal(publicView({ ...DEFAULTS, password: "" }).hasPassword, false);
  assert.equal(publicView(null).hasPassword, false);
});

test("nothing in the public view serializes the password", () => {
  const view = publicView({ ...DEFAULTS, password: "hunter2" });
  assert.equal(JSON.stringify(view).includes("hunter2"), false);
});
