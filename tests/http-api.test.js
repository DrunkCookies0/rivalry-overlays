/* The league routes in bridge/http-api.js are the match gate's HTTP surface:
 * locking is the ONE path into a broadcast, and the logo proxy is what keeps
 * team logos alive through a league outage. None of it had unit coverage.
 * These tests drive the router directly (mock req/res, real match-lock on a
 * temp dir, real fixture data through the real normalizeMatch) and pin the
 * behaviors a show depends on: lock persists match + logo bytes, upstream
 * logo URLs never leave the process, a failed lock never damages the current
 * one, and a mid-lock throw answers 500 instead of hanging the panel. */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");

const { createApiRouter } = require("../bridge/http-api");
const { createMatchLock } = require("../bridge/match-lock");

const FIXTURE = JSON.parse(fs.readFileSync(
  path.join(__dirname, "..", "config", "league-fixtures", "match-68a1f0c4e2b7431d9c001001.json"),
  "utf8"
));
const FIXTURE_ID = FIXTURE.id || "68a1f0c4e2b7431d9c001001";
const PNG = Buffer.from("89504e470d0a1a0a0000000d", "hex"); // enough bytes to be a body

function fakeReq(method, body) {
  const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = "/";
  return req;
}

function fakeRes() {
  const res = {
    code: null,
    headers: null,
    chunks: [],
    done: null,
  };
  res.finished = new Promise((r) => { res.done = r; });
  res.writeHead = (code, headers) => { res.code = code; res.headers = headers || {}; };
  res.end = (data) => { if (data !== undefined) res.chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data))); res.done(); };
  res.body = () => Buffer.concat(res.chunks).toString("utf8");
  res.json = () => JSON.parse(res.body());
  return res;
}

function makeHarness({ getMatch, getLogo } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rv-httpapi-"));
  const matchLock = createMatchLock({ userDataDir: dir });
  const client = {
    getMatch: getMatch || (async () => ({ ok: true, data: FIXTURE })),
    getLogo: getLogo || (async () => ({ ok: true, contentType: "image/png", body: PNG })),
    validateKey: async () => ({ ok: true }),
    listMatches: async () => ({ ok: true, data: [], truncated: false, total: 0 }),
    getStandings: async () => ({ ok: false, error: "http-404" }),
  };
  const router = createApiRouter({
    userDataDir: dir,
    meta: { label: "test" },
    getBridge: () => null,
    getObs: () => null,
    getSetupInfo: () => ({}),
    rewriteIni: () => ({}),
    isSetupComplete: () => true,
    markSetupComplete: () => {},
    getLeagueClient: () => client,
    getLeagueSettings: () => ({ apiKey: "rv_test", mock: false }),
    maskLeagueKey: (k) => (k ? k.slice(0, 3) + "..." : ""),
    getMatchLock: () => matchLock,
  });
  return { router, matchLock, client, dir };
}

async function lock(h, matchId) {
  const req = fakeReq("POST", { matchId });
  const res = fakeRes();
  assert.equal(h.router.handle(req, res, "/league/lock"), true);
  await res.finished;
  return res;
}

test("lock without matchId is a 400, not a hang", async () => {
  const h = makeHarness();
  const res = await lock(h, "");
  assert.equal(res.code, 400);
  assert.equal(h.matchLock.isLocked(), false);
});

test("lock persists the match and serves proxy logo URLs, never upstream", async () => {
  const h = makeHarness();
  const res = await lock(h, FIXTURE_ID);
  assert.equal(res.code, 200);
  const out = res.json();
  assert.equal(out.ok, true);
  assert.equal(h.matchLock.isLocked(), true);
  assert.equal(h.matchLock.get().matchId, FIXTURE_ID);
  for (const t of out.data.teams) {
    if (!t || !t.logoUrl) continue;
    assert.match(t.logoUrl, /^\/league\/logo\?matchId=/, "upstream logo URL leaked out of the process");
  }
  // logo bytes rode into the lock (outage-proofing)
  const cached = h.matchLock.getLogo("a");
  assert.ok(cached && cached.body.equals(PNG), "logo bytes not cached in the lock");
});

test("a failed lock answers 502 and leaves the current lock untouched", async () => {
  const h = makeHarness();
  await lock(h, FIXTURE_ID);
  h.client.getMatch = async () => ({ ok: false, error: "network" });
  const res = await lock(h, "some-other-match");
  assert.equal(res.code, 502);
  assert.equal(h.matchLock.get().matchId, FIXTURE_ID, "failed lock damaged the existing lock");
});

test("a THROW mid-lock answers 500 instead of hanging the request", async () => {
  const h = makeHarness({ getMatch: async () => { throw new Error("disk full"); } });
  const res = await lock(h, FIXTURE_ID);
  assert.equal(res.code, 500);
  const out = res.json();
  assert.equal(out.ok, false);
  assert.match(out.error, /disk full/);
});

test("GET /league/lock reports the lock status shape", async () => {
  const h = makeHarness();
  await lock(h, FIXTURE_ID);
  const res = fakeRes();
  h.router.handle(fakeReq("GET"), res, "/league/lock");
  await res.finished;
  const out = res.json();
  assert.equal(out.locked, true);
  assert.equal(out.matchId, FIXTURE_ID);
  assert.ok(Array.isArray(out.teams));
});

test("unlock clears the lock", async () => {
  const h = makeHarness();
  await lock(h, FIXTURE_ID);
  const res = fakeRes();
  h.router.handle(fakeReq("POST"), res, "/league/unlock");
  await res.finished;
  assert.equal(h.matchLock.isLocked(), false);
});

test("logo proxy serves the LOCKED match from disk even when the league is down", async () => {
  const h = makeHarness();
  await lock(h, FIXTURE_ID);
  // League goes down mid-show: the cached bytes must still serve.
  h.client.getLogo = async () => { throw new Error("league is down"); };
  const req = fakeReq("GET");
  req.url = `/league/logo?matchId=${FIXTURE_ID}&side=a`;
  const res = fakeRes();
  h.router.handle(req, res, "/league/logo");
  await res.finished;
  assert.equal(res.code, 200);
  assert.equal(res.headers["Content-Type"], "image/png");
  assert.ok(Buffer.concat(res.chunks).equals(PNG));
});

test("logo proxy validates matchId and side", async () => {
  const h = makeHarness();
  const req = fakeReq("GET");
  req.url = "/league/logo?matchId=x&side=z";
  const res = fakeRes();
  h.router.handle(req, res, "/league/logo");
  await res.finished;
  assert.equal(res.code, 400);
});
