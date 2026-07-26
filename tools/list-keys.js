/* =============================================================================
 * list-keys.js  —  who currently holds a Casterverse access key
 * -----------------------------------------------------------------------------
 *   npm run key:list
 *
 * Reads the local registry (keys/issued-keys.json). Keys issued before the
 * registry existed only appear in keys/issued-keys.log.
 * ===========================================================================*/

"use strict";

const fs = require("fs");
const path = require("path");
const registry = require("./key-registry");

const reg = registry.load();

if (!reg.keys.length) {
  console.log("No keys issued yet. Issue one with:");
  console.log('  npm run key:issue -- --name "Their Name"');
  const legacy = path.join(__dirname, "..", "keys", "issued-keys.log");
  if (fs.existsSync(legacy)) console.log("\n(older keys are logged in " + legacy + ")");
  process.exit(0);
}

const rows = reg.keys.map((k) => ({
  status: k.revoked ? "REVOKED" : "active",
  id: k.id,
  name: k.name,
  tier: k.tier,
  issued: k.issued,
  expires: k.expires || "never",
  note: k.revoked ? (k.revoked.reason || "revoked " + String(k.revoked.at).slice(0, 10)) : k.note || "",
}));

const w = (key, head) => Math.max(head.length, ...rows.map((r) => String(r[key]).length));
const cols = [
  ["status", "STATUS"], ["id", "KEY ID"], ["name", "ISSUED TO"],
  ["tier", "TIER"], ["issued", "ISSUED"], ["expires", "EXPIRES"], ["note", "NOTE"],
];
const widths = cols.map(([k, h]) => w(k, h));

console.log("");
console.log(cols.map(([, h], i) => h.padEnd(widths[i])).join("  "));
console.log(widths.map((n) => "-".repeat(n)).join("  "));
for (const r of rows) {
  console.log(cols.map(([k], i) => String(r[k]).padEnd(widths[i])).join("  "));
}
const active = rows.filter((r) => r.status === "active").length;
console.log("");
console.log(`${active} active, ${rows.length - active} revoked`);
if (fs.existsSync(registry.REVOCATIONS)) {
  try {
    const doc = JSON.parse(fs.readFileSync(registry.REVOCATIONS, "utf8"));
    console.log(`published list: ${doc.revoked.length} revoked, updated ${doc.updated}`);
  } catch { /* unreadable list is reported by key:revoke when it rewrites */ }
}
console.log("");
