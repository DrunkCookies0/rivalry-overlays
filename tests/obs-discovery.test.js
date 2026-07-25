/* Tests for OBS discovery. The high-stakes behaviours here are the ones that
 * touch a producer's real OBS config, so those are pinned hardest: never write
 * while OBS is running, never disable auth, never lose the password. */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const disco = require("../bridge/obs-discovery");

function tmpConfigDir(contents) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rv-obs-"));
  const dir = path.join(base, "obs-studio");
  fs.mkdirSync(path.join(dir, "plugin_config", "obs-websocket"), { recursive: true });
  if (contents !== undefined) {
    fs.writeFileSync(path.join(dir, disco.WS_CONFIG_REL), contents, "utf8");
  }
  return dir;
}

// ---------------------------------------------------------------------------
// install discovery
// ---------------------------------------------------------------------------

test("finds OBS in Program Files without needing a registry entry", () => {
  // The reference machine for this project has NO uninstall registry key, so
  // path probing has to stand on its own.
  const exe = "C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe";
  const r = disco.findObsInstall({
    env: { ProgramFiles: "C:\\Program Files" },
    probe: (p) => p === exe,
    registry: () => { throw new Error("registry must not be needed"); },
  });

  assert.equal(r.found, true);
  assert.equal(r.exePath, exe);
  assert.equal(r.binDir, "C:\\Program Files\\obs-studio\\bin\\64bit");
  assert.equal(r.installDir, "C:\\Program Files\\obs-studio");
});

test("falls back to the registry when no known path has it", () => {
  const exe = "D:\\Portable\\OBS\\bin\\64bit\\obs64.exe";
  const r = disco.findObsInstall({
    env: { ProgramFiles: "C:\\Program Files" },
    probe: (p) => p === exe,
    registry: () => exe,
  });
  assert.equal(r.found, true);
  assert.equal(r.exePath, exe);
});

test("reports not-found rather than guessing", () => {
  const r = disco.findObsInstall({ env: {}, probe: () => false, registry: () => null });
  assert.equal(r.found, false);
  assert.equal(r.exePath, undefined);
});

test("looks in Steam's default library too", () => {
  const paths = disco.candidateExePaths({ "ProgramFiles(x86)": "C:\\Program Files (x86)" });
  assert.ok(paths.some((p) => p.includes(path.join("Steam", "steamapps", "common", "OBS Studio"))));
});

// ---------------------------------------------------------------------------
// websocket config
// ---------------------------------------------------------------------------

test("reads the real-world config shape (auth off, server on)", () => {
  // Verbatim shape from a real OBS 32.1.2 install.
  const dir = tmpConfigDir(JSON.stringify({
    alerts_enabled: false,
    auth_required: false,
    first_load: false,
    server_enabled: true,
    server_port: 4455,
    server_password: "hunter2hunter2",
  }));

  const c = disco.readWebSocketConfig(dir);
  assert.equal(c.exists, true);
  assert.equal(c.enabled, true);
  assert.equal(c.port, 4455);
  assert.equal(c.authRequired, false);
  assert.equal(c.password, "hunter2hunter2", "the password is read for us, never for the producer to type");
});

test("a missing auth_required is treated as auth ON", () => {
  const dir = tmpConfigDir(JSON.stringify({ server_enabled: true, server_port: 4455 }));
  assert.equal(disco.readWebSocketConfig(dir).authRequired, true, "assume the safe reading");
});

test("missing or corrupt config reports not-exists instead of throwing", () => {
  assert.equal(disco.readWebSocketConfig(tmpConfigDir()).exists, false);
  assert.equal(disco.readWebSocketConfig(tmpConfigDir("{not json")).exists, false);
  assert.equal(disco.readWebSocketConfig(null).exists, false);
  const nonDefault = tmpConfigDir(JSON.stringify({ server_enabled: true, server_port: 4499 }));
  assert.equal(disco.readWebSocketConfig(nonDefault).port, 4499, "a moved port must be honoured, not assumed 4455");
});

// ---------------------------------------------------------------------------
// enabling the server
// ---------------------------------------------------------------------------

test("enabling flips only server_enabled and keeps the password and auth setting", () => {
  const dir = tmpConfigDir(JSON.stringify({
    alerts_enabled: true,
    auth_required: true,
    server_enabled: false,
    server_port: 4499,
    server_password: "do-not-touch-me",
  }));

  const r = disco.enableWebSocketServer(dir, { running: false });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);

  const after = JSON.parse(fs.readFileSync(path.join(dir, disco.WS_CONFIG_REL), "utf8"));
  assert.equal(after.server_enabled, true);
  assert.equal(after.auth_required, true, "we never weaken an install's auth");
  assert.equal(after.server_password, "do-not-touch-me");
  assert.equal(after.server_port, 4499);
  assert.equal(after.alerts_enabled, true, "unrelated keys survive");
});

test("a backup is left behind before the file is touched", () => {
  const original = JSON.stringify({ server_enabled: false, server_port: 4455 });
  const dir = tmpConfigDir(original);

  const r = disco.enableWebSocketServer(dir, { running: false });
  assert.ok(r.backup, "a backup path is reported");
  assert.equal(fs.readFileSync(r.backup, "utf8"), original, "the backup is the pre-edit file, byte for byte");
});

test("refuses to write while OBS is running", () => {
  const original = JSON.stringify({ server_enabled: false });
  const dir = tmpConfigDir(original);

  const r = disco.enableWebSocketServer(dir, { running: true });

  assert.equal(r.ok, false);
  assert.equal(r.reason, "obs-running");
  assert.equal(fs.readFileSync(path.join(dir, disco.WS_CONFIG_REL), "utf8"), original,
    "OBS rewrites this file on exit, so an edit made now would be silently lost");
});

test("already-enabled is a no-op that reports no change", () => {
  const dir = tmpConfigDir(JSON.stringify({ server_enabled: true }));
  const r = disco.enableWebSocketServer(dir, { running: false });
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.ok(!fs.existsSync(path.join(dir, disco.WS_CONFIG_REL) + disco.BACKUP_SUFFIX), "nothing to back up");
});

test("no config file: refuses rather than inventing one", () => {
  // OBS has never run. Launching it once lets OBS write its own config with
  // auth on and a password it generated — better than us authoring one.
  const r = disco.enableWebSocketServer(tmpConfigDir(), { running: false });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no-config");
});

// ---------------------------------------------------------------------------
// launching
// ---------------------------------------------------------------------------

test("launch runs from bin\\64bit, detached, with the shutdown dialog suppressed", () => {
  const calls = [];
  const fakeChild = { unref() { calls.push("unref"); } };
  const r = disco.launchObs(
    { found: true, exePath: "C:\\obs\\bin\\64bit\\obs64.exe", binDir: "C:\\obs\\bin\\64bit" },
    { spawnFn: (exe, args, opts) => { calls.push({ exe, args, opts }); return fakeChild; } }
  );

  assert.equal(r.ok, true);
  const spawned = calls[0];
  assert.equal(spawned.exe, "C:\\obs\\bin\\64bit\\obs64.exe");
  assert.deepEqual(spawned.args, ["--disable-shutdown-check"]);
  assert.equal(spawned.opts.cwd, "C:\\obs\\bin\\64bit", "OBS resolves its data relative to cwd and won't start otherwise");
  assert.equal(spawned.opts.detached, true, "OBS must outlive us");
  assert.ok(calls.includes("unref"));
});

test("launch without an install fails cleanly", () => {
  assert.deepEqual(disco.launchObs({ found: false }), { ok: false, reason: "not-found" });
  assert.deepEqual(disco.launchObs(null), { ok: false, reason: "not-found" });
});

test("isObsRunning reads tasklist and never throws", () => {
  assert.equal(disco.isObsRunning({ exec: () => "obs64.exe   1234 Console  1  120,000 K" }), true);
  assert.equal(disco.isObsRunning({ exec: () => "INFO: No tasks are running which match the specified criteria." }), false);
  assert.equal(disco.isObsRunning({ exec: () => { throw new Error("tasklist missing"); } }), false);
});

test("waitForPort resolves once something is listening, and gives up cleanly", async () => {
  // A stub net module keeps this fast and machine-independent.
  let attempts = 0;
  const fakeNet = {
    connect() {
      attempts++;
      const handlers = {};
      const sock = {
        setTimeout() {},
        once(ev, fn) { handlers[ev] = fn; return sock; },
        removeAllListeners() {},
        destroy() {},
      };
      // Fail the first two attempts, then accept — OBS binding its port late.
      setImmediate(() => (attempts >= 3 ? handlers.connect && handlers.connect() : handlers.error && handlers.error()));
      return sock;
    },
  };
  assert.equal(await disco.waitForPort(4455, { net: fakeNet, intervalMs: 1, timeoutMs: 5000 }), true);
  assert.equal(attempts, 3);

  const neverNet = {
    connect() {
      const handlers = {};
      const sock = { setTimeout() {}, once(ev, fn) { handlers[ev] = fn; return sock; }, removeAllListeners() {}, destroy() {} };
      setImmediate(() => handlers.error && handlers.error());
      return sock;
    },
  };
  assert.equal(await disco.waitForPort(4455, { net: neverNet, intervalMs: 1, timeoutMs: 60 }), false);
});
