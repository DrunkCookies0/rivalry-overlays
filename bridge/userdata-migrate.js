/* =============================================================================
 * userData migration  (main process)
 * -----------------------------------------------------------------------------
 * Electron derives the userData folder name from the app's productName, so the
 * "RIVALRY Overlay" -> "RIVALRY Casterverse" rebrand moves it. Without this,
 * an existing producer's saved OBS connection, league key, uploaded logos and
 * "setup already done" marker would silently vanish behind the new name and
 * the app would look like a fresh install.
 *
 * Deliberately narrow:
 *   - Copies an ALLOWLIST of our own files, never the whole folder (the old
 *     directory also holds Chromium's Cache/GPUCache/Local Storage, which must
 *     not be carried across).
 *   - Never overwrites: anything already present in the new folder wins.
 *   - Runs once, guarded by a marker file, so a producer who deliberately
 *     resets the new install doesn't get the old state pushed back on them.
 *   - Never throws. A migration failure must not stop the app from booting;
 *     worst case the producer redoes setup.
 * ===========================================================================*/

"use strict";

const fs = require("fs");
const path = require("path");

const MARKER = ".migrated-from-overlay";

// Our own state only. Chromium's caches and the signing-irrelevant rest of the
// profile stay behind.
const FILES = [
  "control-state.json",   // retained scorebar / caster / queue payload
  "obs-settings.json",    // websocket url + password + scene map
  "league-settings.json", // league API key
  "dev-settings.json",    // local-repo serving path
  ".setup-complete",      // first-run wizard marker
  ".autostart-initialised",
];
const DIRS = ["user-assets"]; // uploaded team logos

function copyDirShallow(from, to) {
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const dest = path.join(to, entry.name);
    if (fs.existsSync(dest)) continue;
    fs.copyFileSync(path.join(from, entry.name), dest);
    n++;
  }
  return n;
}

/**
 * Copy legacy state into the current userData folder, once.
 * Pure enough to unit test: both paths are injected, nothing reads Electron.
 * @returns {{migrated:boolean, from?:string, copied:string[], reason?:string}}
 */
function migrateUserData(fromDir, toDir) {
  const result = { migrated: false, copied: [] };
  try {
    if (!fromDir || !toDir) return { ...result, reason: "missing-path" };
    if (path.resolve(fromDir) === path.resolve(toDir)) return { ...result, reason: "same-dir" };
    fs.mkdirSync(toDir, { recursive: true });
    if (fs.existsSync(path.join(toDir, MARKER))) return { ...result, reason: "already-migrated" };
    if (!fs.existsSync(fromDir)) {
      // Nothing to bring across, but still stamp the marker: this producer is a
      // clean install and shouldn't be re-checked on every boot.
      fs.writeFileSync(path.join(toDir, MARKER), new Date().toISOString());
      return { ...result, reason: "no-legacy-dir" };
    }

    for (const name of FILES) {
      const src = path.join(fromDir, name);
      const dest = path.join(toDir, name);
      if (!fs.existsSync(src) || fs.existsSync(dest)) continue;
      fs.copyFileSync(src, dest);
      result.copied.push(name);
    }
    for (const name of DIRS) {
      const src = path.join(fromDir, name);
      if (!fs.existsSync(src)) continue;
      const n = copyDirShallow(src, path.join(toDir, name));
      if (n) result.copied.push(`${name}/ (${n} files)`);
    }

    fs.writeFileSync(path.join(toDir, MARKER), new Date().toISOString());
    return { ...result, migrated: result.copied.length > 0, from: fromDir };
  } catch (e) {
    return { ...result, reason: (e && e.message) || "error" };
  }
}

module.exports = { migrateUserData, MARKER, FILES, DIRS };
