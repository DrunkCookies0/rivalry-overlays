/* Tests for Casterverse access keys. The property that matters: only the holder
 * of the private key can mint a key the app accepts, and nothing about a key can
 * be edited after issue (name, tier, expiry) without the signature failing. */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const { issueKey, verifyKey, maskKey, publicStatus, generateKeys } = require("../bridge/license");

// One throwaway pair for the whole file, plus a second one to prove keys minted
// elsewhere are rejected.
const pair = generateKeys();
const other = generateKeys();

function b64url(s) {
  return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

test("a freshly issued key verifies and carries its identity", () => {
  const { key, payload } = issueKey({ name: "Moldybanana", tier: "caster" }, pair.privateKeyPem);

  assert.ok(key.startsWith("RCV1."), "keys are prefixed so support can recognise them on sight");
  const r = verifyKey(key, pair.publicKeyPem);
  assert.equal(r.valid, true, r.reason);
  assert.equal(r.payload.name, "Moldybanana");
  assert.equal(r.payload.tier, "caster");
  assert.equal(r.payload.id, payload.id);
});

test("a key minted with a different private key is rejected", () => {
  const { key } = issueKey({ name: "Someone", tier: "caster" }, other.privateKeyPem);
  const r = verifyKey(key, pair.publicKeyPem);
  assert.equal(r.valid, false);
  assert.match(r.reason, /not valid for this app/);
});

test("editing the payload voids the key", () => {
  const { key } = issueKey({ name: "Caster", tier: "caster" }, pair.privateKeyPem);
  const [prefix, encoded, sig] = key.split(".");
  const payload = JSON.parse(Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());

  // Self-promotion to a higher tier is the obvious attack; so is stretching the
  // expiry. Both must fail, because the signature covers the encoded payload.
  for (const edit of [{ tier: "dev" }, { exp: "2099-01-01" }, { name: "Someone Else" }]) {
    const forged = `${prefix}.${b64url(JSON.stringify({ ...payload, ...edit }))}.${sig}`;
    const r = verifyKey(forged, pair.publicKeyPem);
    assert.equal(r.valid, false, `edit ${JSON.stringify(edit)} should not verify`);
  }
});

test("expiry is enforced, and lasts through the whole final day", () => {
  const { key } = issueKey({ name: "Temp", expires: "2026-12-31" }, pair.privateKeyPem);

  const during = verifyKey(key, pair.publicKeyPem, { now: Date.UTC(2026, 11, 31, 20, 0, 0) });
  assert.equal(during.valid, true, "a key expiring today still works today");

  const after = verifyKey(key, pair.publicKeyPem, { now: Date.UTC(2027, 0, 1, 0, 0, 1) });
  assert.equal(after.valid, false);
  assert.match(after.reason, /expired on 2026-12-31/);
  assert.equal(after.payload.name, "Temp", "expired keys still report who they belonged to");
});

test("a key with no expiry keeps working", () => {
  const { key } = issueKey({ name: "Alex" }, pair.privateKeyPem);
  const r = verifyKey(key, pair.publicKeyPem, { now: Date.UTC(2040, 0, 1) });
  assert.equal(r.valid, true);
  assert.equal(r.payload.exp, null);
});

test("garbage input fails with a message a producer can act on, never a throw", () => {
  for (const bad of ["", "   ", "hello", "RCV1.only-two", "RCV1..", "RCV9.a.b", null, undefined]) {
    const r = verifyKey(bad, pair.publicKeyPem);
    assert.equal(r.valid, false);
    assert.ok(r.reason.length > 0);
  }
  // Well-formed base64 that isn't ours.
  const r = verifyKey(`RCV1.${b64url('{"v":1,"name":"x"}')}.${b64url("nope")}`, pair.publicKeyPem);
  assert.equal(r.valid, false);
});

test("a build with no public key refuses rather than letting everything through", () => {
  const { key } = issueKey({ name: "Alex" }, pair.privateKeyPem);
  const r = verifyKey(key, null);
  assert.equal(r.valid, false, "fail closed");
});

test("issueKey rejects nonsense at mint time", () => {
  assert.throws(() => issueKey({ name: "" }, pair.privateKeyPem), /name/);
  assert.throws(() => issueKey({ name: "X", tier: "owner" }, pair.privateKeyPem), /unknown tier/);
  assert.throws(() => issueKey({ name: "X", expires: "next year" }, pair.privateKeyPem), /2026-12-31/);
});

test("masks and broadcast status never leak the key", () => {
  const { key } = issueKey({ name: "Moldybanana", tier: "caster" }, pair.privateKeyPem);
  const masked = maskKey(key);

  assert.ok(!key.includes(masked.replace("RCV1.••••", "")) === false, "mask keeps a short tail for identification");
  assert.ok(masked.length < 24, "mask must not be the key");
  assert.ok(!masked.includes(key.split(".")[1]), "payload segment never appears in the mask");

  const status = publicStatus(verifyKey(key, pair.publicKeyPem));
  assert.equal(status.valid, true);
  assert.equal(status.name, "Moldybanana");
  assert.ok(!JSON.stringify(status).includes(key), "the raw key is never in a broadcastable status");
});

test("the shipped public key is present and parseable", () => {
  // Guards against a build that forgot config/casterverse-license-public.pem:
  // without it every install fails closed and nobody can activate.
  const pub = path.join(__dirname, "..", "config", "casterverse-license-public.pem");
  assert.ok(fs.existsSync(pub), "config/casterverse-license-public.pem must ship");
  const r = verifyKey("RCV1.a.b", fs.readFileSync(pub, "utf8"));
  assert.equal(r.valid, false);
  assert.ok(!/no license public key/.test(r.reason), "the shipped key should load, just reject junk");
});

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

const { signRevocationList, verifyRevocationList } = require("../bridge/license");

test("a revoked key stops verifying, and still says who it belonged to", () => {
  const { key, payload } = issueKey({ name: "Ex Caster", tier: "caster" }, pair.privateKeyPem);
  assert.equal(verifyKey(key, pair.publicKeyPem).valid, true);

  const r = verifyKey(key, pair.publicKeyPem, { revoked: new Set([payload.id]) });
  assert.equal(r.valid, false);
  assert.match(r.reason, /withdrawn/);
  assert.equal(r.payload.name, "Ex Caster");
});

test("revoking one key does not touch anyone else's", () => {
  const a = issueKey({ name: "Stays" }, pair.privateKeyPem);
  const b = issueKey({ name: "Goes" }, pair.privateKeyPem);
  const revoked = new Set([b.payload.id]);
  assert.equal(verifyKey(a.key, pair.publicKeyPem, { revoked }).valid, true);
  assert.equal(verifyKey(b.key, pair.publicKeyPem, { revoked }).valid, false);
});

test("keys never expire unless an expiry was asked for", () => {
  const { key } = issueKey({ name: "Forever" }, pair.privateKeyPem);
  assert.equal(verifyKey(key, pair.publicKeyPem).payload.exp, null);
  assert.equal(verifyKey(key, pair.publicKeyPem, { now: Date.UTC(2099, 0, 1) }).valid, true);
});

test("a revocation list verifies, and any edit to it does not", () => {
  const doc = signRevocationList({ revoked: ["aaaa1111", "bbbb2222"], updated: "2026-07-25T00:00:00.000Z" }, pair.privateKeyPem);

  const good = verifyRevocationList(doc, pair.publicKeyPem);
  assert.equal(good.valid, true);
  assert.deepEqual(good.revoked, ["aaaa1111", "bbbb2222"]);

  // Removing an id to restore your own access is the obvious attack.
  assert.equal(verifyRevocationList({ ...doc, revoked: ["aaaa1111"] }, pair.publicKeyPem).valid, false);
  // So is adding one to cut someone else off.
  assert.equal(verifyRevocationList({ ...doc, revoked: [...doc.revoked, "cccc3333"] }, pair.publicKeyPem).valid, false);
  // Or back-dating it.
  assert.equal(verifyRevocationList({ ...doc, updated: "2020-01-01T00:00:00.000Z" }, pair.publicKeyPem).valid, false);
});

test("a list signed by someone else is rejected", () => {
  const doc = signRevocationList({ revoked: ["aaaa1111"], updated: "2026-07-25T00:00:00.000Z" }, other.privateKeyPem);
  assert.equal(verifyRevocationList(doc, pair.publicKeyPem).valid, false);
});

test("list order does not change the signature", () => {
  const one = signRevocationList({ revoked: ["bbbb", "aaaa"], updated: "2026-07-25T00:00:00.000Z" }, pair.privateKeyPem);
  const two = signRevocationList({ revoked: ["aaaa", "bbbb", "aaaa"], updated: "2026-07-25T00:00:00.000Z" }, pair.privateKeyPem);
  assert.equal(one.sig, two.sig, "same set of ids, same signature — duplicates and order must not matter");
});

test("malformed lists fail closed on the LIST, not on the app", () => {
  for (const bad of [null, undefined, "nope", {}, { v: 1 }, { v: 2, revoked: [], sig: "x" }, { v: 1, revoked: "no", sig: "x" }]) {
    const r = verifyRevocationList(bad, pair.publicKeyPem);
    assert.equal(r.valid, false);
    assert.deepEqual(r.revoked, [], "an unreadable list must revoke nobody, not everybody");
  }
});

test("pasting the league API key into the access-key box names the mistake", () => {
  // Both keys arrive in the same Discord message. Telling someone "that doesn't
  // look like a key" sends them checking the wrong thing.
  const r = verifyKey("rv_b0b0a31acfb76ef4b46a4866a3eeab966b4a4de1", pair.publicKeyPem);
  assert.equal(r.valid, false);
  assert.match(r.reason, /league API key/);
});
