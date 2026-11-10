/* =============================================================================
 * Game-result catcher tests (bridge/game-results.js)
 * -----------------------------------------------------------------------------
 * What these pin: a finished game is reported once with its final score,
 * winner, overtime and the players' in-game names and stats; a 0:00 goal is
 * not overtime; a level game with no winner is not a result; nothing from
 * RL's PrimaryId (a platform account ID) is ever copied.
 * ===========================================================================*/

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createGameResultCatcher } = require("../bridge/game-results");

function harness() {
  const results = [];
  const feed = createGameResultCatcher({ onResult: (r) => results.push(r) });
  return { results, feed };
}

function frame(t, a, b, extra = {}) {
  return {
    event: "UpdateState",
    data: {
      MatchGuid: extra.guid || "g1",
      Game: { Teams: [{ Name: "BLUE", Score: a }, { Name: "ORANGE", Score: b }], TimeSeconds: t, ...(extra.game || {}) },
      Players: extra.players || [
        { Name: "Axiom", PrimaryId: "Steam|7656|0", TeamNum: 0, Goals: a, Assists: 1, Saves: 2, Shots: 4, Score: 420, Demos: 1 },
        { Name: "Juno", PrimaryId: "Epic|abc|0", TeamNum: 1, Goals: b, Assists: 0, Saves: 3, Shots: 2, Score: 310 },
      ],
    },
  };
}

// The regulation clock running down from `from` to `to`, one frame a second.
function run(feed, from, to, a, b, extra) {
  for (let t = from; t >= to; t--) feed(frame(t, a, b, extra));
}

test("a regulation game is reported once, with the score, winner and players", () => {
  const { results, feed } = harness();
  run(feed, 300, 0, 3, 1);
  feed({ event: "MatchEnded", data: { WinnerTeamNum: 0 } });
  feed({ event: "PodiumStart", data: {} });
  assert.equal(results.length, 1);
  const r = results[0];
  assert.deepEqual([r.a, r.b, r.winner, r.ot, r.otSeconds], [3, 1, "a", false, null]);
  assert.deepEqual(r.players[0], { name: "Axiom", side: "a", goals: 3, assists: 1, saves: 2, shots: 4, score: 420, demos: 1 });
  assert.equal(r.players[1].side, "b");
  assert.equal(r.players[1].demos, 0, "a missing stat is 0, not undefined");
});

test("no platform account ID is ever copied", () => {
  const { results, feed } = harness();
  run(feed, 300, 0, 2, 0);
  feed({ event: "MatchEnded", data: {} });
  const text = JSON.stringify(results);
  assert.ok(!/Steam|Epic|7656|PrimaryId/i.test(text), text);
});

test("level at 0:00 and the clock climbs: overtime, with the time played", () => {
  const { results, feed } = harness();
  run(feed, 300, 0, 2, 2);
  for (let i = 0; i < 4; i++) feed(frame(0, 2, 2)); // OT kickoff countdown, clock held at 0
  for (let t = 1; t <= 72; t++) feed(frame(t, 2, 2));
  feed(frame(72, 3, 2));
  feed({ event: "MatchEnded", data: { WinnerTeamNum: 0 } });
  assert.equal(results.length, 1);
  assert.equal(results[0].ot, true);
  assert.equal(results[0].otSeconds, 72);
  assert.equal(results[0].winner, "a");
});

test("a goal at 0:00 with the ball in play is not overtime", () => {
  const { results, feed } = harness();
  run(feed, 300, 0, 1, 1);
  feed(frame(0, 1, 2)); // scores on the zero-second ball; the clock never climbs
  feed({ event: "MatchEnded", data: { WinnerTeamNum: 1 } });
  assert.equal(results[0].ot, false);
  assert.equal(results[0].otSeconds, null);
  assert.equal(results[0].winner, "b");
});

test("RL's own IsOT flag counts as overtime", () => {
  const { results, feed } = harness();
  run(feed, 300, 0, 0, 0);
  for (let t = 1; t <= 10; t++) feed(frame(t, 0, 0, { game: { IsOT: true } }));
  feed(frame(10, 0, 1, { game: { IsOT: true } }));
  feed({ event: "MatchEnded", data: {} });
  assert.equal(results[0].ot, true);
  assert.equal(results[0].winner, "b", "winner from the score when RL names none");
});

test("pre-kickoff 0:00 frames before the clock ever ran are not overtime", () => {
  const { results, feed } = harness();
  for (let i = 0; i < 5; i++) feed(frame(0, 0, 0));
  run(feed, 300, 0, 2, 1);
  feed({ event: "MatchEnded", data: {} });
  assert.equal(results[0].ot, false);
});

test("a level game with no winner named is not reported", () => {
  const { results, feed } = harness();
  run(feed, 300, 290, 1, 1);
  feed({ event: "MatchEnded", data: {} });
  assert.equal(results.length, 0);
});

test("a new match (same GUID, as the mock does) is reported again", () => {
  const { results, feed } = harness();
  run(feed, 300, 0, 1, 0);
  feed({ event: "MatchEnded", data: {} });
  feed(frame(0, 1, 0)); // podium frames: ignored
  feed({ event: "MatchEnded", data: {} });
  assert.equal(results.length, 1, "podium frames and a repeat MatchEnded are the same game");
  feed({ event: "MatchCreated", data: {} });
  run(feed, 300, 0, 0, 2);
  feed({ event: "MatchEnded", data: {} });
  assert.equal(results.length, 2);
  assert.deepEqual([results[1].a, results[1].b, results[1].winner, results[1].ot], [0, 2, "b", false]);
});

test("a new GUID starts clean overtime tracking", () => {
  const { results, feed } = harness();
  run(feed, 300, 0, 1, 1); // level at zero in game one...
  feed({ event: "MatchCreated", data: {} });
  run(feed, 300, 0, 2, 0, { guid: "g2" }); // ...game two ends in regulation
  feed(frame(5, 2, 0, { guid: "g2" })); // a stray climbing frame must not read as overtime
  feed({ event: "MatchEnded", data: {} });
  assert.equal(results[0].ot, false);
});

test("MatchEnded with no frame seen reports nothing", () => {
  const { results, feed } = harness();
  feed({ event: "MatchEnded", data: { WinnerTeamNum: 0 } });
  assert.equal(results.length, 0);
});
