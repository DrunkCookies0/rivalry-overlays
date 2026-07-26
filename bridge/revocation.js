/* =============================================================================
 * Access-key revocation  (main process)
 * -----------------------------------------------------------------------------
 * Keys don't expire by default; they are withdrawn by publishing a SIGNED list
 * of key ids. Because the list is signed with the same private key as the keys
 * themselves, it can be published as a plain static file anywhere — a web
 * server, an object store, the public repo — with no service to run and no need
 * to trust the host. Nobody but the key holder can forge or edit one.
 *
 * Three sources, strongest wins by `updated` date:
 *   1. the copy that shipped in the build   (works with no network, ever)
 *   2. the last one we successfully fetched (cached in userData)
 *   3. a fresh fetch                        (best effort, on a timer)
 *
 * FAIL OPEN, deliberately. If the list can't be fetched, the last known-good
 * one stands. This runs on machines that are mid-broadcast; a flaky connection
 * or a DNS hiccup must never be able to black out someone's overlays. The cost
 * is that a revoked holder who stays offline keeps working — accepted, and
 * anyway they'd lose live league data too.
 *
 * ROLLBACK PROTECTION: a fetched list is only adopted if its `updated` is at
 * least as new as what we already trust, so an old signed list (which is
 * genuinely signed, just stale) can't be replayed to un-revoke someone.
 * ===========================================================================*/

"use strict";

const fs = require("fs");
const path = require("path");

const { verifyRevocationList } = require("./license");

const CACHE_FILE = "revoked-cache.json";
const FETCH_TIMEOUT_MS = 8000;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// "" sorts before any ISO date, so an undated list never beats a dated one.
function isNewer(a, b) {
  return String(a || "") >= String(b || "");
}

/**
 * @param {object} opts
 * @param {string} opts.shippedFile  config/casterverse-revoked.json inside the app
 * @param {string} opts.userDataDir  where the fetched copy is cached
 * @param {string} opts.url          where to fetch updates from
 * @param {() => string|null} opts.getPublicKey
 */
function createRevocationStore({ shippedFile, userDataDir, url, getPublicKey }) {
  // Starts empty rather than "everything revoked": an app that can't read any
  // list must still work.
  let current = { revoked: new Set(), updated: "", source: "none" };

  function adopt(doc, source) {
    const check = verifyRevocationList(doc, getPublicKey());
    if (!check.valid) return { adopted: false, reason: check.reason };
    if (!isNewer(check.updated, current.updated)) {
      return { adopted: false, reason: "older than the list already loaded" };
    }
    current = { revoked: new Set(check.revoked), updated: check.updated, source };
    return { adopted: true, count: check.revoked.length, updated: check.updated };
  }

  // Shipped first, then the cache on top if it is newer.
  function loadLocal() {
    if (shippedFile) adopt(readJson(shippedFile), "shipped");
    if (userDataDir) adopt(readJson(path.join(userDataDir, CACHE_FILE)), "cache");
    return status();
  }

  async function refresh() {
    if (!url) return { ok: false, reason: "no url" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
    try {
      const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
      if (!res.ok) return { ok: false, reason: "http-" + res.status };
      const doc = await res.json();
      const result = adopt(doc, "fetched");
      // Only cache what we adopted: never persist a list that failed its
      // signature check or that would roll us backwards.
      if (result.adopted && userDataDir) {
        try {
          fs.writeFileSync(path.join(userDataDir, CACHE_FILE), JSON.stringify(doc, null, 2), "utf8");
        } catch (e) {
          console.error("[rivalry] could not cache revocation list:", e.message);
        }
      }
      return { ok: true, ...result };
    } catch (e) {
      // Offline, blocked, timed out — keep whatever we already trust.
      return { ok: false, reason: (e && e.name === "AbortError") ? "timeout" : (e && e.message) || "fetch failed" };
    } finally {
      clearTimeout(timer);
    }
  }

  function status() {
    return { count: current.revoked.size, updated: current.updated, source: current.source };
  }

  return {
    loadLocal,
    refresh,
    status,
    get revoked() { return current.revoked; },
    isRevoked: (id) => current.revoked.has(String(id)),
  };
}

module.exports = { createRevocationStore, CACHE_FILE };
