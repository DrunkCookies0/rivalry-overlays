/* Tests for RivalryBind's empty-field rule.
 *
 * The bug this pins: a scene's markup carries design placeholder text ("NA",
 * "12-3") so it looks complete while being designed. On air, a field the
 * producer left blank was still showing that placeholder — a 3v3 Europe match
 * broadcast "NA" region tags. Clearing every blank field instead deleted the
 * league wordmark, which the control feed never sends. The rule has to tell
 * those two apart. */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// The SDK is browser code; run it against a tiny DOM stub rather than pulling
// in a headless browser for what is pure string logic.
function makeEl(field, text) {
  return {
    _field: field,
    textContent: text,
    style: { display: "" },
    dataset: {},
    getAttribute(name) { return name === "data-field" ? this._field : null; },
  };
}
function makeRoot(els) {
  return {
    querySelectorAll(sel) {
      if (sel === "[data-field]") return els;
      return []; // no data-mono / data-bg / data-slot in these cases
    },
  };
}
function loadBind() {
  const src = fs.readFileSync(path.join(__dirname, "..", "overlays", "sdk", "rivalry-bind.js"), "utf8");
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.window.RivalryBind;
}
const RivalryBind = loadBind();

// One-shot bind counts as live data having arrived.
function bindOnce(els, payload) {
  RivalryBind(makeRoot(els), null, payload);
}

test("a value from the payload replaces the placeholder", () => {
  const el = makeEl("teamA.name", "GUARDIANS");
  bindOnce([el], { teamA: { name: "EDAM IN BRAZIL" } });
  assert.equal(el.textContent, "EDAM IN BRAZIL");
  assert.equal(el.style.display, "");
});

test("a field the producer owns and left blank renders blank, not the mock text", () => {
  const tag = makeEl("teamA.tag", "NA");
  const rec = makeEl("teamA.record", "12-3");
  bindOnce([tag, rec], { teamA: { name: "EDAM IN BRAZIL", tag: "", record: "0-0" } });

  assert.equal(tag.textContent, "", "the mock region must not go to air");
  assert.equal(tag.style.display, "none", "an empty chip would still paint its padding");
  assert.equal(rec.textContent, "0-0");
});

test("a field the control feed never sends keeps its design text", () => {
  // brand.leagueName is part of the artwork, not producer data. Clearing it
  // took the RIVALRY wordmark off the scene.
  const brand = makeEl("brand.leagueName", "RIVALRY");
  bindOnce([brand], { teamA: { name: "X" }, eventTitle: "SUMMER CIRCUIT 2026" });
  assert.equal(brand.textContent, "RIVALRY");
});

test("top-level fields are owned by the payload", () => {
  const title = makeEl("eventTitle", "RIVALRY SEASON 1");
  bindOnce([title], { eventTitle: "" });
  assert.equal(title.textContent, "", "the producer clearing the event title must clear it on air");
});

test("a cleared field comes back when the value returns", () => {
  const root = makeRoot([makeEl("teamA.tag", "NA")]);
  const el = root.querySelectorAll("[data-field]")[0];
  const bound = RivalryBind(root, null, { teamA: { tag: "" } });

  assert.equal(el.style.display, "none");
  bound.apply({ teamA: { tag: "EU1" } });
  assert.equal(el.textContent, "EU1");
  assert.equal(el.style.display, "", "restored to whatever the stylesheet says");
});

test("before any data arrives, placeholders stay put", () => {
  // Nothing is bound: a designer opening the scene file sees a complete layout.
  const el = makeEl("teamA.tag", "NA");
  RivalryBind(makeRoot([el]), null, null);
  assert.equal(el.textContent, "NA");
});

test("a missing group leaves its fields alone, even under live data", () => {
  const el = makeEl("casters.0.name", "CASTER ONE");
  bindOnce([el], { teamA: { name: "X" } }); // no casters key at all
  assert.equal(el.textContent, "CASTER ONE");
});
