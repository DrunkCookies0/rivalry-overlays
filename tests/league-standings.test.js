/* Standings are dark-launched against Ask 1 of ASKS-FOR-CYNICAL.md: no live
 * endpoint exists yet, so these tests pin the requested shape, the mock path,
 * and the one behavior that matters most on air: the official order is never
 * re-derived on our side. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createLeagueClient, normalizeStandings } = require("../bridge/league-client");

test("normalizeStandings maps the Ask-1 shape with safe defaults", () => {
  const out = normalizeStandings({
    circuit: { id: "c1", name: "Summer 2026 - 3v3 East", tier: "Tier 1", season: "Summer 2026" },
    updatedAt: "2026-07-30T19:00:00.000Z",
    standings: [
      { position: 1, rosterId: "r1", name: "FROST", logoUrl: "https://x/logo.png", wins: 4, losses: 1, gamesWon: 12, gamesLost: 5, points: 12, matchesPlayed: 5, streak: "W3" },
      { position: 2, rosterId: "r2", name: "EMBER", wins: 3, losses: 2 },
    ],
  });
  assert.equal(out.circuit.name, "Summer 2026 - 3v3 East");
  assert.equal(out.circuit.nameShort, "3v3 East", "season prefix deduped for headers");
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].record, "4-1");
  assert.equal(out.rows[0].gamesRecord, "12-5");
  assert.equal(out.rows[0].points, 12);
  // Optional fields the ask marks optional degrade to empty, never throw.
  assert.equal(out.rows[1].gamesRecord, "");
  assert.equal(out.rows[1].points, null);
  assert.equal(out.rows[1].streak, "");
});

test("rows keep SERVER order even when positions disagree with wins", () => {
  // Points-based circuits can rank a lower-wins roster higher; the site's
  // ordering is authoritative and must survive normalization untouched.
  const out = normalizeStandings({
    standings: [
      { position: 1, name: "LOW-WINS", wins: 2, losses: 0 },
      { position: 2, name: "HIGH-WINS", wins: 5, losses: 3 },
    ],
  });
  assert.deepEqual(out.rows.map((r) => r.name), ["LOW-WINS", "HIGH-WINS"]);
});

test("garbage input never throws and yields an empty board", () => {
  for (const bad of [null, 42, "x", {}, { standings: "nope" }]) {
    const out = normalizeStandings(bad);
    assert.deepEqual(out.rows, []);
    assert.equal(typeof out.circuit.name, "string");
  }
});

test("mock mode serves the fixture end to end", async () => {
  const client = createLeagueClient({ getSettings: () => ({ mock: true }) });
  const r = await client.getStandings({});
  assert.equal(r.ok, true);
  const out = normalizeStandings(r.data);
  assert.ok(out.rows.length >= 4, "fixture should carry a real table");
  assert.equal(out.rows[0].position, 1);
  assert.ok(out.circuit.name.length > 0);
});

test("no key means no network call, same as every other method", async () => {
  const client = createLeagueClient({ getSettings: () => ({ apiKey: "", mock: false }) });
  const r = await client.getStandings({});
  assert.equal(r.ok, false);
  assert.equal(r.error, "no-key");
});
