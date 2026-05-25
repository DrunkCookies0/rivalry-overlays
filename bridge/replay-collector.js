/* =============================================================================
 * RIVALRY Replay Collector
 * -----------------------------------------------------------------------------
 * Rocket League writes .replay files to its Demos folder for matches played /
 * spectated on the local PC. This module watches that folder; the Stats API
 * itself cannot export replays, so we rely on whatever RL writes natively.
 * Folder-watching is EAC-safe — no modding, no game injection.
 *
 * Different mechanism from rockpload, which authenticates via Epic Games OAuth
 * and pulls replays from Psyonix's backend (RLAPI). Folder watching captures
 * only what's saved locally; the upside is we tag each archived replay with
 * the event + team context from the operator's control panel.
 *
 * This module watches that Demos folder. When a NEW replay appears, it copies
 * it into an organized archive:
 *
 *   <archive>/<Event>/<TeamA vs TeamB>/<TeamA-vs-TeamB__Game3__2026-05-23_19-41-08.replay>
 *
 * and writes a sidecar .json with the match context (teams, event, game number,
 * timestamp) so the files can be auto-uploaded to match pages later.
 *
 * Match context (team names, event title) comes from the control panel, which
 * the collector subscribes to over the control relay WebSocket - same data the
 * overlay sees. No coupling to the bridge internals.
 * ===========================================================================*/

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// ---- pure helpers (unit-tested) -------------------------------------------

function sanitize(s, fallback) {
  const cleaned = String(s == null ? "" : s)
    .replace(/[^A-Za-z0-9 _-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/ /g, "-")
    .slice(0, 60);
  return cleaned || fallback;
}

function stamp(date) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`
  );
}

// Returns { eventDir, matchupDir, fileBase } relative names for a replay.
function composePaths(ctx, gameIndex, date) {
  const event = sanitize(ctx.eventTitle, "RIVALRY");
  const a = sanitize(ctx.teamA, "Team-A");
  const b = sanitize(ctx.teamB, "Team-B");
  const matchup = `${a}-vs-${b}`;
  const fileBase = `${matchup}__Game${gameIndex}__${stamp(date)}`;
  return { eventDir: event, matchupDir: matchup, fileBase };
}

function findDemosDir() {
  const rel = path.join("My Games", "Rocket League", "TAGame", "Demos");
  const candidates = [
    path.join(os.homedir(), "Documents", rel),
    path.join(os.homedir(), "OneDrive", "Documents", rel),
  ];
  for (const c of candidates) if (safeIsDir(c)) return c;
  return null;
}

function safeIsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listReplays(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".replay"));
  } catch {
    return [];
  }
}

// ---- collector -------------------------------------------------------------

function startReplayCollector(opts = {}) {
  const pollMs = opts.pollMs || 4000;
  const controlUrl = opts.controlUrl || "ws://localhost:49777";
  const archiveDir = opts.archiveDir || path.join(os.homedir(), "Documents", "RIVALRY Replays");
  const demosDir = opts.demosDir || findDemosDir();

  let context = { eventTitle: "RIVALRY", teamA: "", teamB: "" };
  let count = 0;
  const seen = new Set(); // replay filenames already handled
  const pending = new Map(); // name -> last observed size (waiting for write to settle)

  try { fs.mkdirSync(archiveDir, { recursive: true }); } catch {}

  // snapshot existing replays so we only collect ones created from now on
  if (demosDir) for (const f of listReplays(demosDir)) seen.add(f);

  // subscribe to control panel state for match context (best-effort)
  let ws = null;
  if (!opts.noControl) connectControl();
  function connectControl() {
    let WebSocket;
    try { WebSocket = require("ws"); } catch { return; }
    try {
      ws = new WebSocket(controlUrl);
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg && msg.type === "control" && msg.payload) setContextFromControl(msg.payload);
        } catch {}
      });
      ws.on("close", () => setTimeout(connectControl, 2000));
      ws.on("error", () => { try { ws.close(); } catch {} });
    } catch {}
  }
  function setContextFromControl(payload) {
    context = {
      eventTitle: payload.eventTitle || context.eventTitle || "RIVALRY",
      teamA: (payload.teamA && payload.teamA.name) || context.teamA || "",
      teamB: (payload.teamB && payload.teamB.name) || context.teamB || "",
    };
  }

  function collect(name) {
    if (!demosDir) return;
    const src = path.join(demosDir, name);
    const now = new Date();
    const { eventDir, matchupDir, fileBase } = composePaths(context, 0, now);
    const targetDir = path.join(archiveDir, eventDir, matchupDir);
    try { fs.mkdirSync(targetDir, { recursive: true }); } catch {}

    // game number = how many replays already archived for this matchup + 1
    const existing = listReplays(targetDir).length;
    const gameIndex = existing + 1;
    const base = composePaths(context, gameIndex, now).fileBase;

    let dest = path.join(targetDir, base + ".replay");
    let n = 1;
    while (fs.existsSync(dest)) dest = path.join(targetDir, `${base}-${n++}.replay`);

    try {
      fs.copyFileSync(src, dest);
      const meta = {
        event: context.eventTitle,
        teamA: context.teamA || null,
        teamB: context.teamB || null,
        game: gameIndex,
        savedAt: now.toISOString(),
        sourceFile: name,
        replayFile: path.basename(dest),
      };
      fs.writeFileSync(dest.replace(/\.replay$/, ".json"), JSON.stringify(meta, null, 2));
      count++;
      console.log(`[rivalry] replay archived -> ${dest}`);
    } catch (e) {
      console.error("[rivalry] replay copy failed:", e.message);
    }
  }

  function poll() {
    if (!demosDir) return;
    for (const name of listReplays(demosDir)) {
      if (seen.has(name)) continue;
      let size = -1;
      try { size = fs.statSync(path.join(demosDir, name)).size; } catch { continue; }
      // wait until the file size is stable across two polls (write finished)
      if (pending.get(name) === size && size > 0) {
        pending.delete(name);
        seen.add(name);
        collect(name);
      } else {
        pending.set(name, size);
      }
    }
  }

  const timer = demosDir ? setInterval(poll, pollMs) : null;
  if (demosDir) console.log(`[rivalry] replay collector watching ${demosDir} -> ${archiveDir}`);
  else console.log("[rivalry] replay collector: RL Demos folder not found yet (will not collect)");

  return {
    archiveDir,
    demosDir,
    getCount: () => count,
    _collect: collect, // testing
    _setContext: (c) => { context = Object.assign(context, c); },
    _poll: poll, // testing
    stop: () => { if (timer) clearInterval(timer); if (ws) try { ws.close(); } catch {} },
  };
}

module.exports = { startReplayCollector, composePaths, sanitize, stamp, findDemosDir };
