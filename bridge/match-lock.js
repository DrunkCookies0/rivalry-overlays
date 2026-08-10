/* =============================================================================
 * RIVALRY match lock: the loaded league match, persisted
 * -----------------------------------------------------------------------------
 * The app is match-first: a broadcast starts by loading a real league match,
 * and the packaged app serves no overlay scene until one is loaded. This
 * module owns that state. The rule is LOAD ONCE, THEN CACHE: locking requires
 * the league API to answer (the match must exist in the system right now), but
 * once locked the normalized match AND its logo bytes live on disk, so a
 * league outage or an app restart mid-show never takes the broadcast down.
 *
 * On disk (all under <userData>):
 *   active-match.json   { matchId, lockedAt, match, logos: {a,b: contentType|null} }
 *   match-logo-a.bin    raw logo bytes for teams[0] (absent when the team has none)
 *   match-logo-b.bin    raw logo bytes for teams[1]
 *
 * Pure node (fs + path only) so it unit-tests without Electron.
 * ===========================================================================*/

"use strict";

const fs = require("fs");
const path = require("path");

function createMatchLock({ userDataDir }) {
  const stateFile = path.join(userDataDir, "active-match.json");
  const logoFile = (side) => path.join(userDataDir, `match-logo-${side}.bin`);

  // In-memory mirror of the disk state. null = no match locked.
  let current = null;

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      // A lock without a matchId is corrupt; treat as unlocked rather than
      // serving scenes against a half-written state.
      current = raw && typeof raw === "object" && raw.matchId ? raw : null;
    } catch {
      current = null;
    }
    return current;
  }

  function isLocked() {
    return !!(current && current.matchId);
  }

  function get() {
    return current;
  }

  // Lock to a match. `match` is the normalizeMatch() shape; `logos` carries
  // the downloaded bytes ({ contentType, body } or null per side). Everything
  // is written before the in-memory state flips, so a crash mid-write leaves
  // either the old lock or the new one, never a lock without its logos.
  function set(matchId, match, logos = {}) {
    for (const side of ["a", "b"]) {
      const logo = logos[side];
      try {
        if (logo && logo.body) fs.writeFileSync(logoFile(side), logo.body);
        else if (fs.existsSync(logoFile(side))) fs.unlinkSync(logoFile(side));
      } catch (e) {
        console.error(`[rivalry] match-lock logo ${side} write:`, e.message);
      }
    }
    const next = {
      matchId: String(matchId),
      lockedAt: new Date().toISOString(),
      match: match || null,
      logos: {
        a: logos.a && logos.a.body ? { contentType: logos.a.contentType || "image/png" } : null,
        b: logos.b && logos.b.body ? { contentType: logos.b.contentType || "image/png" } : null,
      },
    };
    fs.writeFileSync(stateFile, JSON.stringify(next, null, 2), "utf8");
    current = next;
    return current;
  }

  function clear() {
    current = null;
    try { if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile); } catch {}
    for (const side of ["a", "b"]) {
      try { if (fs.existsSync(logoFile(side))) fs.unlinkSync(logoFile(side)); } catch {}
    }
  }

  // Cached logo bytes for the LOCKED match. Returns { contentType, body } or
  // null. This is what makes team logos league-outage-proof: the /league/logo
  // proxy serves these before ever considering the network.
  function getLogo(side) {
    if (!isLocked()) return null;
    const meta = current.logos && current.logos[side];
    if (!meta) return null;
    try {
      return { contentType: meta.contentType || "image/png", body: fs.readFileSync(logoFile(side)) };
    } catch {
      return null;
    }
  }

  // Safe-to-broadcast summary (no logo bytes, no upstream URLs).
  function status() {
    if (!isLocked()) return { locked: false };
    const m = current.match || {};
    const teams = Array.isArray(m.teams) ? m.teams : [];
    return {
      locked: true,
      matchId: current.matchId,
      lockedAt: current.lockedAt,
      event: m.event || {},
      scheduledDate: m.scheduledDate || "",
      teams: teams.map((t, i) =>
        t
          ? {
              name: t.name || "",
              record: t.record || "",
              players: Array.isArray(t.players) ? t.players : [],
              hasLogo: !!(current.logos && current.logos[i === 0 ? "a" : "b"]),
            }
          : null
      ),
    };
  }

  load();
  return { load, isLocked, get, set, clear, getLogo, status };
}

module.exports = { createMatchLock };
