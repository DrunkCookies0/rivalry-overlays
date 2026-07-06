/* =============================================================================
 * Tests for bridge/overlay-signing.js — line-ending robustness
 * -----------------------------------------------------------------------------
 * These exist because a real bug shipped: CI's Windows checkout rewrote the
 * bundled public key to CRLF, which changed its fingerprint, so the packaged
 * app denied every (LF-signed) overlay and served black. The render harness
 * missed it because it runs on LF. Two guards:
 *   1. keyId must be line-ending invariant (LF key and CRLF key -> same id).
 *   2. no committed signed-overlay file may contain a CR byte (if one does, a
 *      Windows checkout could rewrite it and void the content hash).
 * ===========================================================================*/

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { keyId, verifyOverlay } = require("../bridge/overlay-signing");

const OVERLAYS_DIR = path.join(__dirname, "..", "overlays");
const PUBLIC_KEY = fs.readFileSync(
  path.join(OVERLAYS_DIR, "keys", "rivalry-overlay-public.pem"),
  "utf8"
);

function signedOverlayDirs() {
  return fs
    .readdirSync(OVERLAYS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("rivalry-"))
    .map((e) => path.join(OVERLAYS_DIR, e.name));
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

test("keyId is identical for LF and CRLF encodings of the same key", () => {
  const lf = PUBLIC_KEY.replace(/\r\n?/g, "\n");
  const crlf = lf.replace(/\n/g, "\r\n");
  assert.equal(keyId(lf), keyId(crlf), "CRLF checkout must not change the key id");
  assert.equal(keyId(lf), keyId(lf + "\n"), "trailing newline must not change the key id");
});

test("all shipped overlays verify against the public key AND its CRLF form", () => {
  const crlfKey = PUBLIC_KEY.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n");
  const dirs = signedOverlayDirs();
  assert.ok(dirs.length >= 7, "expected the active broadcast overlays");
  for (const dir of dirs) {
    // LF key (dev machine) and CRLF key (Windows CI) must BOTH approve.
    for (const [label, key] of [["LF", PUBLIC_KEY], ["CRLF", crlfKey]]) {
      const r = verifyOverlay(dir, key);
      assert.ok(r.approved, `${path.basename(dir)} denied with ${label} key: ${r.reason}`);
    }
  }
});

test("no signed overlay file contains a CR byte (would break on Windows checkout)", () => {
  const offenders = [];
  for (const dir of signedOverlayDirs()) {
    for (const f of walk(dir)) {
      if (fs.readFileSync(f).includes(0x0d)) offenders.push(path.relative(OVERLAYS_DIR, f));
    }
  }
  // The public key is signed-against too; guard it as well.
  const keyPath = path.join(OVERLAYS_DIR, "keys", "rivalry-overlay-public.pem");
  if (fs.readFileSync(keyPath).includes(0x0d)) offenders.push("keys/rivalry-overlay-public.pem");
  assert.deepEqual(offenders, [], "CR bytes found; pin these to LF in .gitattributes");
});
