/* =============================================================================
 * license-keys.js  —  one-time Ed25519 keypair for Casterverse ACCESS KEYS
 * -----------------------------------------------------------------------------
 * Run ONCE:
 *     npm run key:keygen
 *
 * Writes:
 *   config/casterverse-license-public.pem  (commit — ships in the app, verifies keys)
 *   keys/casterverse-license-private.pem   (NEVER commit — gitignored — BACK IT UP)
 *
 * This is a different keypair from the overlay signing key on purpose. Losing
 * this one means every access key already handed out stops verifying and you
 * reissue them all; losing the overlay key means re-signing every scene. Keep
 * the blast radii separate.
 * ===========================================================================*/

"use strict";

const fs = require("fs");
const path = require("path");
const { generateKeys } = require("../bridge/license");

const ROOT = path.join(__dirname, "..");
const PUB = path.join(ROOT, "config", "casterverse-license-public.pem");
const PRIV = path.join(ROOT, "keys", "casterverse-license-private.pem");

const force = process.argv.includes("--force");

if ((fs.existsSync(PUB) || fs.existsSync(PRIV)) && !force) {
  console.error("[key:keygen] license keys already exist. Refusing to overwrite.");
  console.error("[key:keygen] Re-keying invalidates EVERY access key already issued.");
  console.error("[key:keygen] Pass --force only if you really mean to re-key.");
  process.exit(1);
}

fs.mkdirSync(path.dirname(PUB), { recursive: true });
fs.mkdirSync(path.dirname(PRIV), { recursive: true });
const { publicKeyPem, privateKeyPem, keyId } = generateKeys();
// LF explicitly: a CRLF-rewritten PEM still parses, but keeping both copies in
// one line-ending form keeps fingerprints comparable across a Windows CI checkout.
fs.writeFileSync(PUB, publicKeyPem.replace(/\r\n?/g, "\n"), "utf8");
fs.writeFileSync(PRIV, privateKeyPem.replace(/\r\n?/g, "\n"), { encoding: "utf8", mode: 0o600 });

console.log("[key:keygen] wrote:");
console.log("  " + PUB + "   (commit this)");
console.log("  " + PRIV + "  (DO NOT commit — gitignored — back it up somewhere safe)");
console.log("[key:keygen] key id: " + keyId);
