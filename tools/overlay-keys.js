/* =============================================================================
 * overlay-keys.js  —  one-time Ed25519 keypair generator for overlay signing
 * -----------------------------------------------------------------------------
 * Run ONCE to mint the signing keypair:
 *     npm run overlay:keygen
 *
 * Writes:
 *   overlays/keys/rivalry-overlay-public.pem   (commit this — the app verifies with it)
 *   overlays/keys/rivalry-overlay-private.pem  (NEVER commit — gitignored — back it up)
 *
 * Whoever holds the private key is the only person who can approve an overlay
 * for production. Lose it and you re-key + re-sign everything. Leak it and
 * anyone can approve overlays — treat it like a release-signing key.
 * ===========================================================================*/

"use strict";

const fs = require("fs");
const path = require("path");
const { generateKeys } = require("../bridge/overlay-signing");

const KEYS_DIR = path.join(__dirname, "..", "overlays", "keys");
const PUB = path.join(KEYS_DIR, "rivalry-overlay-public.pem");
const PRIV = path.join(KEYS_DIR, "rivalry-overlay-private.pem");

const force = process.argv.includes("--force");

if ((fs.existsSync(PUB) || fs.existsSync(PRIV)) && !force) {
  console.error("[keygen] keys already exist. Refusing to overwrite.");
  console.error("[keygen] Re-keying invalidates every signature already issued.");
  console.error("[keygen] Pass --force only if you really mean to re-key.");
  process.exit(1);
}

fs.mkdirSync(KEYS_DIR, { recursive: true });
const { publicKeyPem, privateKeyPem, keyId } = generateKeys();
fs.writeFileSync(PUB, publicKeyPem, "utf8");
fs.writeFileSync(PRIV, privateKeyPem, { encoding: "utf8", mode: 0o600 });

console.log("[keygen] wrote:");
console.log("  " + PUB + "   (commit this)");
console.log("  " + PRIV + "  (DO NOT commit — gitignored — back it up somewhere safe)");
console.log("[keygen] key id: " + keyId);
