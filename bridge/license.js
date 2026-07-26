/* =============================================================================
 * Casterverse access keys  (importable module)
 * -----------------------------------------------------------------------------
 * An access key is a short signed token issued by hand to an approved caster or
 * producer. The packaged app refuses to serve overlay scenes without a valid
 * one, so handing someone the installer is not the same as giving them the
 * broadcast suite — they also have to be approved.
 *
 * WHAT THIS IS, HONESTLY
 *   This is a credential, not copy protection. The client is open source and
 *   the installer's app.asar unpacks with a public tool, so anyone determined
 *   can patch the check out. What it does buy:
 *     - the installer can be shared freely without granting access
 *     - every key names WHO it was issued to, so access is auditable and
 *       revocable-by-expiry instead of anonymous
 *     - keys can't be forged or self-minted: only the holder of the private
 *       key (Alex) can produce one that verifies
 *   Real enforcement of paid/tiered features belongs server-side, where the
 *   client can't be patched. This format leaves room for that: `id` is a
 *   stable handle a future revocation/activation endpoint can check.
 *
 * FORMAT
 *   RCV1.<payload>.<signature>
 *     payload   = base64url(JSON)  — readable with any base64 decoder, on
 *                 purpose: a caster can see what they were issued.
 *     signature = base64url(Ed25519 over the ASCII bytes of <payload>)
 *   Signing the encoded payload STRING (not the re-serialized object) removes
 *   any JSON canonicalization ambiguity between issuer and verifier.
 *
 * Crypto is Node's built-in Ed25519, same as overlay signing — no new
 * dependency, and the keypair helpers are shared with bridge/overlay-signing.js.
 * The license keypair is SEPARATE from the overlay signing keypair: different
 * blast radius, different rotation schedule.
 * ===========================================================================*/

"use strict";

const crypto = require("crypto");

const { generateKeys, keyId, stableStringify } = require("./overlay-signing");

const PREFIX = "RCV1";
const TIERS = ["caster", "producer", "staff", "dev"];

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s) {
  return Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// YYYY-MM-DD (the only date form the CLI accepts) -> end of that day UTC, so an
// "expires 2026-12-31" key is still good all through December 31st.
function endOfDayUtc(yyyymmdd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(yyyymmdd || "").trim());
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
}

/**
 * Mint a key. Issuer side only — needs the private PEM.
 * @param {{name:string, tier?:string, expires?:string|null, note?:string}} fields
 */
function issueKey(fields, privateKeyPem) {
  const name = String((fields && fields.name) || "").trim();
  if (!name) throw new Error("a key must name who it is issued to (--name)");
  const tier = String((fields && fields.tier) || "caster").trim().toLowerCase();
  if (!TIERS.includes(tier)) throw new Error(`unknown tier "${tier}" (expected: ${TIERS.join(", ")})`);
  const expires = fields && fields.expires ? String(fields.expires).trim() : null;
  if (expires && endOfDayUtc(expires) === null) throw new Error("--expires must look like 2026-12-31");

  const payload = {
    v: 1,
    id: crypto.randomBytes(4).toString("hex"), // handle for future revocation
    name,
    tier,
    iss: new Date().toISOString().slice(0, 10),
    exp: expires,
  };
  const note = fields && fields.note ? String(fields.note).trim() : "";
  if (note) payload.note = note;

  const encoded = b64url(JSON.stringify(payload));
  const signature = crypto.sign(null, Buffer.from(encoded, "ascii"), crypto.createPrivateKey(privateKeyPem));
  return { key: `${PREFIX}.${encoded}.${b64url(signature)}`, payload };
}

/**
 * Verify a key. App side — needs only the public PEM (which ships).
 * Never throws; every failure is a {valid:false, reason} the UI can show.
 * @param {object} [opts]
 * @param {Set<string>|string[]} [opts.revoked] key ids that have been withdrawn
 * @returns {{valid:boolean, reason:string, payload?:object}}
 */
function verifyKey(key, publicKeyPem, { now = Date.now(), revoked = null } = {}) {
  const raw = String(key || "").trim();
  if (!raw) return { valid: false, reason: "no key entered" };
  if (!publicKeyPem) return { valid: false, reason: "this build has no license public key" };

  const parts = raw.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) {
    return { valid: false, reason: "that does not look like a Casterverse key (expected RCV1.…)" };
  }
  const [, encoded, sig] = parts;

  let payload;
  try {
    payload = JSON.parse(unb64url(encoded).toString("utf8"));
  } catch {
    return { valid: false, reason: "key is damaged — copy it again, complete, with no spaces" };
  }
  if (!payload || typeof payload !== "object") return { valid: false, reason: "key is damaged" };
  if (payload.v !== 1) return { valid: false, reason: `key version ${payload.v} needs a newer app` };

  // Signature BEFORE anything payload-derived is trusted.
  let ok = false;
  try {
    ok = crypto.verify(
      null,
      Buffer.from(encoded, "ascii"),
      crypto.createPublicKey(publicKeyPem),
      unb64url(sig)
    );
  } catch (e) {
    return { valid: false, reason: "key could not be checked: " + e.message };
  }
  if (!ok) return { valid: false, reason: "key is not valid for this app (wrong or edited key)" };

  // Revocation is checked after the signature, so a forged key can't name a
  // revoked id to imply it was ever real.
  if (revoked && payload.id) {
    const has = typeof revoked.has === "function" ? revoked.has(payload.id) : revoked.includes(payload.id);
    if (has) return { valid: false, reason: "this key has been withdrawn — ask about a new one", payload };
  }

  if (payload.exp) {
    const until = endOfDayUtc(payload.exp);
    if (until === null) return { valid: false, reason: "key has an unreadable expiry date" };
    if (now > until) return { valid: false, reason: `key expired on ${payload.exp} — ask for a new one`, payload };
  }

  return { valid: true, reason: "active", payload };
}

// ---------------------------------------------------------------------------
// Revocation list
// ---------------------------------------------------------------------------
// A signed list of withdrawn key ids. Because it is signed with the same
// private key as the access keys themselves, it can be published anywhere —
// a static file on any web server, or the public repo — without needing a
// service to run or a host to be trusted. Nobody but the key holder can forge
// or edit one.

const REVOCATION_VERSION = 1;

// The exact bytes that get signed. Sorting the ids means the same set always
// produces the same signature input regardless of the order they were added.
function revocationMessage({ updated, revoked }) {
  return stableStringify({
    v: REVOCATION_VERSION,
    updated: String(updated || ""),
    revoked: [...new Set((revoked || []).map(String))].sort(),
  });
}

/** Issuer side. @returns {object} the full list document, ready to publish. */
function signRevocationList({ revoked = [], updated }, privateKeyPem) {
  const doc = {
    v: REVOCATION_VERSION,
    updated: String(updated || new Date().toISOString()),
    revoked: [...new Set(revoked.map(String))].sort(),
  };
  const sig = crypto.sign(null, Buffer.from(revocationMessage(doc), "utf8"), crypto.createPrivateKey(privateKeyPem));
  return { ...doc, sig: b64url(sig) };
}

/**
 * App side. Never throws.
 * @returns {{valid:boolean, reason:string, revoked:string[], updated:string}}
 */
function verifyRevocationList(doc, publicKeyPem) {
  const empty = { valid: false, revoked: [], updated: "" };
  if (!doc || typeof doc !== "object") return { ...empty, reason: "not a revocation list" };
  if (doc.v !== REVOCATION_VERSION) return { ...empty, reason: `revocation list version ${doc.v} needs a newer app` };
  if (!publicKeyPem) return { ...empty, reason: "this build has no license public key" };
  if (typeof doc.sig !== "string" || !Array.isArray(doc.revoked)) {
    return { ...empty, reason: "revocation list is malformed" };
  }
  let ok = false;
  try {
    ok = crypto.verify(
      null,
      Buffer.from(revocationMessage(doc), "utf8"),
      crypto.createPublicKey(publicKeyPem),
      unb64url(doc.sig)
    );
  } catch (e) {
    return { ...empty, reason: "revocation list could not be checked: " + e.message };
  }
  if (!ok) return { ...empty, reason: "revocation list signature does not match" };
  return {
    valid: true,
    reason: "verified",
    revoked: doc.revoked.map(String),
    updated: String(doc.updated || ""),
  };
}

// Display form: never echo a whole key back into a UI, a broadcast, or a log.
function maskKey(key) {
  const raw = String(key || "").trim();
  if (!raw) return "";
  return `${PREFIX}.••••${raw.slice(-6)}`;
}

// The subset of a verified key that is safe to broadcast on the control bus.
function publicStatus(result) {
  const p = (result && result.payload) || null;
  return {
    valid: !!(result && result.valid),
    reason: (result && result.reason) || "",
    name: p ? String(p.name || "") : "",
    tier: p ? String(p.tier || "") : "",
    expires: p && p.exp ? String(p.exp) : null,
    id: p ? String(p.id || "") : "",
  };
}

module.exports = {
  issueKey, verifyKey, maskKey, publicStatus, generateKeys, keyId, PREFIX, TIERS,
  signRevocationList, verifyRevocationList, REVOCATION_VERSION,
};
