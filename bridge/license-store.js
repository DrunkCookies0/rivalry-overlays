/* =============================================================================
 * Casterverse access key persistence: <userData>/license.json
 * -----------------------------------------------------------------------------
 * Mirrors league-settings.js — bridge/license.js stays pure crypto, this file
 * owns the disk. Kept out of the repo and out of every broadcast: the key names
 * the person it was issued to, so leaking one is both an access and a privacy
 * problem. Use license.maskKey() anywhere a key must be shown.
 * ===========================================================================*/

"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULTS = { key: "", activatedAt: "" };

function storePath(userDataDir) {
  return path.join(userDataDir, "license.json");
}

function load(userDataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(userDataDir), "utf8"));
    return { ...DEFAULTS, ...parsed, key: String(parsed.key || "").trim() };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(userDataDir, state) {
  try {
    fs.writeFileSync(storePath(userDataDir), JSON.stringify(state, null, 2), "utf8");
    return true;
  } catch (e) {
    // e.message only — never the state object (it holds the key)
    console.error("[rivalry] could not save license:", e.message);
    return false;
  }
}

module.exports = { load, save, storePath, DEFAULTS };
