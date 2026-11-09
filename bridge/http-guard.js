/* =============================================================================
 * RIVALRY HTTP request guard
 * -----------------------------------------------------------------------------
 * The checks every request to the 49080 server passes BEFORE it is routed.
 * Kept pure (no Electron, no server) so they unit-test like the overlay gate.
 *
 *   - normalizeUrlPath: decode once, fold backslashes to slashes, resolve dot
 *     segments. The match gate, the signed-overlay gate and the keys/ deny all
 *     classify a request by its path PREFIX, so they must see the same path
 *     the filesystem will resolve. Without this, /control/..%5Coverlays%5C<id>
 *     (browsers leave %5C encoded) decodes to a backslash path that Windows
 *     resolves into overlays/ while never looking like an /overlays/ request.
 *     Malformed percent-encoding returns null instead of throwing inside the
 *     request handler (an uncaught throw there pops a main-process error box).
 *   - isInsideRoot: containment by path.relative, not string prefix (a prefix
 *     check lets a sibling such as <root>.unpacked through).
 *   - isAllowedHost: DNS-rebinding guard. The server binds loopback, but a
 *     hostile page can rebind its own hostname to 127.0.0.1 and then read
 *     responses as same-origin; a Host allowlist closes that.
 *   - isAllowedOrigin: CSRF guard for state-changing requests (POST
 *     /league/unlock drops the match lock). Same policy as the WebSocket
 *     servers' verifyClient in rl-bridge.js: no Origin (OBS, tools) is fine,
 *     a present Origin must be the app's own page.
 * ===========================================================================*/

"use strict";

const path = require("path");

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Returns the normalized absolute URL path ("/a/b"), or null when the request
// path is malformed (bad percent-encoding, NUL byte) and must be refused.
function normalizeUrlPath(rawUrl) {
  const raw = String(rawUrl || "/").split("?")[0].split("#")[0];
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch (e) {
    return null;
  }
  if (decoded.includes("\0")) return null;
  // Leading "/" anchors dot-segment resolution, so ".." can never climb above
  // the root: "/../x" normalizes to "/x".
  return path.posix.normalize("/" + decoded.replace(/\\/g, "/"));
}

function isInsideRoot(root, filePath) {
  const rel = path.relative(root, filePath);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

// Browsers always send Host; a missing one is a non-browser client, which is
// not what this guard is for.
function isAllowedHost(host) {
  if (host === undefined || host === "") return true;
  const h = String(host).toLowerCase();
  const name = h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0];
  return LOOPBACK_HOSTNAMES.has(name);
}

function isAllowedOrigin(origin, port) {
  if (origin === undefined || origin === "") return true;
  return origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`;
}

module.exports = { normalizeUrlPath, isInsideRoot, isAllowedHost, isAllowedOrigin };
