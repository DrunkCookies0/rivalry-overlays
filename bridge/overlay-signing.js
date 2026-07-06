/* =============================================================================
 * RIVALRY Overlay Signing  (importable module)
 * -----------------------------------------------------------------------------
 * The curated/signed trust model: community designers get the full SDK +
 * templates to BUILD an overlay, but it can't FUNCTION in the packaged app
 * until Alex reviews it and signs it with the private key. This module is the
 * one place that knows how an overlay is hashed, signed, and verified, so the
 * sign CLI (producer side) and the loader (app side, future) agree byte-for-byte.
 *
 * Crypto: Ed25519 via Node's built-in `crypto` — no new dependency. The public
 * key ships in the repo/app; the private key never leaves Alex's machine.
 *
 * Gate semantics:
 *   - A signature covers the manifest (minus its own `approval` block) AND every
 *     other file in the overlay folder. Change any byte after signing and the
 *     hash no longer matches, so the signature is void and the overlay must be
 *     re-reviewed and re-signed. This is what makes "can't be modified after my
 *     review" actually true rather than a promise.
 *
 * Exports:
 *   generateKeys()                       -> { publicKeyPem, privateKeyPem, keyId }
 *   hashOverlay(dir)                     -> contentHash hex (canonical, stable)
 *   signOverlay(dir, privateKeyPem)      -> writes manifest.approval, returns it
 *   verifyOverlay(dir, publicKeyPem)     -> { approved, reason, keyId }
 *   keyId(publicKeyPem)                  -> short fingerprint hex
 * ===========================================================================*/

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ALGO = "ed25519";
const MANIFEST = "manifest.json";

// ---------------------------------------------------------------------------
// Canonical JSON: sort object keys recursively so the same logical manifest
// always serializes to the same bytes regardless of authoring order. Without
// this, re-saving a manifest in a different key order would break the hash.
// ---------------------------------------------------------------------------
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
}

// Walk a directory recursively, returning POSIX-style relative paths (forward
// slashes) so a folder signed on Windows verifies the same on any OS.
function walkFiles(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(abs, base, out);
    } else if (entry.isFile()) {
      out.push(path.relative(base, abs).split(path.sep).join("/"));
    }
  }
  return out;
}

// Deterministic content hash over the manifest (minus its approval block) and
// every other file in the folder, sorted by path. This is the message that
// gets signed.
function hashOverlay(dir) {
  const manifestPath = path.join(dir, MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`no ${MANIFEST} in ${dir}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const { approval, ...signable } = manifest; // strip the block we're about to write

  const h = crypto.createHash("sha256");
  h.update("manifest\0");
  h.update(stableStringify(signable));

  const files = walkFiles(dir)
    .filter((rel) => rel !== MANIFEST)
    .sort();
  for (const rel of files) {
    h.update("\0file\0");
    h.update(rel);
    h.update("\0");
    h.update(fs.readFileSync(path.join(dir, rel)));
  }
  return h.digest("hex");
}

function keyId(publicKeyPem) {
  // Line-ending-invariant. A Windows CI checkout (core.autocrlf) can rewrite the
  // bundled public-key PEM to CRLF; that must NOT change the key's identity, or
  // the packaged app computes a different fingerprint than the one every overlay
  // was signed against and denies them all. Normalize CR/CRLF to LF first.
  const normalized = publicKeyPem.toString().replace(/\r\n?/g, "\n").trim();
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function generateKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync(ALGO);
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { publicKeyPem, privateKeyPem, keyId: keyId(publicKeyPem) };
}

function signOverlay(dir, privateKeyPem) {
  const contentHash = hashOverlay(dir);
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  // Derive the matching public key so we can stamp the keyId without needing
  // the public PEM passed in separately.
  const publicKeyPem = crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  const signature = crypto.sign(null, Buffer.from(contentHash, "hex"), privateKey).toString("base64");

  const approval = {
    algo: ALGO,
    contentHash,
    signature,
    keyId: keyId(publicKeyPem),
    signedAt: new Date().toISOString(),
  };

  const manifestPath = path.join(dir, MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.approval = approval;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return approval;
}

function verifyOverlay(dir, publicKeyPem) {
  const manifestPath = path.join(dir, MANIFEST);
  if (!fs.existsSync(manifestPath)) return { approved: false, reason: "no manifest.json" };

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    return { approved: false, reason: "manifest.json is not valid JSON" };
  }

  const approval = manifest.approval;
  if (!approval || !approval.signature || !approval.contentHash) {
    return { approved: false, reason: "unsigned (no approval block) — pending review" };
  }
  if (approval.algo !== ALGO) {
    return { approved: false, reason: `unsupported algo ${approval.algo}` };
  }

  const expectedKeyId = keyId(publicKeyPem);
  if (approval.keyId && approval.keyId !== expectedKeyId) {
    return { approved: false, reason: `signed by key ${approval.keyId}, expected ${expectedKeyId}`, keyId: approval.keyId };
  }

  // Recompute from current bytes. If a file changed since signing, the hash
  // won't match the one inside the (signed) approval block, and even if an
  // attacker edited contentHash to match, the signature over it would fail.
  const actualHash = hashOverlay(dir);
  if (actualHash !== approval.contentHash) {
    return { approved: false, reason: "content changed since signing — re-sign required", keyId: approval.keyId };
  }

  let ok = false;
  try {
    ok = crypto.verify(
      null,
      Buffer.from(approval.contentHash, "hex"),
      crypto.createPublicKey(publicKeyPem),
      Buffer.from(approval.signature, "base64")
    );
  } catch (e) {
    return { approved: false, reason: "signature could not be verified: " + e.message };
  }
  if (!ok) return { approved: false, reason: "signature does not match public key", keyId: approval.keyId };

  return { approved: true, reason: "signed and verified", keyId: approval.keyId };
}

module.exports = { generateKeys, hashOverlay, signOverlay, verifyOverlay, keyId, stableStringify };
