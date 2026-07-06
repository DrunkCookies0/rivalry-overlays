/* =============================================================================
 * RIVALRY league API client  (main process)
 * -----------------------------------------------------------------------------
 * Talks to the rivalry-web /api/v1 surface described in LEAGUE-API-SPEC.md.
 * The match endpoints are specced but not live yet, so every response-shape
 * assumption is funneled through normalizeMatch(): if the backend ships a
 * slightly different shape, there is exactly ONE place to fix.
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

function normalizePlayer(rawPlayer) {
  const p = rawPlayer && typeof rawPlayer === "object" ? rawPlayer : {};
  return {
    userId: str(p.userId),
    name: str(p.name),
    title: str(p.title), // P2, not modeled backend-side yet -> usually ""
    badges: Array.isArray(p.badges)
      ? p.badges.filter((b) => typeof b === "string").slice(0, 3) // spec cap: 3
      : [],
    avatarUrl: str(p.avatarUrl),
    ranks: p.ranks && typeof p.ranks === "object" ? p.ranks : null,
  };
}

function normalizeTeam(rawTeam) {
  const t = rawTeam && typeof rawTeam === "object" ? rawTeam : {};
  return {
    rosterId: str(t.rosterId),
    name: str(t.name),
    logoUrl: str(t.logoUrl),
    seriesWins: typeof t.seriesWins === "number" ? t.seriesWins : 0,
    players: Array.isArray(t.players) ? t.players.map(normalizePlayer) : [],
  };
}

// Pure. Accepts anything (including null / non-objects) and returns the full
// overlay-side match shape with every field safely defaulted.
function normalizeMatch(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const ev = src.event && typeof src.event === "object" ? src.event : {};
  const season = str(ev.season);
  const circuit = str(ev.circuit);
  const tier = str(ev.tier);
  const roundLabel = str(ev.roundLabel);
  return {
    matchId: str(src.matchId),
    status: str(src.status),
    round: src.round == null ? null : src.round,
    event: {
      season,
      circuit,
      tier,
      roundLabel,
      // Broadcast header line; empty segments are skipped, never " |  | ".
      composedTitle: [season, circuit, roundLabel].filter(Boolean).join(" | "),
    },
    scheduledDate: str(src.scheduledDate),
    teams: Array.isArray(src.teams) ? src.teams.map(normalizeTeam) : [],
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

  async function apiGet(pathname, query) {
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
    const r = await fetchWithTimeout(url, { headers: { "x-api-key": s.apiKey } });
    if (!r.ok) return r;
    if (!r.response.ok) return { ok: false, error: "http-" + r.response.status };
    try {
      return { ok: true, data: await r.response.json() };
    } catch {
      return { ok: false, error: "bad-json" };
    }
  }

  // -- fixtures (mock mode) ----------------------------------------------
  function readFixtureJson(name) {
    const file = path.join(FIXTURES_DIR, name);
    if (!fs.existsSync(file)) return { ok: false, error: "mock-missing", detail: name };
    try {
      return { ok: true, data: JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch {
      return { ok: false, error: "bad-json", detail: name };
    }
  }

  // -- methods -------------------------------------------------------------

  // Proves the key works. /api/v1/me is the intended route, but until the
  // backend builds it (only users + user-ranks are live today) a 404 there
  // says nothing about the key — so fall back to a known key-gated route.
  async function validateKey() {
    const s = settings();
    if (isMock(s)) return { ok: true, data: { name: "Mock League", via: "mock" } };
    const me = await apiGet("/api/v1/me");
    if (me.ok) return { ok: true, data: { name: (me.data && me.data.name) || null, via: "me" } };
    if (me.error !== "http-404") return me;
    const probe = await apiGet("/api/v1/users", { limit: 1 });
    if (probe.ok) return { ok: true, data: { name: null, via: "users" } };
    return probe;
  }

  // query keys (status/from/to/...) pass straight through to the endpoint.
  async function listMatches(query) {
    const s = settings();
    if (isMock(s)) return readFixtureJson("matches.json");
    return apiGet("/api/v1/matches", query);
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
    const teams = Array.isArray(match.data.teams) ? match.data.teams : [];
    const team = teams[side === "a" ? 0 : 1];
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
