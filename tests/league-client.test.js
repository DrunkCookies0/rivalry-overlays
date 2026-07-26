/* =============================================================================
 * league-client tests — run with: node --test tests/league-client.test.js
 * -----------------------------------------------------------------------------
 * Shapes here mirror the LIVE therivalry.gg /api/v1 schema (captured from
 * GET /api/docs/json on 2026-07-25), which is what config/league-fixtures/
 * holds. Mock mode runs against those fixtures (no network, no key). The no-key
 * guard is proven to short-circuit BEFORE any network I/O by swapping global
 * fetch for a tripwire that counts calls.
 * ===========================================================================*/

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createLeagueClient, normalizeMatch } = require("../bridge/league-client");
const { mask } = require("../bridge/league-settings");

const FIXTURES_DIR = path.join(__dirname, "..", "config", "league-fixtures");
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MATCH_A = "68a1f0c4e2b7431d9c001001"; // FROST vs EMBER, 2v2 East, round 3
const MATCH_BYE = "68a1f0c4e2b7431d9c001004"; // HOLLOWPOINT bye, no team2, no date

function mockClient() {
  return createLeagueClient({
    getSettings: () => ({ apiKey: "", baseUrl: "https://therivalry.gg", mock: true }),
  });
}

// ---------------------------------------------------------------------------
// normalizeMatch — the one place live-shape assumptions live
// ---------------------------------------------------------------------------

test("normalizeMatch: maps the live match shape", () => {
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, `match-${MATCH_A}.json`), "utf8"));
  const m = normalizeMatch(raw);

  assert.equal(m.matchId, MATCH_A, "live `id` becomes matchId");
  assert.equal(m.round, 3);
  assert.equal(m.isBye, false);
  assert.equal(m.scheduledDate, "2026-07-13T23:00:00.000Z");
  assert.equal(m.event.season, "Summer 2026");
  assert.equal(m.event.circuit, "Summer 2026 - 2v2 East");
  assert.equal(m.event.circuitShort, "2v2 East", "the season prefix is dropped for display");
  assert.equal(m.event.roundLabel, "Round 3");
  assert.equal(m.event.composedTitle, "Summer 2026 | 2v2 East | Round 3");

  const [a, b] = m.teams;
  assert.equal(a.name, "FROST");
  assert.equal(a.rosterId, "68a1f0c4e2b7431d9c00a001");
  assert.equal(a.wins, 4);
  assert.equal(a.losses, 1);
  assert.equal(a.record, "4-1", "records come from the API now, not the operator");
  assert.equal(b.name, "EMBER");
  assert.equal(b.record, "3-2");

  const p = a.players[0];
  assert.equal(p.name, "Kaidan");
  assert.equal(p.role, "captain");
  assert.equal(p.title, "captain", "player-titles overlay reads .title");
  assert.equal(p.stats.goals, 21);
});

test("normalizeMatch: a bye leaves side b null instead of shifting sides", () => {
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, `match-${MATCH_BYE}.json`), "utf8"));
  const m = normalizeMatch(raw);

  assert.equal(m.isBye, true);
  assert.equal(m.teams.length, 2);
  assert.equal(m.teams[0].name, "HOLLOWPOINT");
  assert.equal(m.teams[1], null, "the empty side stays empty; side a must not become side b");
  assert.equal(m.scheduledDate, "");
});

test("normalizeMatch: a team with no logo yields an empty string, not null", () => {
  const raw = JSON.parse(
    fs.readFileSync(path.join(FIXTURES_DIR, "match-68a1f0c4e2b7431d9c001002.json"), "utf8")
  );
  const m = normalizeMatch(raw);
  assert.equal(m.teams[1].name, "ECLIPSE");
  assert.equal(m.teams[1].logoUrl, "", "renderers must never receive null for a URL");
});

test("normalizeMatch: garbage input yields safe defaults without throwing", () => {
  const m = normalizeMatch({});
  assert.equal(m.matchId, "");
  assert.equal(m.round, null);
  assert.equal(m.scheduledDate, "");
  assert.deepEqual(m.teams, [null, null]);
  assert.deepEqual(m.event, { season: "", circuit: "", circuitShort: "", roundLabel: "", composedTitle: "" });

  assert.doesNotThrow(() => normalizeMatch(null));
  assert.doesNotThrow(() => normalizeMatch(undefined));
  assert.doesNotThrow(() => normalizeMatch("nope"));
  assert.doesNotThrow(() => normalizeMatch({ team1: 42, team2: [], round: "3" }));
  assert.equal(normalizeMatch({ round: "3" }).round, null, "a non-numeric round is not a round");
});

test("normalizeMatch: composedTitle skips empty segments", () => {
  assert.equal(
    normalizeMatch({ seasonName: "Summer 2026", round: 1 }).event.composedTitle,
    "Summer 2026 | Round 1"
  );
  assert.equal(normalizeMatch({ circuitName: "2v2 East" }).event.composedTitle, "2v2 East");
  assert.equal(normalizeMatch({}).event.composedTitle, "");
});

// ---------------------------------------------------------------------------
// mock mode
// ---------------------------------------------------------------------------

test("mock: listMatches serves the fixture set", async () => {
  const res = await mockClient().listMatches();
  assert.equal(res.ok, true);
  assert.equal(res.data.length, 6);
  assert.equal(res.truncated, false);
  assert.ok(res.data.every((m) => typeof m.id === "string" && m.id.length > 0));
});

test("mock: a search term filters by team name, the way the API does", async () => {
  const res = await mockClient().listMatches({ search: "frost" });
  assert.equal(res.ok, true);
  assert.equal(res.data.length, 2, "FROST plays twice in the fixtures");
  assert.ok(res.data.every((m) => [m.team1, m.team2].some((t) => t && t.name === "FROST")));

  const none = await mockClient().listMatches({ search: "no-such-team" });
  assert.equal(none.data.length, 0);
});

test("mock: getMatch returns fixture, caches, and fresh:true re-reads", async () => {
  const client = mockClient();
  const r1 = await client.getMatch(MATCH_A);
  assert.equal(r1.ok, true);
  assert.equal(r1.data.id, MATCH_A);

  const r2 = await client.getMatch(MATCH_A);
  assert.equal(r2.data, r1.data); // same object -> served from cache

  const r3 = await client.getMatch(MATCH_A, { fresh: true });
  assert.notEqual(r3.data, r1.data); // new object -> cache busted, re-read
  assert.deepEqual(r3.data, r1.data); // ...with identical content
});

test("mock: getLogo returns PNG bytes for each side", async () => {
  const client = mockClient();
  const a = await client.getLogo(MATCH_A, "a");
  assert.equal(a.ok, true);
  assert.equal(a.contentType, "image/png");
  assert.deepEqual(a.body.subarray(0, 8), PNG_MAGIC);

  const b = await client.getLogo(MATCH_A, "b");
  assert.equal(b.ok, true);
  assert.deepEqual(b.body.subarray(0, 8), PNG_MAGIC);
});

test("mock: a side with no team or no logo fails cleanly, never throws", async () => {
  const client = mockClient();
  const noTeam = await client.getLogo(MATCH_BYE, "b"); // bye: team2 is null
  assert.equal(noTeam.ok, false);
  assert.match(noTeam.detail, /side b/);

  const noLogo = await client.getLogo("68a1f0c4e2b7431d9c001002", "b"); // ECLIPSE, logoUrl null
  assert.equal(noLogo.ok, false);
});

test("mock: unknown match -> mock-missing", async () => {
  const res = await mockClient().getMatch("no-such-id");
  assert.equal(res.ok, false);
  assert.equal(res.error, "mock-missing");
});

// ---------------------------------------------------------------------------
// live transport (stubbed fetch)
// ---------------------------------------------------------------------------

test("live: listMatches POSTs to /matches/search with the key header", async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "m1", circuitName: "2v2 East", round: 1 }], pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 } }),
    };
  };
  try {
    const client = createLeagueClient({
      getSettings: () => ({ apiKey: "secret-key", baseUrl: "https://therivalry.gg", mock: false }),
    });
    const r = await client.listMatches({ search: "frost" });

    assert.equal(r.ok, true);
    assert.equal(r.data.length, 1);
    assert.equal(seen.length, 1, "a search term needs exactly one page");
    assert.equal(seen[0].url, "https://therivalry.gg/api/v1/matches/search");
    assert.equal(seen[0].init.method, "POST");
    assert.equal(seen[0].init.headers["x-api-key"], "secret-key");
    assert.deepEqual(JSON.parse(seen[0].init.body), { search: "frost", page: 1, pageSize: 100 });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("live: an unsearched list pages through, and reports when it stops short", async () => {
  const realFetch = globalThis.fetch;
  let pages = 0;
  globalThis.fetch = async () => {
    pages++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ id: "m" + pages }],
        pagination: { page: pages, pageSize: 100, total: 900, totalPages: 9 },
      }),
    };
  };
  try {
    const client = createLeagueClient({
      getSettings: () => ({ apiKey: "k", baseUrl: "https://therivalry.gg", mock: false }),
    });
    const r = await client.listMatches();

    assert.equal(r.ok, true);
    assert.equal(pages, 5, "capped at MAX_PAGES");
    assert.equal(r.data.length, 5);
    assert.equal(r.truncated, true, "a producer must be told the list is partial");
    assert.equal(r.total, 900);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("live: validateKey reports the league's name for the key", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ message: "API key is valid", keyName: "cookies-overlays" }),
  });
  try {
    const client = createLeagueClient({
      getSettings: () => ({ apiKey: "k", baseUrl: "https://therivalry.gg", mock: false }),
    });
    const r = await client.validateKey();
    assert.equal(r.ok, true);
    assert.equal(r.data.name, "cookies-overlays");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("live: a rejected key surfaces as http-401, not a crash", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  try {
    const client = createLeagueClient({
      getSettings: () => ({ apiKey: "wrong", baseUrl: "https://therivalry.gg", mock: false }),
    });
    assert.deepEqual(await client.validateKey(), { ok: false, error: "http-401" });
    assert.deepEqual(await client.listMatches(), { ok: false, error: "http-401" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// no-key guard (live mode)
// ---------------------------------------------------------------------------

test("no key + mock off: no-key error with ZERO network calls", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("network call attempted");
  };
  try {
    const client = createLeagueClient({
      getSettings: () => ({ apiKey: "", baseUrl: "https://therivalry.gg", mock: false }),
    });
    assert.deepEqual(await client.validateKey(), { ok: false, error: "no-key" });
    assert.deepEqual(await client.listMatches(), { ok: false, error: "no-key" });
    assert.deepEqual(await client.getMatch(MATCH_A), { ok: false, error: "no-key" });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the key is only ever sent to the configured baseUrl, never to a logo host", async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: (init && init.headers) || {} });
    if (String(url).includes("/api/v1/matches/")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "m1", team1: { name: "A", logoUrl: "https://cdn.example.com/a.png?sig=x" }, team2: null }),
      };
    }
    return { ok: true, status: 200, arrayBuffer: async () => PNG_MAGIC.buffer, headers: { get: () => "image/png" } };
  };
  try {
    const client = createLeagueClient({
      getSettings: () => ({ apiKey: "secret-key", baseUrl: "https://therivalry.gg", mock: false }),
    });
    await client.getLogo("m1", "a");

    const cdn = seen.find((s) => s.url.includes("cdn.example.com"));
    assert.ok(cdn, "the logo fetch happened");
    assert.equal(cdn.headers["x-api-key"], undefined, "the league key must never reach a third-party host");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// league-settings mask
// ---------------------------------------------------------------------------

test("mask: empty stays empty, otherwise bullets + last 4", () => {
  assert.equal(mask(""), "");
  assert.equal(mask(undefined), "");
  assert.equal(mask("rivalry-key-abcd1234"), "••••1234");
});

test("circuit names don't put the season on the broadcast header twice", () => {
  // The live API sends seasonName "Summer Circuit 2026" alongside circuitName
  // "Summer 2026 | 3v3 US-East" — two different season strings, so a naive
  // join printed both. Shapes below are the real ones plus the edges.
  const t = (seasonName, circuitName, round = 1) => normalizeMatch({ seasonName, circuitName, round }).event;

  const live = t("Summer Circuit 2026", "Summer 2026 | 3v3 US-East");
  assert.equal(live.circuitShort, "3v3 US-East");
  assert.equal(live.composedTitle, "Summer Circuit 2026 | 3v3 US-East | Round 1");
  assert.equal(live.circuit, "Summer 2026 | 3v3 US-East", "the untouched original stays available");

  // Circuit literally prefixed with the season name.
  assert.equal(t("Summer 2026", "Summer 2026 - 2v2 East").circuitShort, "2v2 East");
  // No season prefix at all: left alone.
  assert.equal(t("Summer 2026", "3v3 Europe").circuitShort, "3v3 Europe");
  // A pipe that isn't a season prefix must survive intact.
  assert.equal(t("Summer 2026", "Open | Qualifier").circuitShort, "Open | Qualifier");
  // Circuit that IS the season: blank, so the title says it once.
  assert.equal(t("Summer 2026", "Summer 2026").composedTitle, "Summer 2026 | Round 1");
});
