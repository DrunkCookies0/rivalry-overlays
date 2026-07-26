/* Tests for the revocation store. The behaviour that matters most is what
 * happens when things go WRONG: a machine mid-broadcast must never lose its
 * overlays because a fetch failed, and a stale-but-genuine list must not be
 * replayable to undo a revocation. */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { signRevocationList, generateKeys } = require("../bridge/license");
const { createRevocationStore, CACHE_FILE } = require("../bridge/revocation");

const pair = generateKeys();
const other = generateKeys();

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rv-revoke-"));
}
function writeList(file, ids, updated, priv = pair.privateKeyPem) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(signRevocationList({ revoked: ids, updated }, priv)), "utf8");
}
function store(opts = {}) {
  return createRevocationStore({ getPublicKey: () => pair.publicKeyPem, ...opts });
}
// Stub global fetch for one call.
async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test("loads the list that shipped with the build, with no network at all", () => {
  const dir = tmpDir();
  const shipped = path.join(dir, "casterverse-revoked.json");
  writeList(shipped, ["aaaa1111"], "2026-07-25T00:00:00.000Z");

  const s = store({ shippedFile: shipped, userDataDir: dir });
  s.loadLocal();

  assert.equal(s.isRevoked("aaaa1111"), true);
  assert.equal(s.isRevoked("bbbb2222"), false);
  assert.equal(s.status().source, "shipped");
});

test("a newer cached list wins over the shipped one", () => {
  const dir = tmpDir();
  const shipped = path.join(dir, "casterverse-revoked.json");
  writeList(shipped, ["aaaa1111"], "2026-07-01T00:00:00.000Z");
  writeList(path.join(dir, CACHE_FILE), ["aaaa1111", "bbbb2222"], "2026-07-25T00:00:00.000Z");

  const s = store({ shippedFile: shipped, userDataDir: dir });
  s.loadLocal();

  assert.equal(s.isRevoked("bbbb2222"), true, "the newer list is in force");
  assert.equal(s.status().source, "cache");
});

test("an OLDER cached list cannot roll back the shipped one", () => {
  // The replay attack: keep a genuinely-signed list from before you were
  // revoked and drop it in the cache.
  const dir = tmpDir();
  const shipped = path.join(dir, "casterverse-revoked.json");
  writeList(shipped, ["aaaa1111"], "2026-07-25T00:00:00.000Z");
  writeList(path.join(dir, CACHE_FILE), [], "2026-01-01T00:00:00.000Z");

  const s = store({ shippedFile: shipped, userDataDir: dir });
  s.loadLocal();

  assert.equal(s.isRevoked("aaaa1111"), true, "a stale signed list must not un-revoke anyone");
});

test("a tampered or foreign-signed cache is ignored entirely", () => {
  const dir = tmpDir();
  const shipped = path.join(dir, "casterverse-revoked.json");
  writeList(shipped, ["aaaa1111"], "2026-07-01T00:00:00.000Z");
  // Correctly signed, but by someone else's key.
  writeList(path.join(dir, CACHE_FILE), [], "2026-12-01T00:00:00.000Z", other.privateKeyPem);

  const s = store({ shippedFile: shipped, userDataDir: dir });
  s.loadLocal();

  assert.equal(s.isRevoked("aaaa1111"), true);
  assert.equal(s.status().source, "shipped");
});

test("no list anywhere revokes nobody — an app that can't read one still works", () => {
  const s = store({ shippedFile: path.join(tmpDir(), "missing.json"), userDataDir: tmpDir() });
  s.loadLocal();
  assert.equal(s.status().count, 0);
  assert.equal(s.isRevoked("aaaa1111"), false);
});

test("a fetched list is adopted and cached", async () => {
  const dir = tmpDir();
  const doc = signRevocationList({ revoked: ["cccc3333"], updated: "2026-08-01T00:00:00.000Z" }, pair.privateKeyPem);
  const s = store({ userDataDir: dir, url: "https://example.test/revoked.json" });

  const r = await withFetch(async () => ({ ok: true, status: 200, json: async () => doc }), () => s.refresh());

  assert.equal(r.ok, true);
  assert.equal(r.adopted, true);
  assert.equal(s.isRevoked("cccc3333"), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, CACHE_FILE), "utf8")).revoked, ["cccc3333"]);
});

test("a failed fetch changes nothing — this is the mid-broadcast case", async () => {
  const dir = tmpDir();
  const shipped = path.join(dir, "casterverse-revoked.json");
  writeList(shipped, ["aaaa1111"], "2026-07-25T00:00:00.000Z");
  const s = store({ shippedFile: shipped, userDataDir: dir, url: "https://example.test/revoked.json" });
  s.loadLocal();

  for (const failure of [
    async () => { throw new Error("getaddrinfo ENOTFOUND"); },
    async () => ({ ok: false, status: 503 }),
    async () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } }),
  ]) {
    const r = await withFetch(failure, () => s.refresh());
    assert.equal(r.ok === true && r.adopted === true, false);
    assert.equal(s.isRevoked("aaaa1111"), true, "the known-good list still stands");
    assert.equal(s.status().count, 1, "nobody gets locked out, and nobody gets un-revoked");
  }
});

test("a forged fetched list is refused and never cached", async () => {
  const dir = tmpDir();
  const s = store({ userDataDir: dir, url: "https://example.test/revoked.json" });
  const forged = signRevocationList({ revoked: ["dddd4444"], updated: "2026-08-01T00:00:00.000Z" }, other.privateKeyPem);

  const r = await withFetch(async () => ({ ok: true, status: 200, json: async () => forged }), () => s.refresh());

  assert.equal(r.adopted, false);
  assert.equal(s.isRevoked("dddd4444"), false);
  assert.ok(!fs.existsSync(path.join(dir, CACHE_FILE)), "a list that failed its check must not be persisted");
});

test("a fetched list older than what we hold is refused", async () => {
  const dir = tmpDir();
  const shipped = path.join(dir, "casterverse-revoked.json");
  writeList(shipped, ["aaaa1111"], "2026-07-25T00:00:00.000Z");
  const s = store({ shippedFile: shipped, userDataDir: dir, url: "https://example.test/revoked.json" });
  s.loadLocal();

  const stale = signRevocationList({ revoked: [], updated: "2026-01-01T00:00:00.000Z" }, pair.privateKeyPem);
  const r = await withFetch(async () => ({ ok: true, status: 200, json: async () => stale }), () => s.refresh());

  assert.equal(r.adopted, false);
  assert.equal(s.isRevoked("aaaa1111"), true);
});

test("restoring access works: a newer list without the id un-revokes it", async () => {
  const dir = tmpDir();
  const shipped = path.join(dir, "casterverse-revoked.json");
  writeList(shipped, ["aaaa1111"], "2026-07-25T00:00:00.000Z");
  const s = store({ shippedFile: shipped, userDataDir: dir, url: "https://example.test/revoked.json" });
  s.loadLocal();
  assert.equal(s.isRevoked("aaaa1111"), true);

  const restored = signRevocationList({ revoked: [], updated: "2026-08-01T00:00:00.000Z" }, pair.privateKeyPem);
  await withFetch(async () => ({ ok: true, status: 200, json: async () => restored }), () => s.refresh());

  assert.equal(s.isRevoked("aaaa1111"), false, "key:revoke --undo has to actually reach installs");
});
