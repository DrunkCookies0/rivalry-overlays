/* Tests for naming whoever holds one of our ports.
 *
 * Real case this comes from: the previous version of the app was installed,
 * auto-starting with Windows, and squatting 49080. The new install came up dead
 * and the dialog said "is another overlay app running?" — leaving the producer
 * to work it out. It is answerable, so it should be answered. */

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { findPortOwner, portConflictMessage, parseNetstatPid, parseTasklistName } = require("../bridge/port-owner");

// Verbatim shape of the netstat output on the machine this was diagnosed on.
const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:49080        0.0.0.0:0              LISTENING       50344
  TCP    127.0.0.1:49080        127.0.0.1:51771        FIN_WAIT_2      50344
  TCP    127.0.0.1:49124        0.0.0.0:0              LISTENING       50344
  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4
`;
const TASKLIST = "RIVALRY Overlay Beta.exe     50344 Console                    1    118,032 K";

test("finds the listening PID and ignores other states and ports", () => {
  assert.equal(parseNetstatPid(NETSTAT, 49080), 50344);
  assert.equal(parseNetstatPid(NETSTAT, 49124), 50344);
  assert.equal(parseNetstatPid(NETSTAT, 49777), null, "a port nobody holds has no owner");
  assert.equal(parseNetstatPid("", 49080), null);
});

test("a port ending in the same digits is not a match", () => {
  // ":9080" must not satisfy a lookup for 49080.
  const out = "  TCP    127.0.0.1:9080         0.0.0.0:0              LISTENING       111\n";
  assert.equal(parseNetstatPid(out, 49080), null);
});

test("reads the image name out of tasklist", () => {
  assert.equal(parseTasklistName(TASKLIST), "RIVALRY Overlay Beta.exe");
  assert.equal(parseTasklistName("INFO: No tasks are running which match the specified criteria."), null);
});

test("recognises an older version of ourselves", () => {
  const owner = findPortOwner(49080, {
    exec: (cmd) => (cmd === "netstat" ? NETSTAT : TASKLIST),
  });
  assert.equal(owner.pid, 50344);
  assert.equal(owner.name, "RIVALRY Overlay Beta.exe");
  assert.equal(owner.isOurs, true, "the old product name still counts as ours");
});

test("an unrelated program is reported but not claimed as ours", () => {
  const owner = findPortOwner(49080, {
    exec: (cmd) => (cmd === "netstat" ? NETSTAT : "SomeOtherApp.exe    50344 Console   1   10,000 K"),
  });
  assert.equal(owner.name, "SomeOtherApp.exe");
  assert.equal(owner.isOurs, false);
});

test("never throws when the tools are unavailable", () => {
  const owner = findPortOwner(49080, { exec: () => { throw new Error("netstat missing"); } });
  assert.deepEqual(owner, { pid: null, name: null, isOurs: false });
});

test("the message tells the producer what to actually do", () => {
  const ours = portConflictMessage(49080, "web server",
    { pid: 50344, name: "RIVALRY Overlay Beta.exe", isOurs: true }, "RIVALRY Casterverse");
  assert.match(ours, /RIVALRY Overlay Beta\.exe/);
  assert.match(ours, /older version/);
  assert.match(ours, /uninstall/i, "auto-start means quitting it once is not enough");

  const theirs = portConflictMessage(49080, "web server",
    { pid: 999, name: "Weird.exe", isOurs: false }, "RIVALRY Casterverse");
  assert.match(theirs, /Weird\.exe/);
  assert.ok(!/older version/.test(theirs), "don't claim an unrelated program is ours");

  const unknown = portConflictMessage(49080, "web server", { pid: null, name: null, isOurs: false }, "RIVALRY Casterverse");
  assert.match(unknown, /another overlay app/, "falls back to the old wording when we genuinely can't tell");
});

test("a second copy of the CURRENT build is a different problem than an old one", () => {
  const owner = { pid: 59960, name: "RIVALRY Casterverse.exe", isOurs: true };

  const dup = portConflictMessage(49080, "web server", owner, "RIVALRY Casterverse", "RIVALRY Casterverse.exe");
  assert.match(dup, /already running/);
  assert.match(dup, /system tray/);
  assert.ok(!/older version/.test(dup), "the same build is not an older version — telling them to uninstall is wrong");

  const old = portConflictMessage(49080, "web server",
    { pid: 50344, name: "RIVALRY Overlay Beta.exe", isOurs: true },
    "RIVALRY Casterverse", "RIVALRY Casterverse.exe");
  assert.match(old, /older version/);
  assert.match(old, /uninstall/i);
});
