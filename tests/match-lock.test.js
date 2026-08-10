/* Tests for the match lock (bridge/match-lock.js): the loaded-league-match
 * state the whole match-first product hangs off. The failures these guard
 * against are on-air ones: a restart mid-show dropping the loaded match, a
 * league outage taking the team logos with it, or a half-written lock serving
 * scenes against garbage. */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createMatchLock } = require("../bridge/match-lock");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rv-matchlock-"));
}

const MATCH = {
  matchId: "m-77",
  event: { season: "Summer Circuit 2026", circuitShort: "3v3 East", composedTitle: "Summer Circuit 2026 | 3v3 East" },
  scheduledDate: "2026-08-09T19:00:00.000Z",
  teams: [
    { name: "FROST", record: "4-1", players: [{ name: "HEATER" }] },
    { name: "NOVA", record: "3-2", players: [{ name: "COMET" }] },
  ],
};

test("starts unlocked and stays unlocked with no state file", () => {
  const lock = createMatchLock({ userDataDir: tmpDir() });
  assert.equal(lock.isLocked(), false);
  assert.equal(lock.get(), null);
  assert.deepEqual(lock.status(), { locked: false });
  assert.equal(lock.getLogo("a"), null);
});

test("set() locks, persists, and a new instance reloads the same lock", () => {
  const dir = tmpDir();
  const lock = createMatchLock({ userDataDir: dir });
  lock.set("m-77", MATCH, {
    a: { contentType: "image/png", body: Buffer.from("logo-a-bytes") },
    b: { contentType: "image/webp", body: Buffer.from("logo-b-bytes") },
  });
  assert.equal(lock.isLocked(), true);
  assert.equal(lock.get().matchId, "m-77");

  // Restart mid-show: a fresh instance over the same dir finds the lock.
  const again = createMatchLock({ userDataDir: dir });
  assert.equal(again.isLocked(), true);
  assert.equal(again.get().matchId, "m-77");
  assert.equal(again.get().match.teams[0].name, "FROST");
});

test("logo bytes round-trip from disk with their content type", () => {
  const lock = createMatchLock({ userDataDir: tmpDir() });
  lock.set("m-77", MATCH, {
    a: { contentType: "image/png", body: Buffer.from("logo-a-bytes") },
    b: null,
  });
  const a = lock.getLogo("a");
  assert.equal(a.contentType, "image/png");
  assert.equal(a.body.toString(), "logo-a-bytes");
  // Side b had no logo: null, not an error.
  assert.equal(lock.getLogo("b"), null);
});

test("locking a new match replaces the old one, including stale logos", () => {
  const dir = tmpDir();
  const lock = createMatchLock({ userDataDir: dir });
  lock.set("m-77", MATCH, { a: { contentType: "image/png", body: Buffer.from("old-a") }, b: null });
  // The next match has a logo only on side b; side a's old bytes must not
  // leak through as the new team's logo.
  lock.set("m-88", { ...MATCH, matchId: "m-88" }, { a: null, b: { contentType: "image/png", body: Buffer.from("new-b") } });
  assert.equal(lock.get().matchId, "m-88");
  assert.equal(lock.getLogo("a"), null);
  assert.equal(lock.getLogo("b").body.toString(), "new-b");
});

test("clear() unlocks and removes every file it wrote", () => {
  const dir = tmpDir();
  const lock = createMatchLock({ userDataDir: dir });
  lock.set("m-77", MATCH, { a: { contentType: "image/png", body: Buffer.from("bytes") }, b: null });
  lock.clear();
  assert.equal(lock.isLocked(), false);
  assert.equal(fs.existsSync(path.join(dir, "active-match.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "match-logo-a.bin")), false);
  // And a reload agrees.
  assert.equal(createMatchLock({ userDataDir: dir }).isLocked(), false);
});

test("status() is a safe summary: names, records, players, no logo bytes", () => {
  const lock = createMatchLock({ userDataDir: tmpDir() });
  lock.set("m-77", MATCH, { a: { contentType: "image/png", body: Buffer.from("bytes") }, b: null });
  const s = lock.status();
  assert.equal(s.locked, true);
  assert.equal(s.matchId, "m-77");
  assert.equal(s.teams[0].name, "FROST");
  assert.equal(s.teams[0].hasLogo, true);
  assert.equal(s.teams[1].hasLogo, false);
  assert.equal(s.event.circuitShort, "3v3 East");
  assert.ok(!JSON.stringify(s).includes("bytes"), "logo bytes must never ride the status broadcast");
});

test("corrupt state file reads as unlocked, never throws", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "active-match.json"), "{not json");
  const lock = createMatchLock({ userDataDir: dir });
  assert.equal(lock.isLocked(), false);
  // A lock missing its matchId is corrupt too.
  fs.writeFileSync(path.join(dir, "active-match.json"), JSON.stringify({ match: MATCH }));
  assert.equal(createMatchLock({ userDataDir: dir }).isLocked(), false);
});

test("bye match: null team slot survives set/status round-trip", () => {
  const lock = createMatchLock({ userDataDir: tmpDir() });
  lock.set("m-99", { ...MATCH, teams: [MATCH.teams[0], null] }, { a: null, b: null });
  const s = lock.status();
  assert.equal(s.teams[0].name, "FROST");
  assert.equal(s.teams[1], null);
});
