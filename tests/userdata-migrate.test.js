/* Tests for the "RIVALRY Overlay" -> "RIVALRY Casterverse" userData migration.
 * The failure this guards against is silent and expensive: a producer updates,
 * the folder name changed underneath them, and their saved OBS connection +
 * league key + logos look wiped. */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { migrateUserData, MARKER } = require("../bridge/userdata-migrate");

// Windows: os.tmpdir(), never "/tmp".
function tmpPair() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rv-migrate-"));
  return { from: path.join(base, "old"), to: path.join(base, "new"), base };
}
function seedLegacy(dir) {
  fs.mkdirSync(path.join(dir, "user-assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "obs-settings.json"), '{"enabled":true}');
  fs.writeFileSync(path.join(dir, "league-settings.json"), '{"apiKey":"secret"}');
  fs.writeFileSync(path.join(dir, "control-state.json"), '{"teamA":{"name":"Old"}}');
  fs.writeFileSync(path.join(dir, ".setup-complete"), "2026-07-01");
  fs.writeFileSync(path.join(dir, "user-assets", "abc123.png"), "png-bytes");
  // Chromium profile noise that must NOT come across.
  fs.mkdirSync(path.join(dir, "Cache"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Cache", "data_0"), "cache");
  fs.writeFileSync(path.join(dir, "Preferences"), "{}");
}

test("copies our own state and skips Chromium profile data", () => {
  const { from, to } = tmpPair();
  seedLegacy(from);

  const r = migrateUserData(from, to);

  assert.equal(r.migrated, true);
  assert.equal(fs.readFileSync(path.join(to, "obs-settings.json"), "utf8"), '{"enabled":true}');
  assert.equal(fs.readFileSync(path.join(to, "league-settings.json"), "utf8"), '{"apiKey":"secret"}');
  assert.ok(fs.existsSync(path.join(to, ".setup-complete")), "setup marker carried across");
  assert.equal(fs.readFileSync(path.join(to, "user-assets", "abc123.png"), "utf8"), "png-bytes");
  assert.ok(!fs.existsSync(path.join(to, "Cache")), "Chromium cache must not migrate");
  assert.ok(!fs.existsSync(path.join(to, "Preferences")), "Chromium prefs must not migrate");
});

test("never overwrites state already in the new folder", () => {
  const { from, to } = tmpPair();
  seedLegacy(from);
  fs.mkdirSync(to, { recursive: true });
  fs.writeFileSync(path.join(to, "obs-settings.json"), '{"enabled":false,"new":true}');

  migrateUserData(from, to);

  assert.equal(fs.readFileSync(path.join(to, "obs-settings.json"), "utf8"), '{"enabled":false,"new":true}');
  // ...but siblings that were absent still come across.
  assert.ok(fs.existsSync(path.join(to, "league-settings.json")));
});

test("runs once: a later reset is not undone by a second migration", () => {
  const { from, to } = tmpPair();
  seedLegacy(from);

  migrateUserData(from, to);
  fs.rmSync(path.join(to, "league-settings.json")); // producer deliberately clears their key
  const second = migrateUserData(from, to);

  assert.equal(second.reason, "already-migrated");
  assert.ok(!fs.existsSync(path.join(to, "league-settings.json")), "cleared key must stay cleared");
});

test("clean install with no legacy folder is a no-op that still stamps the marker", () => {
  const { from, to } = tmpPair();

  const r = migrateUserData(from, to);

  assert.equal(r.migrated, false);
  assert.equal(r.reason, "no-legacy-dir");
  assert.ok(fs.existsSync(path.join(to, MARKER)), "marker stops us re-checking every boot");
});

test("never throws on bad input", () => {
  assert.equal(migrateUserData(null, null).migrated, false);
  assert.equal(migrateUserData("", "").reason, "missing-path");
  const { to } = tmpPair();
  assert.equal(migrateUserData(to, to).reason, "same-dir");
});
