/* =============================================================================
 * Signed-gate unit tests (bridge/overlay-registry.js)
 * -----------------------------------------------------------------------------
 * Covers the two pure functions the HTTP server leans on for the curated/
 * signed overlay gate:
 *   - classifyOverlayRequest(urlPath, registry, isProd)
 *   - injectSignedFlag(html)
 * No Electron, no filesystem: the registry is a hand-built fake that mirrors
 * the byFolder shape scanOverlays() produces.
 * ===========================================================================*/

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyOverlayRequest,
  injectSignedFlag,
} = require("../bridge/overlay-registry");

const SIGNED_TAG = "<script>window.__RIVALRY_SIGNED__=true;</script>";

// Minimal fake registry mirroring the entry shape scanOverlays() builds
// (folder/id/name/scene/needs/version/entry/approved/reason/keyId/url).
function fakeRegistry() {
  const mk = (folder, approved, extra = {}) => ({
    folder,
    id: folder,
    name: folder,
    scene: folder.replace(/^rivalry-/, ""),
    needs: [],
    version: "1.0.0",
    entry: "index.html",
    approved,
    reason: approved ? "signed and verified" : "unsigned (no approval block)",
    keyId: approved ? "deadbeefdeadbeef" : null,
    url: `/overlays/${folder}/index.html`,
    ...extra,
  });
  const list = [mk("rivalry-approved", true), mk("rivalry-unsigned", false)];
  const byFolder = {};
  for (const e of list) byFolder[e.folder] = e;
  return { list, byFolder, scannedAt: new Date().toISOString(), hasKey: true };
}

// ---------------------------------------------------------------------------
// classifyOverlayRequest
// ---------------------------------------------------------------------------

test("non-/overlays/ paths pass through untouched (gated or not)", () => {
  const reg = fakeRegistry();
  for (const p of ["/", "/control/control.html", "/version", "/assets/rivalry-logo.svg"]) {
    assert.deepEqual(classifyOverlayRequest(p, reg, true), { kind: "passthrough" });
    assert.deepEqual(classifyOverlayRequest(p, reg, false), { kind: "passthrough" });
  }
});

test("bare /overlays/ (no folder segment) passes through", () => {
  const reg = fakeRegistry();
  assert.deepEqual(classifyOverlayRequest("/overlays/", reg, true), { kind: "passthrough" });
});

test("sdk and shared always serve, even when the gate is active", () => {
  const reg = fakeRegistry();
  for (const p of [
    "/overlays/sdk/rivalry-overlay-sdk.js",
    "/overlays/sdk",
    "/overlays/shared/rivalry-theme.css",
  ]) {
    assert.equal(classifyOverlayRequest(p, reg, true).kind, "shared");
    assert.equal(classifyOverlayRequest(p, reg, false).kind, "shared");
  }
});

test("keys/ is never web-served, gate on or off", () => {
  const reg = fakeRegistry();
  for (const gated of [true, false]) {
    const r = classifyOverlayRequest("/overlays/keys/rivalry-overlay-public.pem", reg, gated);
    assert.equal(r.kind, "deny");
    assert.match(r.reason, /keys/);
  }
});

test("unknown overlay folder is denied when gated", () => {
  const reg = fakeRegistry();
  const r = classifyOverlayRequest("/overlays/rivalry-nope/index.html", reg, true);
  assert.equal(r.kind, "deny");
  assert.match(r.reason, /no such overlay/);
});

test("unknown overlay folder is denied in dev too (nothing to serve)", () => {
  // The implementation denies unknown folders regardless of the gate: there
  // is no registry entry to resolve a file against.
  const reg = fakeRegistry();
  const r = classifyOverlayRequest("/overlays/rivalry-nope/index.html", reg, false);
  assert.equal(r.kind, "deny");
});

test("unapproved overlay is denied when the gate is active", () => {
  const reg = fakeRegistry();
  const r = classifyOverlayRequest("/overlays/rivalry-unsigned/index.html", reg, true);
  assert.equal(r.kind, "deny");
  assert.match(r.reason, /^unapproved:/);
});

test("unapproved overlay serves in dev (kind scene, approved false)", () => {
  const reg = fakeRegistry();
  const r = classifyOverlayRequest("/overlays/rivalry-unsigned/index.html", reg, false);
  assert.equal(r.kind, "scene");
  assert.equal(r.folder, "rivalry-unsigned");
  assert.equal(r.approved, false);
  assert.equal(r.isEntry, true);
});

test("approved overlay entry HTML is flagged isEntry (gated)", () => {
  const reg = fakeRegistry();
  const r = classifyOverlayRequest("/overlays/rivalry-approved/index.html", reg, true);
  assert.equal(r.kind, "scene");
  assert.equal(r.folder, "rivalry-approved");
  assert.equal(r.approved, true);
  assert.equal(r.isEntry, true);
});

test("bare folder path (no file) resolves to the entry", () => {
  const reg = fakeRegistry();
  for (const p of ["/overlays/rivalry-approved", "/overlays/rivalry-approved/"]) {
    const r = classifyOverlayRequest(p, reg, true);
    assert.equal(r.kind, "scene");
    assert.equal(r.isEntry, true);
  }
});

test("non-entry files in an approved folder are scene but not isEntry", () => {
  const reg = fakeRegistry();
  const r = classifyOverlayRequest("/overlays/rivalry-approved/style.css", reg, true);
  assert.equal(r.kind, "scene");
  assert.equal(r.isEntry, false);
});

// ---------------------------------------------------------------------------
// injectSignedFlag
// ---------------------------------------------------------------------------

test("injectSignedFlag inserts the script tag right after <head>", () => {
  const html = '<!doctype html><html><head><meta charset="utf-8"></head><body>x</body></html>';
  const out = injectSignedFlag(html);
  assert.equal(
    out,
    '<!doctype html><html><head>' + SIGNED_TAG + '<meta charset="utf-8"></head><body>x</body></html>'
  );
});

test("injectSignedFlag handles <head> with attributes and mixed case", () => {
  const withAttrs = '<html><head lang="en"><title>t</title></head></html>';
  assert.equal(
    injectSignedFlag(withAttrs),
    '<html><head lang="en">' + SIGNED_TAG + "<title>t</title></head></html>"
  );
  const upper = "<HTML><HEAD><TITLE>t</TITLE></HEAD></HTML>";
  const out = injectSignedFlag(upper);
  assert.equal(out.indexOf("<HEAD>" + SIGNED_TAG), upper.indexOf("<HEAD>"));
});

test("injectSignedFlag without <head> falls back to after <html>", () => {
  const html = '<html lang="en"><body>x</body></html>';
  assert.equal(injectSignedFlag(html), '<html lang="en">' + SIGNED_TAG + "<body>x</body></html>");
});

test("injectSignedFlag with neither <head> nor <html> prepends the tag", () => {
  const html = "<body>bare fragment</body>";
  assert.equal(injectSignedFlag(html), SIGNED_TAG + html);
});

test("injectSignedFlag injects exactly one tag and preserves the rest", () => {
  const html = "<html><head></head><body><p>keep me</p></body></html>";
  const out = injectSignedFlag(html);
  assert.equal(out.split(SIGNED_TAG).length - 1, 1);
  assert.equal(out.replace(SIGNED_TAG, ""), html);
});
