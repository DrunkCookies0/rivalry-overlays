/* =============================================================================
 * key-registry.js  —  the local record of who holds a Casterverse access key
 * -----------------------------------------------------------------------------
 * Shared by the issue / list / revoke CLIs. Lives at keys/issued-keys.json,
 * which is gitignored: it holds real people's names, and it is the only place
 * that maps a key id back to a person. Back it up with the private key.
 *
 * Revoking rewrites config/casterverse-revoked.json — the SIGNED list the app
 * checks. That file IS committed, because it is signed and therefore safe to
 * publish anywhere.
 * ===========================================================================*/

"use strict";

const fs = require("fs");
const path = require("path");

const { signRevocationList } = require("../bridge/license");

const ROOT = path.join(__dirname, "..");
const REGISTRY = path.join(ROOT, "keys", "issued-keys.json");
const REVOCATIONS = path.join(ROOT, "config", "casterverse-revoked.json");
const PRIV = path.join(ROOT, "keys", "casterverse-license-private.pem");

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
    return Array.isArray(parsed.keys) ? parsed : { v: 1, keys: [] };
  } catch {
    return { v: 1, keys: [] };
  }
}

function save(registry) {
  fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
  fs.writeFileSync(REGISTRY, JSON.stringify(registry, null, 2) + "\n", "utf8");
}

function record(payload) {
  const registry = load();
  registry.keys.push({
    id: payload.id,
    name: payload.name,
    tier: payload.tier,
    issued: payload.iss,
    expires: payload.exp || null,
    note: payload.note || "",
    revoked: null, // -> { at, reason } once withdrawn
  });
  save(registry);
  return registry;
}

function find(registry, needle) {
  const q = String(needle || "").trim().toLowerCase();
  if (!q) return [];
  return registry.keys.filter((k) => k.id.toLowerCase() === q || k.name.toLowerCase() === q);
}

// Rewrite the signed list from whatever the registry currently says is revoked.
// Always regenerated in full, never appended to, so the file can't drift out of
// step with the record.
function writeRevocationList(registry) {
  if (!fs.existsSync(PRIV)) {
    throw new Error("no private key at " + PRIV + " — run `npm run key:keygen` first");
  }
  const revoked = registry.keys.filter((k) => k.revoked).map((k) => k.id);
  const doc = signRevocationList({ revoked, updated: new Date().toISOString() }, fs.readFileSync(PRIV, "utf8"));
  fs.mkdirSync(path.dirname(REVOCATIONS), { recursive: true });
  fs.writeFileSync(REVOCATIONS, JSON.stringify(doc, null, 2) + "\n", "utf8");
  return { file: REVOCATIONS, count: revoked.length };
}

module.exports = { load, save, record, find, writeRevocationList, REGISTRY, REVOCATIONS, PRIV };
