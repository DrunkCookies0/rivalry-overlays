/* =============================================================================
 * verify-key.js  —  check a Casterverse access key the way the app does
 * -----------------------------------------------------------------------------
 *   npm run key:verify -- RCV1.xxxx.yyyy
 *
 * Uses the PUBLIC key only (config/casterverse-license-public.pem), so this is
 * exactly the check a producer's install performs. Useful when someone reports
 * "my key doesn't work" — run it here before assuming the app is at fault.
 * ===========================================================================*/

"use strict";

const fs = require("fs");
const path = require("path");
const { verifyKey } = require("../bridge/license");

const PUB = path.join(__dirname, "..", "config", "casterverse-license-public.pem");
const key = process.argv.slice(2).filter((a) => !a.startsWith("--"))[0];

if (!key) {
  console.error("usage: npm run key:verify -- RCV1.xxxx.yyyy");
  process.exit(1);
}
if (!fs.existsSync(PUB)) {
  console.error("[key:verify] no public key at " + PUB + " — run `npm run key:keygen`.");
  process.exit(1);
}

const r = verifyKey(key, fs.readFileSync(PUB, "utf8"));
if (!r.valid) {
  console.error("INVALID: " + r.reason);
  process.exit(1);
}
const p = r.payload;
console.log("VALID");
console.log("  issued to : " + p.name);
console.log("  tier      : " + p.tier);
console.log("  issued    : " + p.iss);
console.log("  expires   : " + (p.exp || "never"));
console.log("  key id    : " + p.id);
if (p.note) console.log("  note      : " + p.note);
