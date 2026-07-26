/* =============================================================================
 * revoke-key.js  —  withdraw (or restore) someone's Casterverse access
 * -----------------------------------------------------------------------------
 *   npm run key:revoke -- --name "Moldybanana"
 *   npm run key:revoke -- --id 6798f492 --reason "left the caster program"
 *   npm run key:revoke -- --name "Moldybanana" --undo
 *
 * Rewrites the signed list at config/casterverse-revoked.json. Publish that file
 * for it to take effect on installs in the wild — see PUBLISH below.
 * ===========================================================================*/

"use strict";

const registry = require("./key-registry");

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
}

const needle = arg("--id") || arg("--name");
const undo = process.argv.includes("--undo");

if (!needle) {
  console.error('usage: npm run key:revoke -- --name "Their Name" | --id <keyid> [--reason "..."] [--undo]');
  process.exit(1);
}

const reg = registry.load();
const matches = registry.find(reg, needle);

if (!matches.length) {
  console.error(`[key:revoke] no issued key matches "${needle}".`);
  console.error("[key:revoke] run `npm run key:list` to see what has been issued.");
  process.exit(1);
}
if (matches.length > 1) {
  // Two keys for the same person is normal (reissue). Make the operator pick,
  // rather than guessing which one they meant.
  console.error(`[key:revoke] "${needle}" matches ${matches.length} keys. Re-run with --id:`);
  for (const k of matches) {
    console.error(`  --id ${k.id}   issued ${k.issued}  ${k.revoked ? "(already revoked)" : ""}`);
  }
  process.exit(1);
}

const key = matches[0];
if (undo) {
  if (!key.revoked) {
    console.log(`[key:revoke] ${key.name} (${key.id}) is not revoked. Nothing to undo.`);
    process.exit(0);
  }
  key.revoked = null;
} else {
  if (key.revoked) {
    console.log(`[key:revoke] ${key.name} (${key.id}) was already revoked on ${key.revoked.at}.`);
    process.exit(0);
  }
  key.revoked = { at: new Date().toISOString(), reason: arg("--reason") || "" };
}

registry.save(reg);
const written = registry.writeRevocationList(reg);

console.log("");
console.log(`  ${undo ? "RESTORED" : "REVOKED"}: ${key.name}  (key id ${key.id})`);
if (!undo && key.revoked && key.revoked.reason) console.log(`  reason  : ${key.revoked.reason}`);
console.log(`  list now: ${written.count} revoked key(s) -> ${written.file}`);
console.log("");
console.log("  PUBLISH so installs pick it up:");
console.log("    git add config/casterverse-revoked.json && git commit -m \"chore: revoke a key\" && git push");
console.log("  (or copy that one file to wherever you host the list)");
console.log("");
