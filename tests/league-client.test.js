/* =============================================================================
 * league-client tests — run with: node --test tests/league-client.test.js
 * -----------------------------------------------------------------------------
 * Mock mode runs against the spec-verbatim fixtures in config/league-fixtures/
 * (no network, no key). The no-key guard is proven to short-circuit BEFORE any
 * network I/O by swapping global fetch for a tripwire that counts calls.
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

function mockClient() {
  return createLeagueClient({
    getSettings: () => ({ apiKey: "", baseUrl: "https://therivalry.gg", mock: true }),
  });
}

// ---------------------------------------------------------------------------
// normalizeMatch
// ---------------------------------------------------------------------------

test("normalizeMatch: full fixture populates every top-level field", () => {
  const raw = JSON.parse(
    fs.readFileSync(path.join(FIXTURES_DIR, "match-match-001.json"), "utf8")
  );
  const m = normalizeMatch(raw);

  assert.equal(m.matchId, "match-001");
  assert.equal(m.status, "scheduled");
  assert.equal(m.round, 1);
  assert.equal(m.scheduledDate, "2026-07-11T23:00:00Z");
  assert.equal(m.event.season, "Season 1");
  assert.equal(m.event.circuit, "Pro");
  assert.equal(m.event.tier, "Tier 1");
  assert.equal(m.event.roundLabel, "Upper Bracket - Round 1");
  assert.equal(m.event.composedTitle, "Season 1 | Pro | Upper Bracket - Round 1");

  assert.equal(m.teams.length, 2);
  const [a, b] = m.teams;
  assert.equal(a.rosterId, "roster-frost");
  assert.equal(a.name, "FROST");
  assert.equal(a.logoUrl, "logo-a.png");
  assert.equal(a.seriesWins, 0);
  assert.equal(a.players.length, 3);
  assert.equal(b.name, "EMBER");
  assert.equal(b.players.length, 3);

  const p = a.players[0];
  assert.equal(p.userId, "user-frost-01");
  assert.equal(p.name, "Samba");
  assert.equal(p.title, "");
  assert.deepEqual(p.badges, []);
  assert.ok(p.avatarUrl.length > 0);
  assert.ok(p.ranks && typeof p.ranks === "object");
  assert.equal(p.ranks["3v3"], 1720);
});

test("normalizeMatch: {} input yields safe defaults without throwing", () => {
  const m = normalizeMatch({});
  assert.equal(m.matchId, "");
  assert.equal(m.status, "");
  assert.equal(m.round, null);
  assert.equal(m.scheduledDate, "");
  assert.deepEqual(m.teams, []);
  assert.deepEqual(m.event, {
    season: "",
    circuit: "",
    tier: "",
    roundLabel: "",
    composedTitle: "",
  });
  // garbage inputs must not throw either
  assert.doesNotThrow(() => normalizeMatch(null));
  assert.doesNotThrow(() => normalizeMatch(undefined));
  assert.doesNotThrow(() => normalizeMatch("nope"));
  assert.doesNotThrow(() => normalizeMatch({ teams: [null, 42], event: [] }));
});

test("normalizeMatch: composedTitle skips empty segments", () => {
  const m = normalizeMatch({
    event: { season: "Season 1", circuit: "", roundLabel: "Finals" },
  });
  assert.equal(m.event.composedTitle, "Season 1 | Finals");
  assert.equal(normalizeMatch({ event: {} }).event.composedTitle, "");
  assert.equal(normalizeMatch({ event: { circuit: "Pro" } }).event.composedTitle, "Pro");
});

// ---------------------------------------------------------------------------
// mock mode
// ---------------------------------------------------------------------------

test("mock: listMatches serves the 3 fixture matches", async () => {
  const res = await mockClient().listMatches();
  assert.equal(res.ok, true);
  assert.ok(Array.isArray(res.data));
  assert.equal(res.data.length, 3);
  assert.deepEqual(
    res.data.map((m) => m.status).sort(),
    ["completed", "in_progress", "scheduled"]
  );
});

test("mock: getMatch returns fixture, caches, and fresh:true re-reads", async () => {
  const client = mockClient();
  const r1 = await client.getMatch("match-001");
  assert.equal(r1.ok, true);
  assert.equal(r1.data.matchId, "match-001");
  assert.equal(r1.data.teams.length, 2);

  const r2 = await client.getMatch("match-001");
  assert.equal(r2.data, r1.data); // same object -> served from cache

  const r3 = await client.getMatch("match-001", { fresh: true });
  assert.notEqual(r3.data, r1.data); // new object -> cache busted, re-read
  assert.deepEqual(r3.data, r1.data); // ...with identical content
});

test("mock: getLogo returns PNG bytes with image/png", async () => {
  const client = mockClient();
  const res = await client.getLogo("match-001", "a");
  assert.equal(res.ok, true);
  assert.equal(res.contentType, "image/png");
  assert.ok(Buffer.isBuffer(res.body));
  assert.deepEqual(res.body.subarray(0, 8), PNG_MAGIC);

  const resB = await client.getLogo("match-001", "b");
  assert.equal(resB.ok, true);
  assert.deepEqual(resB.body.subarray(0, 8), PNG_MAGIC);
});

test("mock: unknown match -> mock-missing", async () => {
  const res = await mockClient().getMatch("match-999");
  assert.equal(res.ok, false);
  assert.equal(res.error, "mock-missing");
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
    assert.deepEqual(await client.getMatch("match-001"), { ok: false, error: "no-key" });
    assert.equal(calls, 0);
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
