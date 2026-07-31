/* app-log tees console into a file + ring buffer and must never throw.
 * node --test runs each file in its own process, so wrapping the global
 * console here cannot leak into other test files. */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const appLog = require("../bridge/app-log");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rivalry-applog-"));

test("init returns a log path and console lines land in file + ring", () => {
  const file = appLog.initAppLog(tmp);
  assert.ok(file && file.endsWith("casterverse.log"));
  console.log("[rivalry] applog-test marker", 42);
  const ring = appLog.recentLines(5);
  assert.ok(ring.some((l) => l.includes("applog-test marker 42")), "ring missing the line");
  const onDisk = fs.readFileSync(file, "utf8");
  assert.ok(onDisk.includes("applog-test marker 42"), "file missing the line");
  assert.ok(/^\d{4}-\d{2}-\d{2}T.*LOG /m.test(onDisk), "lines carry timestamp + level");
});

test("error level is recorded and recentLines caps to n", () => {
  console.error("[rivalry] applog-test error marker");
  const last = appLog.recentLines(1);
  assert.strictEqual(last.length, 1);
  assert.ok(last[0].includes("ERROR"));
});

test("rotation renames past the cap instead of growing forever", () => {
  const file = appLog.logFilePath();
  // Blow past the cap in one append, then log once to trigger the rotate check.
  fs.appendFileSync(file, "x".repeat(appLog.ROTATE_BYTES + 1024));
  console.log("[rivalry] applog-test rotate trigger");
  const old = file.replace(/\.log$/, ".old.log");
  assert.ok(fs.existsSync(old), "rotated file missing");
  assert.ok(fs.statSync(old).size > appLog.ROTATE_BYTES, "rotated file should hold the bulk");
});

test("init with an unwritable dir degrades instead of throwing", () => {
  // A file where the directory should be makes mkdir fail on every platform.
  const blocked = path.join(tmp, "blocked");
  fs.writeFileSync(blocked, "not a dir");
  const out = appLog.initAppLog(path.join(blocked, "nested"));
  assert.strictEqual(out, null);
  // Console keeps working with no file target.
  console.log("[rivalry] applog-test degraded marker");
  assert.ok(appLog.recentLines(3).some((l) => l.includes("degraded marker")));
});
