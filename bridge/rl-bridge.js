/* =============================================================================
 * RIVALRY RL Bridge  (importable module + CLI)
 * -----------------------------------------------------------------------------
 * Rocket League's official Stats API ("MatchStatsExporter_TA") opens a RAW
 * TCP socket on 127.0.0.1:49123 and streams concatenated JSON while a match
 * is live. Browsers can't read raw TCP, so this module bridges it to a
 * WebSocket the overlay subscribes to.
 *
 * Exports:
 *   runSetup()          - writes DefaultStatsAPI.ini into the RL config folder
 *   startBridge({mock}) - starts the game-feed + control WebSocket servers and
 *                         connects to Rocket League (or emits mock data)
 *
 * CLI (when run directly with `node rl-bridge.js`):
 *   --setup   run runSetup() and exit
 *   --mock    start the bridge with fake match data
 *   (none)    start the bridge against a real Rocket League
 * ===========================================================================*/

"use strict";

const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ---- Local ports (change here if any collide with other apps) --------------
const RL_TCP_HOST = "127.0.0.1";
const RL_TCP_PORT = 49123; // must match Port= in DefaultStatsAPI.ini
const GAME_WS_PORT = 49124; // overlay subscribes here for live match data
const CONTROL_WS_PORT = 49777; // control panel <-> overlay relay
const PACKET_SEND_RATE = 60; // Hz written into the ini (1-120, 0 disables)

// =============================================================================
// 1. SETUP: enable the Stats API by writing DefaultStatsAPI.ini
// =============================================================================
const INI_BODY =
  "[TAGame.MatchStatsExporter_TA]\r\n" +
  `Port=${RL_TCP_PORT}\r\n` +
  `PacketSendRate=${PACKET_SEND_RATE}\r\n`;

function runSetup() {
  const rel = path.join("My Games", "Rocket League", "TAGame", "Config");
  const targets = [
    path.join(os.homedir(), "Documents", rel),
    path.join(os.homedir(), "OneDrive", "Documents", rel),
  ];
  const written = [];
  for (const dir of targets) {
    if (!fs.existsSync(dir)) continue; // only write where RL config already lives
    const file = path.join(dir, "DefaultStatsAPI.ini");
    try {
      fs.writeFileSync(file, INI_BODY, "utf8");
      written.push(file);
    } catch (e) {
      console.error("[rivalry] could not write " + file + ": " + e.message);
    }
  }
  return { written, ok: written.length > 0 };
}

// =============================================================================
// 2. JSON FRAMER
//    RL sends JSON objects back-to-back with no length prefix. Walk the byte
//    stream tracking brace depth (ignoring braces inside strings) and emit one
//    complete {...} object at a time. Standard streaming-JSON pattern.
// =============================================================================
class JsonFrameBuffer {
  constructor() {
    this.buf = "";
  }
  push(chunk) {
    this.buf += chunk;
    const frames = [];
    let i = 0;
    while (i < this.buf.length) {
      if (this.buf[i] !== "{") {
        i++;
        continue;
      }
      let depth = 0,
        inStr = false,
        esc = false,
        j = i;
      for (; j < this.buf.length; j++) {
        const ch = this.buf[j];
        if (esc) {
          esc = false;
          continue;
        }
        if (ch === "\\" && inStr) {
          esc = true;
          continue;
        }
        if (ch === '"') {
          inStr = !inStr;
          continue;
        }
        if (inStr) continue;
        if (ch === "{") depth++;
        else if (ch === "}" && --depth === 0) break;
      }
      if (depth !== 0) break; // incomplete object, wait for more bytes
      frames.push(this.buf.slice(i, j + 1));
      i = j + 1;
    }
    this.buf = this.buf.slice(i);
    return frames;
  }
}

// Normalise a raw frame into { event, data }. The Stats API wraps payloads as
// { "event": "...", "data": "<json string>" } where data is sometimes a STRING
// that itself needs parsing. We unwrap it.
function decodeEnvelope(raw) {
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  let data = obj.data !== undefined ? obj.data : obj.Data;
  const event = obj.event !== undefined ? obj.event : obj.Event;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      /* leave as string */
    }
  }
  return { event, data };
}

// =============================================================================
// 3. START THE BRIDGE
// =============================================================================
function startBridge(opts = {}) {
  const mock = !!opts.mock;
  const { WebSocketServer } = require("ws");
  const EventEmitter = require("events");
  const events = new EventEmitter();

  // --- game feed: broadcast RL frames to overlay clients ---
  const gameWss = new WebSocketServer({ port: GAME_WS_PORT });
  const gameClients = new Set();
  gameWss.on("connection", (ws) => {
    gameClients.add(ws);
    ws.on("close", () => gameClients.delete(ws));
  });
  gameWss.on("listening", () =>
    console.log(`[rivalry] game feed   -> ws://localhost:${GAME_WS_PORT}`)
  );
  gameWss.on("error", (e) => console.error("[rivalry] game WS error:", e.message));

  function broadcastGame(payloadObj) {
    const msg = JSON.stringify(payloadObj);
    for (const ws of gameClients) if (ws.readyState === ws.OPEN) ws.send(msg);
    // Also fan out to internal subscribers (e.g. OBS auto-switching).
    events.emit("game", payloadObj);
  }

  // --- control relay: control panel -> overlay, with last-state retention.
  // We only hydrate new clients with `type:"control"` messages so unrelated
  // traffic (e.g. obs-settings, intended for the main process) isn't replayed
  // to a reconnecting overlay that doesn't understand it.
  const controlWss = new WebSocketServer({ port: CONTROL_WS_PORT });
  const controlClients = new Set();
  let lastControlState = null;
  controlWss.on("connection", (ws) => {
    controlClients.add(ws);
    if (lastControlState) ws.send(lastControlState);
    ws.on("message", (raw) => {
      const text = raw.toString();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* not JSON, just relay */ }
      if (parsed && parsed.type === "control") lastControlState = text;
      for (const c of controlClients)
        if (c !== ws && c.readyState === c.OPEN) c.send(text);
      if (parsed) events.emit("control", parsed, ws);
    });
    ws.on("close", () => controlClients.delete(ws));
  });
  controlWss.on("listening", () =>
    console.log(`[rivalry] control bus -> ws://localhost:${CONTROL_WS_PORT}`)
  );
  controlWss.on("error", (e) => console.error("[rivalry] control WS error:", e.message));

  function broadcastControl(payloadObj) {
    const msg = JSON.stringify(payloadObj);
    for (const c of controlClients) if (c.readyState === c.OPEN) c.send(msg);
  }

  // --- data source ---
  if (mock) startMockFeed(broadcastGame);
  else connectRocketLeague(broadcastGame);

  return { broadcastGame, broadcastControl, events };
}

function connectRocketLeague(broadcastGame) {
  const framer = new JsonFrameBuffer();
  const sock = new net.Socket();

  sock.connect(RL_TCP_PORT, RL_TCP_HOST, () =>
    console.log(`[rivalry] connected to Rocket League on ${RL_TCP_HOST}:${RL_TCP_PORT}`)
  );
  sock.on("data", (chunk) => {
    for (const raw of framer.push(chunk.toString())) {
      const env = decodeEnvelope(raw);
      if (env) broadcastGame(env);
    }
  });
  sock.on("error", () => sock.destroy());
  sock.on("close", () => {
    console.log("[rivalry] RL socket closed, retrying in 2s (launch RL / start a match)...");
    setTimeout(() => connectRocketLeague(broadcastGame), 2000);
  });
}

// ---- Mock feed: fake but schema-accurate events -----------------------------
function startMockFeed(broadcastGame) {
  console.log("[rivalry] MOCK MODE: emitting fake match data (Rocket League not required)");
  const names = [
    ["Comet", "Volt", "Nova"],
    ["Razor", "Echo", "Drift"],
  ];
  const flat = [
    ["Comet", 0], ["Volt", 0], ["Nova", 0],
    ["Razor", 1], ["Echo", 1], ["Drift", 1],
  ];
  let targetIdx = 0;
  const score = [0, 0];
  let clock = 300;
  const boost = [
    [33, 100, 12],
    [78, 5, 60],
  ];

  setInterval(() => { targetIdx = (targetIdx + 1) % flat.length; }, 3500);

  setInterval(() => {
    clock = Math.max(0, clock - 1 / 5);
    const players = [];
    for (let team = 0; team < 2; team++) {
      for (let p = 0; p < 3; p++) {
        boost[team][p] = Math.max(0, Math.min(100, boost[team][p] + (Math.random() * 30 - 15)));
        players.push({
          Name: names[team][p],
          PrimaryId: `Mock|${team}|${p}`,
          TeamNum: team,
          Score: 100 * (p + 1),
          Goals: team === 0 ? (p === 0 ? score[0] : 0) : p === 1 ? score[1] : 0,
          Shots: 2 + p,
          Assists: p,
          Saves: 1,
          Touches: 12,
          Boost: Math.round(boost[team][p]),
        });
      }
    }
    broadcastGame({
      event: "UpdateState",
      data: {
        MatchGuid: "mock-match",
        Target: flat[targetIdx][0],
        Players: players,
        Game: {
          Teams: [
            { Name: "BLUE", Score: score[0] },
            { Name: "ORANGE", Score: score[1] },
          ],
          TimeSeconds: Math.round(clock),
          Ball: { Speed: 30 },
          Winner: "",
        },
      },
    });
  }, 200);

  setInterval(() => {
    const attacker = flat[Math.floor(Math.random() * flat.length)][0];
    const victim = flat[Math.floor(Math.random() * flat.length)][0];
    broadcastGame({
      event: "StatfeedEvent",
      data: { Type: "Demolition", Attacker: { Name: attacker }, Victim: { Name: victim } },
    });
  }, 7000);

  // Full goal sequence: goal -> replay start -> replay end -> kickoff countdown
  function runGoalSequence() {
    const team = Math.random() < 0.5 ? 0 : 1;
    score[team]++;
    const scorer = names[team][Math.floor(Math.random() * 3)];
    broadcastGame({
      event: "GoalScored",
      data: { MatchGuid: "mock-match", GoalSpeed: 88, Scorer: { Name: scorer, TeamNum: team } },
    });
    setTimeout(() => broadcastGame({ event: "GoalReplayStart", data: {} }), 3000);
    setTimeout(() => broadcastGame({ event: "GoalReplayWillEnd", data: {} }), 8000);
    setTimeout(() => broadcastGame({ event: "GoalReplayEnd", data: {} }), 8800);
    setTimeout(() => broadcastGame({ event: "CountdownBegin", data: {} }), 10000);
  }
  setInterval(runGoalSequence, 14000);
}

module.exports = { runSetup, startBridge, GAME_WS_PORT, CONTROL_WS_PORT, RL_TCP_PORT };

// =============================================================================
// CLI ENTRYPOINT
// =============================================================================
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("--setup")) {
    const r = runSetup();
    if (r.ok) {
      console.log("[rivalry] wrote:\n  " + r.written.join("\n  "));
      console.log("[rivalry] Done. RESTART Rocket League for the change to take effect.");
    } else {
      console.log(
        "[rivalry] Could not find a Rocket League config folder automatically.\n" +
          "          Create this file by hand:\n" +
          "            <Documents>\\My Games\\Rocket League\\TAGame\\Config\\DefaultStatsAPI.ini\n" +
          "          with these contents:\n\n" +
          INI_BODY
      );
    }
    process.exit(0);
  }
  console.log("[rivalry] bridge starting...");
  startBridge({ mock: args.includes("--mock") });
}
