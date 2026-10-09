/* =============================================================================
 * Deck switcher tests (bridge/deck-switch.js)
 * -----------------------------------------------------------------------------
 * The bug these pin: a deck double-click sent two wipes 0.2 s apart; the
 * chrome restarted its sweep from off-screen on the second, and the first
 * click's OBS switch landed 450 ms after the FIRST wipe, on a canvas the
 * restarted sweep had not covered yet: a raw cut on air.
 * ===========================================================================*/

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createDeckSwitcher, WIPE_COVER_MS, WIPE_TOTAL_MS } = require("../bridge/deck-switch");

// Instant sleeps that record their length, so the order of wipes, waits and
// switches is the assertion.
function harness({ chrome = true, failOn = null } = {}) {
  const log = [];
  const request = createDeckSwitcher({
    wipe: () => { if (chrome) log.push("wipe"); return chrome; },
    switchScene: async (s) => { log.push("switch " + s); if (s === failOn) throw new Error("unknown scene"); },
    sleep: async (ms) => { log.push("sleep " + ms); },
  });
  return { log, request };
}
const settle = () => new Promise((r) => setImmediate(r));
async function drain() { for (let i = 0; i < 20; i++) await settle(); }

const ONE = (s) => ["wipe", "sleep " + WIPE_COVER_MS, "switch " + s, "sleep " + (WIPE_TOTAL_MS - WIPE_COVER_MS)];

test("a single click wipes, switches under the cover, then lets the sweep finish", async () => {
  const { log, request } = harness();
  request("RIVALRY - Live");
  await drain();
  assert.deepEqual(log, ONE("RIVALRY - Live"));
});

test("a double-click on the same scene is one wipe and one switch", async () => {
  const { log, request } = harness();
  request("RIVALRY - Live");
  request("RIVALRY - Live");
  await drain();
  assert.deepEqual(log, ONE("RIVALRY - Live"));
});

test("a different scene waits for the running wipe to finish", async () => {
  const { log, request } = harness();
  request("RIVALRY - Casters");
  request("RIVALRY - Live");
  await drain();
  assert.deepEqual(log, [...ONE("RIVALRY - Casters"), ...ONE("RIVALRY - Live")]);
});

test("a burst of clicks runs the in-flight one, then only the latest", async () => {
  const { log, request } = harness();
  request("A");
  request("B");
  request("C");
  request("D");
  await drain();
  assert.deepEqual(log, [...ONE("A"), ...ONE("D")]);
});

test("clicking back to the in-flight scene cancels the waiting one", async () => {
  const { log, request } = harness();
  request("A");
  request("B");
  request("A");
  await drain();
  assert.deepEqual(log, ONE("A"));
});

test("without the chrome the switch is immediate and nothing waits", async () => {
  const { log, request } = harness({ chrome: false });
  request("A");
  await drain();
  assert.deepEqual(log, ["switch A"]);
});

test("an unknown scene does not wedge the queue", async () => {
  const { log, request } = harness({ failOn: "Nope" });
  request("Nope");
  request("A");
  await drain();
  assert.deepEqual(log, [...ONE("Nope"), ...ONE("A")]);
  request("B");
  await drain();
  assert.deepEqual(log.slice(-4), ONE("B"), "still accepts clicks afterwards");
});
