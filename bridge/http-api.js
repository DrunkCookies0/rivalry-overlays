/* =============================================================================
 * RIVALRY local HTTP API router
 * -----------------------------------------------------------------------------
 * All NEW app endpoints on the 49080 server land here instead of inline in
 * main.js, so feature work never has to touch the (hot, shared) main.js
 * request handler again. main.js calls router.handle(req, res, urlPath) first;
 * a `false` return falls through to the existing static-file + overlay-gate
 * path unchanged.
 *
 * The server binds 127.0.0.1 only. Endpoints here must stay safe under that
 * assumption: no secrets in responses, no destructive side effects, and
 * anything a random local webpage could trigger cross-origin must be
 * idempotent and harmless.
 *
 * Sections (append-only per feature, to keep parallel branches conflict-free):
 *   1. STATUS / SETUP    - first-run wizard + panel status
 *   2. OBS COLLECTION    - importable scene-collection download
 *   3. LEAGUE            - league-API proxy + the match lock (key stays in the
 *                          main process; the lock is what gates the broadcast)
 *   4. DIAGNOSTICS       - one-file support bundle (secrets masked)
 * ===========================================================================*/

"use strict";

// ctx wires the router to main.js state via getters (late-bound: the bridge
// and OBS controller are created after the HTTP server starts).
//   {
//     userDataDir,          // app.getPath("userData")
//     meta,                 // build meta from app-meta.js
//     getBridge,            // () => bridge handle or null
//     getObs,               // () => ({ settings, status }) or null
//     getSetupInfo,         // () => last runSetup() result
//     rewriteIni,           // () => re-runs runSetup(), returns fresh result
//     isSetupComplete,      // () => boolean
//     markSetupComplete,    // () => void (writes the userData marker)
//   }
function createApiRouter(ctx) {
  function sendJson(res, code, obj) {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  }

  // ---------------------------------------------------------------------------
  // 1. STATUS / SETUP
  // ---------------------------------------------------------------------------

  function statusJson(res) {
    const bridge = ctx.getBridge();
    const rl = bridge && bridge.getRlStatus ? bridge.getRlStatus() : null;
    const setup = ctx.getSetupInfo() || {};
    const obs = ctx.getObs() || {};
    sendJson(res, 200, {
      version: ctx.meta || null,
      rl: rl || { connected: false, receivingData: false, lastEventAt: null, mock: false },
      ini: {
        written: !!setup.ok,
        dirFound: !!setup.dirFound,
        paths: setup.written || [],
        checked: setup.checked || [],
      },
      obs: {
        enabled: !!(obs.settings && obs.settings.enabled),
        connected: !!(obs.status && obs.status.connected),
        error: (obs.status && obs.status.error) || null,
      },
      // The match lock: whether a league match is loaded (the packaged app
      // serves no scene without one) and which. Names only, never logo bytes.
      match: ctx.getMatchLock && ctx.getMatchLock() ? ctx.getMatchLock().status() : { locked: false },
      setupComplete: ctx.isSetupComplete(),
    });
  }

  function handleStatusSetup(req, res, urlPath) {
    if (req.method === "GET" && urlPath === "/status.json") {
      statusJson(res);
      return true;
    }
    if (req.method === "POST" && urlPath === "/setup/complete") {
      ctx.markSetupComplete();
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (req.method === "POST" && urlPath === "/setup/rewrite-ini") {
      const r = ctx.rewriteIni();
      sendJson(res, 200, {
        ok: !!r.ok,
        dirFound: !!r.dirFound,
        paths: r.written || [],
        checked: r.checked || [],
      });
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // 2. OBS COLLECTION — importable scene-collection download
  // ---------------------------------------------------------------------------
  // Generated fresh per request from the overlay registry so scene names and
  // URLs can never drift from what the app actually serves. Import in OBS via
  // the Scene Collection menu -> Import.

  function handleObsCollection(req, res, urlPath) {
    if (req.method === "GET" && urlPath === "/obs/scene-collection.json") {
      try {
        const { buildSceneCollection } = require("./obs-collection");
        const reg = ctx.getOverlayReg ? ctx.getOverlayReg() : { list: [] };
        const gated = ctx.gateActive ? ctx.gateActive() : false;
        const overlays = (reg.list || []).filter((o) => (gated ? o.approved : true));
        // ?set= overrides; otherwise the producer's saved look drives the
        // build, same as the live websocket path.
        const q = new URLSearchParams((req.url || "").split("?")[1] || "");
        const obs = ctx.getObs ? ctx.getObs() : null;
        const preferredSet = q.get("set") || (obs && obs.settings && obs.settings.preferredSet) || "";
        const collection = buildSceneCollection({
          overlays,
          baseUrl: `http://localhost:${ctx.httpPort}`,
          preferredSet,
        });
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Disposition": 'attachment; filename="rivalry-casterverse.json"',
        });
        res.end(JSON.stringify(collection, null, 2));
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message });
      }
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // 3. LEAGUE — league-API proxy + the match lock
  // ---------------------------------------------------------------------------
  // The panel never talks to the league site directly: the API key lives in
  // the main process only, and logo bytes stream through /league/logo so the
  // upstream's ~15-minute expiring URLs never reach OBS or the control state.
  //
  // The MATCH LOCK is the product rule made concrete: a broadcast starts by
  // locking a real league match (POST /league/lock proves it exists in the
  // system right now), and the packaged app serves no overlay scene without
  // one (gate in main.js). Load once, then cache: the lock persists the match
  // and its logo bytes, so the league going down mid-show changes nothing.

  function leagueQuery(req) {
    const q = (req.url || "").split("?")[1] || "";
    return new URLSearchParams(q);
  }

  // Small JSON body reader for the lock endpoints (the app had no JSON POSTs
  // before this). Caps well above any {matchId} payload; malformed input
  // resolves to {} rather than throwing into the request handler.
  function readJsonBody(req, maxBytes = 64 * 1024) {
    return new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(); resolve({}); return; }
        chunks.push(c);
      });
      req.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { resolve({}); }
      });
      req.on("error", () => resolve({}));
    });
  }

  // Normalize + swap team logos for the deterministic local proxy URLs, so the
  // expiring upstream URLs never reach the panel, the control state, or OBS.
  function withProxyLogos(normalized, id) {
    normalized.teams.forEach((t, i) => {
      if (!t) return;
      t.logoUrl = t.logoUrl
        ? `/league/logo?matchId=${encodeURIComponent(normalized.matchId || id)}&side=${i === 0 ? "a" : "b"}`
        : "";
    });
    return normalized;
  }

  function broadcastMatchStatus() {
    const bridge = ctx.getBridge && ctx.getBridge();
    const lock = ctx.getMatchLock && ctx.getMatchLock();
    if (!bridge || !bridge.broadcastControl || !lock) return;
    bridge.broadcastControl({ type: "match-status", payload: lock.status() });
  }

  function handleLeague(req, res, urlPath) {
    if (!urlPath.startsWith("/league/")) return false;
    const client = ctx.getLeagueClient ? ctx.getLeagueClient() : null;
    if (!client) {
      sendJson(res, 503, { ok: false, error: "league client not ready" });
      return true;
    }
    const matchLock = ctx.getMatchLock ? ctx.getMatchLock() : null;

    // --- the match lock -----------------------------------------------------
    // Lock = the one path into a broadcast. Validates the match against the
    // league RIGHT NOW (fresh fetch, no cache) and only then persists it with
    // its logo bytes. A failed lock leaves any existing lock untouched, so a
    // mid-show attempt to switch matches during an outage can't kill the show.
    if (req.method === "POST" && urlPath === "/league/lock") {
      readJsonBody(req).then(async (body) => {
        const id = String((body && body.matchId) || "").trim();
        if (!id) return sendJson(res, 400, { ok: false, error: "matchId required" });
        if (!matchLock) return sendJson(res, 503, { ok: false, error: "lock store not ready" });
        const r = await client.getMatch(id, { fresh: true });
        if (!r.ok) return sendJson(res, 502, r);
        const { normalizeMatch } = require("./league-client");
        const data = normalizeMatch(r.data);
        // Logo bytes ride into the lock so they survive outages/restarts. A
        // side with no logo (or a failed download) locks as logo-less rather
        // than failing the whole lock — the scenes degrade to initials.
        const logos = {};
        for (const side of ["a", "b"]) {
          const team = data.teams[side === "a" ? 0 : 1];
          if (!team || !team.logoUrl) { logos[side] = null; continue; }
          // fresh:false — the match was fetched fresh two lines up and is in
          // cache; forcing fresh here would refetch the match once per side.
          const logo = await client.getLogo(id, side, { fresh: false }).catch(() => null);
          logos[side] = logo && logo.ok ? { contentType: logo.contentType, body: logo.body } : null;
        }
        matchLock.set(data.matchId || id, data, logos);
        broadcastMatchStatus();
        sendJson(res, 200, { ok: true, data: withProxyLogos(data, id), status: matchLock.status() });
      }).catch((e) => {
        // Without this, a throw mid-lock (disk full, AV holding the lock file)
        // is an unhandled rejection and the panel's Load spinner hangs forever.
        sendJson(res, 500, { ok: false, error: "lock failed: " + (e && e.message ? e.message : String(e)) });
      });
      return true;
    }
    if (req.method === "POST" && urlPath === "/league/unlock") {
      if (matchLock) { matchLock.clear(); broadcastMatchStatus(); }
      sendJson(res, 200, { ok: true, status: matchLock ? matchLock.status() : { locked: false } });
      return true;
    }
    if (req.method === "GET" && urlPath === "/league/lock") {
      sendJson(res, 200, { ok: true, ...(matchLock ? matchLock.status() : { locked: false }) });
      return true;
    }

    if (req.method !== "GET") return false;
    if (urlPath === "/league/status") {
      client.validateKey().then((r) => {
        const s = ctx.getLeagueSettings ? ctx.getLeagueSettings() : {};
        sendJson(res, 200, {
          configured: !!(s.apiKey || s.mock),
          mock: !!s.mock,
          baseUrl: s.baseUrl || "",
          keyMask: ctx.maskLeagueKey ? ctx.maskLeagueKey(s.apiKey) : "",
          ok: r.ok,
          error: r.ok ? null : r.error,
          detail: r.ok ? (r.data || null) : (r.detail || null),
        });
      });
      return true;
    }
    // The match finder. The league API can only text-search team names, so
    // everything else a producer wants to narrow by (which circuit, which
    // round, is it tonight) is derived HERE from fields every match carries,
    // and handed to the panel already grouped. Doing it in the main process
    // means one request per search instead of the panel paging the API itself.
    if (urlPath === "/league/matches") {
      const q = leagueQuery(req);
      const search = q.get("search") || "";
      client.listMatches({ search }).then((r) => {
        if (!r.ok) return sendJson(res, 502, r);
        const { normalizeMatch } = require("./league-client");
        const data = (r.data || []).map(normalizeMatch);
        // Soonest first; matches with no date (byes, unscheduled) sink to the
        // bottom rather than sorting as epoch 0 at the top.
        data.sort((a, b) => {
          const ta = a.scheduledDate ? Date.parse(a.scheduledDate) : Infinity;
          const tb = b.scheduledDate ? Date.parse(b.scheduledDate) : Infinity;
          return (Number.isNaN(ta) ? Infinity : ta) - (Number.isNaN(tb) ? Infinity : tb);
        });
        const circuits = [];
        const rounds = new Set();
        for (const m of data) {
          const c = m.event.circuitShort || m.event.circuit;
          if (c && !circuits.includes(c)) circuits.push(c);
          if (m.round !== null) rounds.add(m.round);
        }
        sendJson(res, 200, {
          ok: true,
          data,
          circuits,
          rounds: [...rounds].sort((a, b) => a - b),
          total: r.total || data.length,
          // True when the API had more pages than we pulled. Surfaced so the
          // panel can say so instead of pretending this is the whole schedule.
          truncated: !!r.truncated,
          searched: search,
        });
      });
      return true;
    }
    if (urlPath.startsWith("/league/matches/")) {
      const id = urlPath.slice("/league/matches/".length);
      const fresh = leagueQuery(req).get("fresh") === "1";
      client.getMatch(id, { fresh }).then((r) => {
        if (!r.ok) return sendJson(res, 502, r);
        // Normalize here (single chokepoint for spec-shape drift); proxy URLs
        // via withProxyLogos so expiring upstream URLs never leave the process.
        const { normalizeMatch } = require("./league-client");
        sendJson(res, 200, { ok: true, data: withProxyLogos(normalizeMatch(r.data), id) });
      });
      return true;
    }
    // Ask 1 standings, coded ahead of the API (see league-client.getStandings).
    // Live today this returns the upstream 404 as {ok:false,error:"http-404"},
    // which the panel reads as "not live yet" and keeps the whole standings
    // surface hidden. Mock mode serves the fixture so the path stays testable.
    if (urlPath === "/league/standings") {
      const q = leagueQuery(req);
      client.getStandings({
        circuitId: q.get("circuitId") || "",
        circuit: q.get("circuit") || "",
      }).then((r) => {
        if (!r.ok) return sendJson(res, 502, r);
        const { normalizeStandings } = require("./league-client");
        sendJson(res, 200, { ok: true, data: normalizeStandings(r.data) });
      });
      return true;
    }
    if (urlPath === "/league/logo") {
      const q = leagueQuery(req);
      const matchId = q.get("matchId");
      const side = q.get("side");
      if (!matchId || !["a", "b"].includes(side)) {
        sendJson(res, 400, { ok: false, error: "matchId and side=a|b required" });
        return true;
      }
      // The LOCKED match serves from the lock's disk cache, never the network:
      // that is what keeps logos up when the league site is down mid-show.
      // (A locked side with no cached logo means the team has none — 404, do
      // not fall through to a network fetch that would also 404.)
      if (matchLock && matchLock.isLocked() && matchLock.get().matchId === matchId) {
        const cached = matchLock.getLogo(side);
        if (cached) {
          res.writeHead(200, { "Content-Type": cached.contentType, "Cache-Control": "no-store" });
          res.end(cached.body);
        } else {
          res.writeHead(404);
          res.end("no logo");
        }
        return true;
      }
      client.getLogo(matchId, side).then((r) => {
        if (!r.ok) {
          res.writeHead(404);
          return res.end("no logo");
        }
        res.writeHead(200, { "Content-Type": r.contentType || "image/png", "Cache-Control": "no-store" });
        res.end(r.body);
      });
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // 5. DIAGNOSTICS — one-file support bundle
  // ---------------------------------------------------------------------------
  // Everything a remote debugging session needs in a single JSON the producer
  // can send instead of describing symptoms: build, environment, RL/OBS/league
  // state, the overlay signature scan, and the recent log tail. NO SECRETS:
  // the league key appears masked, never in full.

  function buildDiagnostics() {
    const os = require("os");
    const appLog = require("./app-log");
    const bridge = ctx.getBridge();
    const setup = ctx.getSetupInfo() || {};
    const obs = ctx.getObs() || {};
    const league = ctx.getLeagueSettings ? ctx.getLeagueSettings() : {};
    const reg = ctx.getOverlayReg ? ctx.getOverlayReg() : null;
    return {
      generatedAt: new Date().toISOString(),
      build: ctx.meta || null,
      environment: {
        platform: process.platform,
        osRelease: os.release(),
        arch: process.arch,
        electron: process.versions.electron || null,
        userDataDir: ctx.userDataDir || null,
      },
      ports: { http: 49080, gameFeed: 49124, controlBus: 49777 },
      rl: (bridge && bridge.getRlStatus && bridge.getRlStatus()) || null,
      statsIni: {
        written: !!setup.ok,
        rlConfigDirFound: !!setup.dirFound,
        paths: setup.written || [],
        checked: setup.checked || [],
      },
      obs: {
        enabled: !!(obs.settings && obs.settings.enabled),
        url: (obs.settings && obs.settings.url) || null, // loopback only, not a secret
        connected: !!(obs.status && obs.status.connected),
        error: (obs.status && obs.status.error) || null,
        autoSwitchEnabled: !!(obs.settings && obs.settings.autoSwitchEnabled),
      },
      league: {
        configured: !!(league.apiKey || league.mock),
        mock: !!league.mock,
        baseUrl: league.baseUrl || "",
        keyMask: ctx.maskLeagueKey ? ctx.maskLeagueKey(league.apiKey) : "",
      },
      // Which match the broadcast is locked to (or that none is — the single
      // most likely reason a producer reports "my scenes are blank").
      match: ctx.getMatchLock && ctx.getMatchLock() ? ctx.getMatchLock().status() : { locked: false },
      overlays: reg
        ? {
            gateActive: ctx.gateActive ? ctx.gateActive() : null,
            scannedAt: reg.scannedAt || null,
            scenes: (reg.list || reg.overlays || []).map((o) => ({
              id: o.id, scene: o.scene, approved: !!o.approved, reason: o.reason || "", keyId: o.keyId || "",
            })),
          }
        : null,
      setupComplete: ctx.isSetupComplete(),
      recentLog: appLog.recentLines(200),
    };
  }

  function handleDiagnostics(req, res, urlPath) {
    if (req.method === "GET" && urlPath === "/diagnostics.json") {
      try {
        const body = JSON.stringify(buildDiagnostics(), null, 2);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Disposition": 'attachment; filename="casterverse-diagnostics.json"',
        });
        res.end(body);
      } catch (e) {
        sendJson(res, 500, { ok: false, error: "diagnostics failed: " + e.message });
      }
      return true;
    }
    return false;
  }

  return {
    // Returns true when the request was handled here.
    handle(req, res, urlPath) {
      return (
        handleStatusSetup(req, res, urlPath) ||
        handleObsCollection(req, res, urlPath) ||
        handleLeague(req, res, urlPath) ||
        handleDiagnostics(req, res, urlPath)
      );
    },
    // Exposed for the tray's "Export diagnostics" (writes the same bundle to
    // a file without going through HTTP).
    buildDiagnostics,
  };
}

module.exports = { createApiRouter };
