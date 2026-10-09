/* =============================================================================
 * HTTP request guard tests (bridge/http-guard.js)
 * -----------------------------------------------------------------------------
 * The guard runs before routing in main.js, so these also prove the gates in
 * overlay-registry.js see the path the filesystem will actually resolve:
 * a backslash or dot-segment detour must not turn an /overlays/ request into
 * a passthrough.
 * ===========================================================================*/

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { normalizeUrlPath, isInsideRoot, isAllowedHost, isAllowedOrigin } = require("../bridge/http-guard");
const { classifyOverlayRequest } = require("../bridge/overlay-registry");

const PORT = 49080;

function fakeRegistry() {
  const unsigned = { folder: "rivalry-unsigned", entry: "index.html", approved: false, reason: "unsigned" };
  return { list: [unsigned], byFolder: { "rivalry-unsigned": unsigned } };
}

// ---------------------------------------------------------------------------
// normalizeUrlPath
// ---------------------------------------------------------------------------

test("plain paths come back unchanged, query and fragment stripped", () => {
  assert.equal(normalizeUrlPath("/control/control.html"), "/control/control.html");
  assert.equal(normalizeUrlPath("/overlays/rivalry-gameplay/index.html?mock=1"), "/overlays/rivalry-gameplay/index.html");
  assert.equal(normalizeUrlPath("/league/logo?matchId=a&side=b"), "/league/logo");
  assert.equal(normalizeUrlPath("/overlays/rivalry-approved/"), "/overlays/rivalry-approved/");
  assert.equal(normalizeUrlPath("/"), "/");
  assert.equal(normalizeUrlPath(""), "/");
  assert.equal(normalizeUrlPath(undefined), "/");
});

test("percent-encoding is decoded once", () => {
  assert.equal(normalizeUrlPath("/league/matches/abc%20def"), "/league/matches/abc def");
});

test("dot segments resolve and can never climb above the root", () => {
  assert.equal(normalizeUrlPath("/control/../overlays/x/index.html"), "/overlays/x/index.html");
  assert.equal(normalizeUrlPath("/../../etc/passwd"), "/etc/passwd");
  assert.equal(normalizeUrlPath("/overlays//rivalry-x//index.html"), "/overlays/rivalry-x/index.html");
});

test("encoded backslashes fold to slashes before dot segments resolve", () => {
  assert.equal(
    normalizeUrlPath("/control/..%5Coverlays%5Ckeys%5Crivalry-overlay-private.pem"),
    "/overlays/keys/rivalry-overlay-private.pem"
  );
  assert.equal(normalizeUrlPath("/..%5c..%5capp.asar.unpacked%5cx"), "/app.asar.unpacked/x");
});

test("malformed percent-encoding and NUL bytes are refused, not thrown", () => {
  for (const bad of ["/%", "/%E0%A4%A", "/overlays/%zz", "/control/control.html%00.png"]) {
    assert.equal(normalizeUrlPath(bad), null, bad);
  }
});

// ---------------------------------------------------------------------------
// The gates see the normalized path
// ---------------------------------------------------------------------------

test("detours into keys/ are denied once normalized", () => {
  const reg = fakeRegistry();
  for (const raw of [
    "/control/..%5Coverlays%5Ckeys%5Crivalry-overlay-private.pem",
    "/control/../overlays/keys/rivalry-overlay-private.pem",
    "/assets/%2e%2e/overlays/keys/rivalry-overlay-private.pem",
  ]) {
    for (const gated of [true, false]) {
      assert.equal(classifyOverlayRequest(normalizeUrlPath(raw), reg, gated).kind, "deny", raw);
    }
  }
});

test("detours into an unsigned scene are denied by the production gate", () => {
  const reg = fakeRegistry();
  for (const raw of [
    "/control/..%5Coverlays%5Crivalry-unsigned%5Cindex.html",
    "/control/../overlays/rivalry-unsigned/index.html",
  ]) {
    const urlPath = normalizeUrlPath(raw);
    // main.js's match gate keys off the same prefix
    assert.ok(urlPath.startsWith("/overlays/"), raw);
    assert.equal(classifyOverlayRequest(urlPath, reg, true).kind, "deny", raw);
  }
});

// ---------------------------------------------------------------------------
// isInsideRoot
// ---------------------------------------------------------------------------

test("isInsideRoot accepts the root and anything under it", () => {
  const root = path.join(path.sep, "opt", "app", "resources", "app.asar");
  assert.equal(isInsideRoot(root, root), true);
  assert.equal(isInsideRoot(root, path.join(root, "control", "control.html")), true);
  assert.equal(isInsideRoot(root, path.join(root, "..foo")), true);
});

test("isInsideRoot rejects a sibling that merely shares the root's prefix", () => {
  const root = path.join(path.sep, "opt", "app", "resources", "app.asar");
  assert.equal(isInsideRoot(root, root + ".unpacked" + path.sep + "x"), false);
  assert.equal(isInsideRoot(root, path.dirname(root)), false);
  assert.equal(isInsideRoot(root, path.join(path.sep, "etc", "passwd")), false);
});

// ---------------------------------------------------------------------------
// isAllowedHost / isAllowedOrigin
// ---------------------------------------------------------------------------

test("loopback Host headers pass, with or without the port, any case", () => {
  for (const h of ["localhost:49080", "127.0.0.1:49080", "LOCALHOST:49080", "localhost", "[::1]:49080", undefined, ""]) {
    assert.equal(isAllowedHost(h), true, String(h));
  }
});

test("a rebound hostname is refused even on the right port", () => {
  for (const h of ["evil.example:49080", "localhost.evil.example:49080", "127.0.0.1.nip.io:49080", "[::2]:49080"]) {
    assert.equal(isAllowedHost(h), false, h);
  }
});

test("Origin: absent or the app's own page passes; anything else is refused", () => {
  assert.equal(isAllowedOrigin(undefined, PORT), true);
  assert.equal(isAllowedOrigin("", PORT), true);
  assert.equal(isAllowedOrigin("http://localhost:49080", PORT), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:49080", PORT), true);
  for (const o of ["https://evil.example", "http://localhost:3000", "null", "http://localhost:49080.evil.example"]) {
    assert.equal(isAllowedOrigin(o, PORT), false, o);
  }
});
