/* Tests for the SDK's reload after an app update.
 *
 * The bug this pins: OBS keeps overlay pages loaded (the app builds its
 * sources with shutdown off), so after an app update every source reconnected
 * to the new app while still running the old build's HTML and CSS. A producer
 * on v0.7.0-beta.67 saw beta.66's Starting Soon and Match Preview until each
 * source was refreshed by hand. The SDK now asks the app's /version on every
 * control-bus open and reloads once the build changed. */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SDK = fs.readFileSync(path.join(__dirname, "..", "overlays", "sdk", "rivalry-overlay-sdk.js"), "utf8");

// The SDK in a sandbox whose /version answers with `meta.current`, and whose
// location.reload() is counted instead of performed.
function load(protocol) {
  const meta = { current: { version: "0.7.0-beta.66", sha: "778d5a4" } };
  const calls = { fetch: 0, reload: 0 };
  const window = {
    location: { protocol, search: "", reload() { calls.reload++; } },
    fetch(url) {
      calls.fetch++;
      assert.equal(url, "/version");
      const body = meta.current;
      return Promise.resolve({ ok: !!body, json: () => Promise.resolve(body) });
    },
  };
  vm.runInNewContext(SDK, { window, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval });
  const check = () => { window.RivalryOverlay.checkBuild(); return new Promise((r) => setImmediate(r)); };
  return { meta, calls, check };
}

test("the first answer is the page's own build: no reload", async () => {
  const { calls, check } = load("http:");
  await check();
  assert.equal(calls.fetch, 1);
  assert.equal(calls.reload, 0);
});

test("a reconnect to the same build (an app restart) does not reload", async () => {
  const { calls, check } = load("http:");
  await check();
  await check();
  await check();
  assert.equal(calls.reload, 0);
});

test("a reconnect to a different build (an app update) reloads", async () => {
  const { meta, calls, check } = load("http:");
  await check();
  meta.current = { version: "0.7.0-beta.67", sha: "3ba7436" };
  await check();
  assert.equal(calls.reload, 1);
});

test("same version, different commit (a local rebuild) still reloads", async () => {
  const { meta, calls, check } = load("http:");
  await check();
  meta.current = { version: "0.7.0-beta.66", sha: "abc1234" };
  await check();
  assert.equal(calls.reload, 1);
});

test("an app that is down or answers oddly never reloads the page", async () => {
  const { meta, calls, check } = load("http:");
  await check();
  meta.current = null; // 404 / not ok
  await check();
  meta.current = { nope: true }; // no version field
  await check();
  assert.equal(calls.reload, 0);
});

test("pages opened off disk never ask (the mock has no app behind it)", async () => {
  const { calls, check } = load("file:");
  await check();
  assert.equal(calls.fetch, 0);
  assert.equal(calls.reload, 0);
});
