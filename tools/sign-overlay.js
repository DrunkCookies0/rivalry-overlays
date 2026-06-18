/* =============================================================================
 * sign-overlay.js  —  approve an overlay for production (Alex only)
 * -----------------------------------------------------------------------------
 * After reviewing a community (or in-house) overlay folder, sign it:
 *     npm run overlay:sign -- overlays/some-overlay
 *
 * This stamps a signed `approval` block into the folder's manifest.json. The
 * packaged app's loader will then serve it; unsigned/tampered folders are
 * dev-preview only. Re-run after ANY edit to the folder — a single changed
 * byte voids the previous signature.
 * ===========================================================================*/

"use strict";

const fs = require("fs");
const path = require("path");
const { signOverlay } = require("../bridge/overlay-signing");

const dir = process.argv[2];
if (!dir) {
  console.error("usage: npm run overlay:sign -- <overlay-folder>");
  process.exit(1);
}
const target = path.resolve(dir);
if (!fs.existsSync(path.join(target, "manifest.json"))) {
  console.error("[sign] no manifest.json in " + target);
  process.exit(1);
}

const PRIV = path.join(__dirname, "..", "overlays", "keys", "rivalry-overlay-private.pem");
if (!fs.existsSync(PRIV)) {
  console.error("[sign] private key not found at " + PRIV);
  console.error("[sign] run `npm run overlay:keygen` first (one time).");
  process.exit(1);
}

const approval = signOverlay(target, fs.readFileSync(PRIV, "utf8"));
console.log("[sign] approved: " + target);
console.log("[sign] key id:   " + approval.keyId);
console.log("[sign] hash:     " + approval.contentHash);
console.log("[sign] signed:   " + approval.signedAt);
