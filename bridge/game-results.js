/* =============================================================================
 * RIVALRY game-result catcher
 * -----------------------------------------------------------------------------
 * Catches each finished game's result off the RL feed so the producer can add
 * it to the series with one click (the series update scene's game list and
 * series MVP read it from control.series.games, CONTRACT.md).
 *
 * It only CATCHES. Nothing reaches an overlay until the producer confirms it
 * in the panel: a game the app saw by accident (a warm-up, a scrim, the mock)
 * must never land in the series on its own.
 *
 * Fed every game envelope the bridge fans out. It keeps the latest UpdateState
 * and, on MatchEnded (or PodiumStart, whichever arrives first), reports:
 *
 *   { a, b,            final goals, team 0 (Blue, Team A) and team 1
 *     winner,          "a" | "b"
 *     ot,              true when the game went to overtime
 *     otSeconds,       overtime played, whole seconds (null in regulation)
 *     players: [{ name, side, goals, assists, saves, shots, score, demos }] }
 *
 * Players carry the in-game name only. RL's PrimaryId (a platform account ID)
 * is never copied: the league has minors, and IGNs are all a scene needs.
 *
 * Overtime, the way the gameplay scene reads it (RL leaves Game.IsOT unset in
 * private matches): the regulation clock runs down to 0 with the scores level,
 * and then the clock counts UP. A goal at 0:00 with the ball still in play
 * ends the game level on the clock, but the clock never climbs, so it is not
 * overtime. Game.IsOT, when RL does set it, is taken as is.
 *
 * Pure + injectable: no Electron, no sockets, so it unit-tests directly.
 * ===========================================================================*/

"use strict";

const STAT_KEYS = ["goals", "assists", "saves", "shots", "score", "demos"];
const RL_KEYS = { goals: "Goals", assists: "Assists", saves: "Saves", shots: "Shots", score: "Score", demos: "Demos" };

// A new match starts on any of these, so a game that already ended can never
// be reported twice and the next one starts with clean overtime tracking.
// (The mock reuses one MatchGuid for every match, so the GUID alone can't say.)
const NEW_MATCH_EVENTS = new Set(["MatchCreated", "MatchInitialized"]);

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function createGameResultCatcher({ onResult }) {
  let m = null; // the match being tracked

  function fresh(guid) {
    return {
      guid,
      frame: null, // latest UpdateState data
      sawDescent: false, // the clock has counted down at least once
      levelAtZero: false, // the regulation clock reached 0 with the scores level
      ot: false,
      otSeconds: 0,
      prevTime: null,
      ended: false,
    };
  }

  function onUpdateState(data) {
    const guid = data.MatchGuid == null ? "" : String(data.MatchGuid);
    if (!m || m.guid !== guid) m = fresh(guid);
    if (m.ended) return; // podium frames after the result was caught
    const game = data.Game || {};
    const teams = Array.isArray(game.Teams) ? game.Teams : [];
    const a = num(teams[0] && teams[0].Score), b = num(teams[1] && teams[1].Score);
    m.frame = data;
    if (game.IsOT || game.isOT || game.bOvertime) m.ot = true;
    const t = game.TimeSeconds;
    if (typeof t === "number") {
      if (m.prevTime !== null) {
        if (t + 0.05 < m.prevTime) m.sawDescent = true;
        else if (m.levelAtZero && t > m.prevTime + 0.05) m.ot = true; // the clock climbs: overtime
      }
      if (m.sawDescent && t <= 0 && a === b) m.levelAtZero = true;
      if (m.ot && m.levelAtZero) m.otSeconds = Math.max(m.otSeconds, t);
      m.prevTime = t;
    }
  }

  function onEnded(data) {
    if (!m || m.ended || !m.frame) return;
    m.ended = true;
    const teams = (m.frame.Game && Array.isArray(m.frame.Game.Teams)) ? m.frame.Game.Teams : [];
    const a = num(teams[0] && teams[0].Score), b = num(teams[1] && teams[1].Score);
    let winner = null;
    const w = data && data.WinnerTeamNum;
    if (w === 0 || w === 1) winner = w === 0 ? "a" : "b";
    else if (a !== b) winner = a > b ? "a" : "b";
    // Level with no winner named: not a finished game (abandoned, or the mock).
    if (!winner) return;
    const players = (Array.isArray(m.frame.Players) ? m.frame.Players : [])
      .filter((p) => p && (p.TeamNum === 0 || p.TeamNum === 1) && String(p.Name || "").trim())
      .map((p) => {
        const out = { name: String(p.Name).trim(), side: p.TeamNum === 0 ? "a" : "b" };
        for (const k of STAT_KEYS) out[k] = num(p[RL_KEYS[k]]);
        return out;
      });
    onResult({
      a,
      b,
      winner,
      ot: m.ot,
      otSeconds: m.ot && m.otSeconds > 0 ? Math.round(m.otSeconds) : null,
      players,
    });
  }

  return function feed(env) {
    if (!env || typeof env.event !== "string") return;
    const ev = env.event;
    const data = env.data && typeof env.data === "object" ? env.data : {};
    if (ev === "UpdateState") onUpdateState(data);
    else if (ev === "MatchEnded" || ev === "PodiumStart") onEnded(data);
    else if (NEW_MATCH_EVENTS.has(ev)) m = null;
  };
}

module.exports = { createGameResultCatcher };
