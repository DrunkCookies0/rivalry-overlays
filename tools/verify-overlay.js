/* =============================================================================
 * verify-overlay.js  —  check whether an overlay would load in production
 * -----------------------------------------------------------------------------
 *     npm run overlay:verify -- overlays/some-overlay
 *
 * Exits 0 if the folder is signed + intact (production-eligible), non-zero
 * otherwise. The same verifyOverlay() from bridge/overlay-signing.js is what
 * the app's loader will call at serve time, so this CLI tells you exactly what
 * the app will decide. Anyone can run it (public key only) — it grants nothing.
 * ===========================================================================*/

"use strict";

const fs = require("fs");
const path = require("path");
const { verifyOverlay } = require("../bridge/overlay-signing");

const dir = process.argv[2];
if (!dir) {
  console.error("usage: npm run overlay:verify -- <overlay-folder>");
  process.exit(1);
}
const target = path.resolve(dir);

const PUB = path.join(__dirname, "..", "overlays", "keys", "rivalry-overlay-public.pem");
if (!fs.existsSync(PUB)) {
  console.error("[verify] public key not found at " + PUB);
  console.error("[verify] run `npm run overlay:keygen` first (one time).");
  process.exit(1);
}

const result = verifyOverlay(target, fs.readFileSync(PUB, "utf8"));
if (result.approved) {
  console.log("[verify] OK — " + result.reason + (result.keyId ? " (key " + result.keyId + ")" : ""));
  process.exit(0);
} else {
  console.log("[verify] NOT APPROVED — " + result.reason);
  process.exit(2);
}
