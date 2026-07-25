/* =============================================================================
 * issue-key.js  —  mint a Casterverse access key for an approved person
 * -----------------------------------------------------------------------------
 *   npm run key:issue -- --name "Moldybanana"
 *   npm run key:issue -- --name "Yami" --tier producer --expires 2026-12-31
 *   npm run key:issue -- --name "Summer Circuit staff" --tier staff --note "S26"
 *
 * Prints the key to paste to them. Also appends a line to keys/issued-keys.log
 * so there is a record of who holds what — that log is gitignored (it names
 * real people) but it is the only way to answer "who did I give a key to?".
 *
 * Verify one that someone sends back:
 *   npm run key:verify -- RCV1.xxxx.yyyy
 * ===========================================================================*/

"use strict";

const fs = require("fs");
const path = require("path");
const { issueKey, verifyKey, TIERS } = require("../bridge/license");

const ROOT = path.join(__dirname, "..");
const PRIV = path.join(ROOT, "keys", "casterverse-license-private.pem");
const PUB = path.join(ROOT, "config", "casterverse-license-public.pem");
const LOG = path.join(ROOT, "keys", "issued-keys.log");

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : null;
}

const name = arg("--name");
if (!name) {
  console.error("usage: npm run key:issue -- --name \"Their Name\" [--tier " + TIERS.join("|") + "] [--expires 2026-12-31] [--note \"...\"]");
  process.exit(1);
}
if (!fs.existsSync(PRIV)) {
  console.error("[key:issue] no private key at " + PRIV);
  console.error("[key:issue] run `npm run key:keygen` once, then back that file up.");
  process.exit(1);
}

let result;
try {
  result = issueKey(
    { name, tier: arg("--tier") || "caster", expires: arg("--expires"), note: arg("--note") },
    fs.readFileSync(PRIV, "utf8")
  );
} catch (e) {
  console.error("[key:issue] " + e.message);
  process.exit(1);
}

// Prove the minted key verifies with the PUBLIC key that actually ships, so a
// mismatched pair is caught here and not by the person you just sent it to.
if (fs.existsSync(PUB)) {
  const check = verifyKey(result.key, fs.readFileSync(PUB, "utf8"));
  if (!check.valid) {
    console.error("[key:issue] REFUSING: the new key does not verify against the shipped public key.");
    console.error("[key:issue] reason: " + check.reason);
    console.error("[key:issue] config/casterverse-license-public.pem and keys/casterverse-license-private.pem are not a pair.");
    process.exit(1);
  }
}

const p = result.payload;
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.appendFileSync(LOG, `${p.iss}\t${p.id}\t${p.tier}\t${p.exp || "no expiry"}\t${p.name}\n`, "utf8");

console.log("");
console.log("  issued to : " + p.name);
console.log("  tier      : " + p.tier);
console.log("  expires   : " + (p.exp || "never"));
console.log("  key id    : " + p.id + "   (logged to keys/issued-keys.log)");
console.log("");
console.log("  Send them this line:");
console.log("");
console.log("  " + result.key);
console.log("");
