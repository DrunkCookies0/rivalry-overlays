/* =============================================================================
 * RIVALRY league API client  (main process)
 * -----------------------------------------------------------------------------
 * Talks to the LIVE rivalry-web /api/v1 surface on therivalry.gg. Shapes here
 * were taken from the published OpenAPI document (GET /api/docs/json) on
 * 2026-07-25, not from the older request doc in LEAGUE-API-SPEC.md — the two
 * disagree, and the live one wins. Every response-shape assumption is still
 * funneled through normalizeMatch(): one place to fix when the backend moves.
 *
 * What is actually live (and what it means for the product):
 *   POST /api/v1/matches/search   {search?, page, pageSize<=100}
 *        Text search matches TEAM / ROSTER NAMES only. There is no circuit,
 *        tier, region, week or date filter server-side, so the finder pulls
 *        pages and groups by the circuitName each match carries. If the
 *        backend ever adds real filters, they belong in listMatches().
 *   GET  /api/v1/matches/{id}
 *   GET  /api/v1/me               -> {message, keyName}
 *
 * Matches carry team wins/losses, so records fill themselves in; they were
 * hand-entered before because the older spec had no such field.
 *
 * Design notes:
 *   - createLeagueClient({ getSettings }) takes a GETTER, not a settings
 *     snapshot, so a key pasted into the control panel applies to the very
 *     next request without an app restart.
 *   - Every method resolves {ok:true, data} | {ok:false, error, detail?} and
 *     never throws on runtime conditions. error is one of:
 *       "no-key" | "network" | "http-401" | "http-404" | "http-<code>" |
 *       "bad-json" | "mock-missing"
 *   - Logo URLs from the API expire ~15 min after issue (spec section 3), so
 *     getLogo() downloads the BYTES and caches them 10 min. This backs a
 *     localhost proxy: OBS/panel <img> tags only ever see a stable local URL,
 *     never the expiring upstream one.
 *   - MOCK MODE (settings.mock, or {forceMock:true} at construction) serves
 *     spec-verbatim fixtures from config/league-fixtures/ instead of the
 *     network, so the producer flow is buildable/demoable today.
 *   - SECURITY: the x-api-key header is only ever sent to settings.baseUrl.
 *     Logo images live on presigned third-party URLs (R2/CDN), so the image
 *     fetch deliberately carries NO key — sending it there would leak it.
 *     The key never appears in logs or error details.
 * ===========================================================================*/

"use strict";

const fs = require("fs");
const path = require("path");

const { DEFAULTS } = require("./league-settings");
const license = require("./license");

// Fixtures resolve relative to this module, not cwd, so mock mode works the
// same from the packaged app, `node --test`, and a dev shell.
const FIXTURES_DIR = path.join(__dirname, "..", "config", "league-fixtures");

const REQUEST_TIMEOUT_MS = 10000;
// One TTL for match JSON and logo bytes: comfortably under the ~15 min
// upstream URL expiry, long enough that a broadcast doesn't hammer the API.
const CACHE_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// normalizeMatch — the SINGLE place spec-shape assumptions live
// ---------------------------------------------------------------------------

// Strings only; numbers are stringified (round labels etc. sometimes arrive
// numeric), everything else becomes "" so renderers never see undefined.
function str(v) {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function normalizePlayer(rawPlayer) {
  const p = rawPlayer && typeof rawPlayer === "object" ? rawPlayer : {};
  return {
    userId: str(p.userId),
    name: str(p.name),
    // Live field is teamRole ("captain" etc.). Surfaced as `title` too because
    // that is what the player-titles overlay binding already reads.
    role: str(p.teamRole),
    title: str(p.teamRole),
    stats: p.stats && typeof p.stats === "object" ? p.stats : null,
  };
}

// A team, or null for the empty side of a bye. wins/losses are the team's
// standing in the circuit, which is exactly the "4-1" record the scorebar wants.
function normalizeTeam(rawTeam) {
  if (!rawTeam || typeof rawTeam !== "object") return null;
  const wins = num(rawTeam.wins);
  const losses = num(rawTeam.losses);
  return {
    rosterId: str(rawTeam.rosterId),
    name: str(rawTeam.name),
    logoUrl: str(rawTeam.logoUrl),
    wins,
    losses,
    record: `${wins}-${losses}`,
    players: Array.isArray(rawTeam.players) ? rawTeam.players.map(normalizePlayer) : [],
  };
}

// Pure. Accepts anything (including null / non-objects) and returns the
// overlay-side match shape with every field safely defaulted.
//
// teams stays a 2-slot ARRAY even though the API sends team1/team2: overlays,
// the logo proxy and the control panel all think in side a / side b, and a bye
// simply leaves slot b null rather than shifting everything up by one.
function normalizeMatch(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const season = str(src.seasonName);
  const circuit = str(src.circuitName);
  const round = typeof src.round === "number" && Number.isFinite(src.round) ? src.round : null;
  const roundLabel = round === null ? "" : `Round ${round}`;
  // Live circuit names carry their own season prefix: seasonName is
  // "Summer Circuit 2026" while circuitName is "Summer 2026 | 3v3 US-East".
  // Composing the two verbatim put a season on the broadcast header twice
  // ("Summer Circuit 2026 | Summer 2026 | 3v3 US-East"). circuitShort is the
  // part that actually identifies the circuit; it feeds the header line and the
  // panel's filter chips, while event.circuit keeps the untouched original.
  let circuitShort = circuit;
  if (season && circuit.toLowerCase().startsWith(season.toLowerCase())) {
    // Empty remainder means the circuit IS the season; leave it blank so the
    // header line doesn't print the season twice. Callers fall back to the
    // full circuit name for labels.
    circuitShort = circuit.slice(season.length).replace(/^\s*[|\-–—:]\s*/, "").trim();
  } else if (circuit.includes("|")) {
    // Drop a leading segment only when it reads like a season (carries a
    // year), so a circuit legitimately named "Open | Qualifier" keeps both
    // halves.
    const [head, ...rest] = circuit.split("|");
    if (rest.length && /\b(19|20)\d{2}\b/.test(head)) circuitShort = rest.join("|").trim();
  }
  return {
    matchId: str(src.id),
    round,
    isBye: src.isBye === true,
    isForfeitLoss: src.isForfeitLoss === true,
    event: {
      season,
      circuit,
      circuitShort,
      roundLabel,
      // Broadcast header line; empty segments are skipped, never " |  | ".
      composedTitle: [season, circuitShort, roundLabel].filter(Boolean).join(" | "),
    },
    scheduledDate: str(src.scheduledDate),
    teams: [normalizeTeam(src.team1), normalizeTeam(src.team2)],
  };
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------
function createLeagueClient({ getSettings, forceMock = false } = {}) {
  // matchId -> {fetchedAt, data} ; `${matchId}:${side}` -> {fetchedAt, contentType, body}
  const matchCache = new Map();
  const logoCache = new Map();

  // Re-read settings on EVERY call (late-bound: see header).
  function settings() {
    const current = typeof getSettings === "function" ? getSettings() : null;
    return { ...DEFAULTS, ...(current || {}) };
  }

  function isMock(s) {
    return forceMock || s.mock === true;
  }

  // -- transport --------------------------------------------------------
  async function fetchWithTimeout(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    // Don't let a hung request keep the process alive (matters for tests/CLI).
    if (typeof timer.unref === "function") timer.unref();
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      return { ok: true, response };
    } catch (e) {
      const detail =
        e && e.name === "AbortError"
          ? `timeout after ${REQUEST_TIMEOUT_MS}ms`
          : (e && e.message) || "fetch failed";
      return { ok: false, error: "network", detail };
    } finally {
      clearTimeout(timer);
    }
  }

  // Shared by apiGet/apiPost: resolve the URL, attach the key, read JSON.
  async function apiRequest(pathname, { query, body } = {}) {
    const s = settings();
    // Checked BEFORE any network I/O: no key means we never even dial out.
    if (!s.apiKey) return { ok: false, error: "no-key" };
    let url;
    try {
      url = new URL(String(s.baseUrl).replace(/\/+$/, "") + pathname);
    } catch {
      return { ok: false, error: "network", detail: "invalid baseUrl" };
    }
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const init = { headers: { "x-api-key": s.apiKey } };
    if (body !== undefined) {
      init.method = "POST";
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const r = await fetchWithTimeout(url, init);
    if (!r.ok) return r;
    if (!r.response.ok) return { ok: false, error: "http-" + r.response.status };
    try {
      return { ok: true, data: await r.response.json() };
    } catch {
      return { ok: false, error: "bad-json" };
    }
  }

  const apiGet = (pathname, query) => apiRequest(pathname, { query });
  const apiPost = (pathname, body) => apiRequest(pathname, { body: body || {} });

  // -- fixtures (mock mode) ----------------------------------------------

  // Fixture dates are fixed points in time, so a month after they were written
  // every mock match reads as "in the past" and the finder's Upcoming filter
  // shows an empty list. Mock mode exists to demo the real flow, so slide the
  // whole set forward as one block: the earliest match becomes tonight, and the
  // spacing between matches (and which are same-night) is preserved exactly.
  let mockShiftMs = null;
  function mockDateShift() {
    if (mockShiftMs !== null) return mockShiftMs;
    mockShiftMs = 0;
    try {
      const all = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "matches.json"), "utf8"));
      const times = (Array.isArray(all) ? all : [])
        .map((m) => Date.parse(m && m.scheduledDate))
        .filter((t) => !Number.isNaN(t));
      if (!times.length) return mockShiftMs;
      const tonight = new Date();
      tonight.setHours(19, 0, 0, 0); // 7pm local, a normal match-night slot
      mockShiftMs = tonight.getTime() - Math.min(...times);
    } catch { /* leave the shift at zero; fixtures still load */ }
    return mockShiftMs;
  }
  function shiftDates(value) {
    const shift = mockDateShift();
    if (!shift) return value;
    const walk = (node) => {
      if (Array.isArray(node)) return node.map(walk);
      if (node && typeof node === "object") {
        const out = {};
        for (const [k, v] of Object.entries(node)) {
          if (k === "scheduledDate" && typeof v === "string" && v) {
            const t = Date.parse(v);
            out[k] = Number.isNaN(t) ? v : new Date(t + shift).toISOString();
          } else {
            out[k] = walk(v);
          }
        }
        return out;
      }
      return node;
    };
    return walk(value);
  }

  function readFixtureJson(name) {
    const file = path.join(FIXTURES_DIR, name);
    if (!fs.existsSync(file)) return { ok: false, error: "mock-missing", detail: name };
    try {
      return { ok: true, data: shiftDates(JSON.parse(fs.readFileSync(file, "utf8"))) };
    } catch {
      return { ok: false, error: "bad-json", detail: name };
    }
  }

  // -- methods -------------------------------------------------------------

  // Proves the key works and reports which key it is (the league names them).
  async function validateKey() {
    const s = settings();
    if (isMock(s)) return { ok: true, data: { name: "Mock League", via: "mock" } };
    // Two different keys exist in this app and they go in different boxes. A
    // Casterverse access key pasted here would come back as a plain 401 —
    // "the league rejected your key" — which sends someone off checking a key
    // that was never the problem. Name it instead, before any network call.
    if (String(s.apiKey).startsWith(license.PREFIX + ".")) {
      return { ok: false, error: "access-key-here" };
    }
    const me = await apiGet("/api/v1/me");
    if (!me.ok) return me;
    return { ok: true, data: { name: (me.data && me.data.keyName) || null, via: "me" } };
  }

  // The finder's data source. `search` is the only filter the API has (team /
  // roster names); everything else the panel offers is grouped client-side from
  // the circuitName each match already carries.
  //
  // With no search term we page through the whole scheduled/pending set so the
  // circuit list is complete — capped, and the cap is REPORTED (`truncated`)
  // rather than silently hiding matches from a producer looking for theirs.
  const PAGE_SIZE = 100;      // API maximum
  const MAX_PAGES = 5;        // 500 matches; a season is far smaller

  async function listMatches({ search = "", maxPages = MAX_PAGES } = {}) {
    const s = settings();
    if (isMock(s)) {
      const fixture = readFixtureJson("matches.json");
      if (!fixture.ok) return fixture;
      const all = Array.isArray(fixture.data) ? fixture.data : (fixture.data.data || []);
      const term = String(search || "").trim().toLowerCase();
      const data = term
        ? all.filter((m) => [m.team1, m.team2].some((t) => t && String(t.name).toLowerCase().includes(term)))
        : all;
      return { ok: true, data, truncated: false, total: data.length };
    }

    const term = String(search || "").trim();
    const out = [];
    let total = 0;
    let truncated = false;
    // A search term is already narrow, so one page of it is plenty.
    const pageLimit = term ? 1 : Math.max(1, maxPages);
    for (let page = 1; page <= pageLimit; page++) {
      const r = await apiPost("/api/v1/matches/search", {
        ...(term ? { search: term } : {}),
        page,
        pageSize: PAGE_SIZE,
      });
      if (!r.ok) return page === 1 ? r : { ok: true, data: out, truncated: true, total };
      const body = r.data && typeof r.data === "object" ? r.data : {};
      const batch = Array.isArray(body.data) ? body.data : [];
      out.push(...batch);
      const pg = body.pagination || {};
      total = num(pg.total) || out.length;
      const totalPages = num(pg.totalPages) || 1;
      if (page >= totalPages || batch.length === 0) break;
      if (page === pageLimit && page < totalPages) truncated = true;
    }
    return { ok: true, data: out, truncated, total };
  }

  async function getMatch(id, { fresh = false } = {}) {
    const key = String(id);
    if (!fresh) {
      const hit = matchCache.get(key);
      if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
        return { ok: true, data: hit.data };
      }
    }
    const s = settings();
    const res = isMock(s)
      ? readFixtureJson(`match-${key}.json`)
      : await apiGet(`/api/v1/matches/${encodeURIComponent(key)}`);
    if (res.ok) matchCache.set(key, { fetchedAt: Date.now(), data: res.data });
    return res;
  }

  // side "a" -> teams[0], "b" -> teams[1]. Returns the image BYTES (see
  // header: this backs the localhost logo proxy, upstream URLs expire).
  async function getLogo(matchId, side, { fresh = false } = {}) {
    if (side !== "a" && side !== "b") {
      // Programmer error, not a runtime condition — fail loud.
      throw new TypeError(`getLogo side must be "a" or "b", got: ${side}`);
    }
    const cacheKey = `${matchId}:${side}`;
    if (!fresh) {
      const hit = logoCache.get(cacheKey);
      if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
        return { ok: true, contentType: hit.contentType, body: hit.body };
      }
    }
    const match = await getMatch(matchId, { fresh });
    if (!match.ok) return match;
    // getMatch caches the RAW response (team1/team2), so normalize before
    // indexing by side — this is why a/b never depended on API key order.
    const team = normalizeMatch(match.data).teams[side === "a" ? 0 : 1];
    const logoUrl = team && typeof team.logoUrl === "string" ? team.logoUrl : "";
    const s = settings();
    if (!logoUrl) {
      return {
        ok: false,
        error: isMock(s) ? "mock-missing" : "http-404",
        detail: `no logoUrl for side ${side}`,
      };
    }

    let result;
    if (isMock(s)) {
      // Fixture logoUrl values are bare filenames inside league-fixtures/.
      const file = path.join(FIXTURES_DIR, path.basename(logoUrl));
      if (!fs.existsSync(file)) return { ok: false, error: "mock-missing", detail: logoUrl };
      result = { ok: true, contentType: "image/png", body: fs.readFileSync(file) };
    } else {
      // Presigned CDN URL: deliberately NO x-api-key here (third-party host,
      // sending the league key would leak it).
      const r = await fetchWithTimeout(logoUrl, {});
      if (!r.ok) return r;
      if (!r.response.ok) return { ok: false, error: "http-" + r.response.status };
      const body = Buffer.from(await r.response.arrayBuffer());
      const contentType = r.response.headers.get("content-type") || "image/png";
      result = { ok: true, contentType, body };
    }
    logoCache.set(cacheKey, {
      fetchedAt: Date.now(),
      contentType: result.contentType,
      body: result.body,
    });
    return result;
  }

  return { validateKey, listMatches, getMatch, getLogo };
}

module.exports = { createLeagueClient, normalizeMatch };
