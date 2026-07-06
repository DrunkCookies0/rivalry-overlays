/* =============================================================================
 * RIVALRY Overlay SDK  v1
 * -----------------------------------------------------------------------------
 * The runtime every RIVALRY overlay codes against. Drop this one file in,
 * include it with a <script> tag, and you get:
 *   - one clean connection to the game feed + control bus (auto-reconnect)
 *   - a normalized view that hides the raw feed's quirks (IsOT vs isOT, etc.)
 *   - a built-in mock so you can design with NO Rocket League and NO app running
 *   - small format helpers (clock, ball speed) so every overlay agrees
 *
 * It exposes a single global: `RivalryOverlay`. No build step, no dependencies.
 *
 * QUICK START
 *   const rl = RivalryOverlay.connect();          // game + control + auto-mock
 *   rl.on('UpdateState', (data) => { ... });      // raw feed events
 *   rl.onControl((c) => { ... });                 // team names / logos / series
 *   rl.onConnection((s) => { ... });              // { game, control } status
 *
 * The full data contract these events follow is in ../CONTRACT.md. This file
 * is a convenience layer over that contract, never a replacement for it.
 *
 * IMPORTANT: to receive the REAL feed, your overlay must be SERVED BY THE APP
 * (origin http://localhost:49080). Opening the .html straight off disk
 * (file://) is blocked from the live sockets by the bridge's origin check —
 * so file:// automatically falls back to the built-in mock. See ../CONTRACT.md.
 * ===========================================================================*/

(function (global) {
  "use strict";

  var GAME_WS = "ws://localhost:49124";
  var CONTROL_WS = "ws://localhost:49777";

  // Speed conversions for Ball.Speed. NOTE: the raw unit RL reports here is not
  // yet confirmed against a capture; these assume Rocket League Unreal-units/sec.
  // Treat ballSpeed() output as provisional until verified. See [[ball-speed-units]].
  var UU_PER_MPH = 44.704;
  var UU_PER_KPH = 27.7778;

  function noop() {}

  function url(opts) {
    // Allow ?game=ws://... overrides for advanced testing, but default to the app ports.
    var q = {};
    try {
      new URLSearchParams(global.location.search).forEach(function (v, k) { q[k] = v; });
    } catch (e) { /* file:// without search is fine */ }
    return {
      game: opts.gameUrl || q.game || GAME_WS,
      control: opts.controlUrl || q.control || CONTROL_WS,
      query: q,
    };
  }

  // ---- a tiny auto-reconnecting socket ------------------------------------
  // Exponential backoff with jitter so a dropped bridge (app restart, RL relaunch)
  // is recovered without a thundering-herd reconnect storm. Roadmap P1 wants this
  // on the shipped overlay too; the SDK gives community overlays it for free.
  function makeSocket(name, endpoint, onMessage, onStatus) {
    var ws = null;
    var attempt = 0;
    var closed = false;

    function open() {
      if (closed) return;
      try {
        ws = new WebSocket(endpoint);
      } catch (e) {
        schedule();
        return;
      }
      ws.onopen = function () {
        attempt = 0;
        onStatus("open");
      };
      ws.onmessage = function (e) {
        var msg;
        try { msg = JSON.parse(e.data); } catch (err) { return; }
        onMessage(msg);
      };
      ws.onerror = function () { try { ws.close(); } catch (e) {} };
      ws.onclose = function () {
        onStatus("closed");
        schedule();
      };
    }

    function schedule() {
      if (closed) return;
      attempt++;
      var base = Math.min(8000, 500 * Math.pow(2, attempt - 1));
      var jitter = base * 0.25 * Math.random();
      setTimeout(open, base + jitter);
    }

    open();
    return {
      send: function (obj) {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
      },
      close: function () { closed = true; if (ws) try { ws.close(); } catch (e) {} },
    };
  }

  // ---- the SDK instance ---------------------------------------------------
  function Overlay() {
    this._handlers = {};       // eventName -> [fn]
    this._anyHandlers = [];     // fn(eventName, data)
    this._controlHandlers = [];
    this._connHandlers = [];
    this.state = null;          // last UpdateState .data (raw)
    this.control = defaultControl();
    this._status = { game: "connecting", control: "connecting" };
    this._game = null;
    this._control = null;
    this._mock = null;
  }

  Overlay.prototype.on = function (eventName, fn) {
    (this._handlers[eventName] = this._handlers[eventName] || []).push(fn);
    return this;
  };
  Overlay.prototype.onAny = function (fn) { this._anyHandlers.push(fn); return this; };
  Overlay.prototype.onControl = function (fn) {
    this._controlHandlers.push(fn);
    // Fire immediately with current control so late subscribers aren't blank.
    try { fn(this.control); } catch (e) {}
    return this;
  };
  Overlay.prototype.onConnection = function (fn) {
    this._connHandlers.push(fn);
    try { fn(this._status); } catch (e) {}
    return this;
  };
  Overlay.prototype.off = function (eventName, fn) {
    var arr = this._handlers[eventName];
    if (arr) this._handlers[eventName] = arr.filter(function (h) { return h !== fn; });
    return this;
  };

  Overlay.prototype._emit = function (eventName, data) {
    if (eventName === "UpdateState") this.state = data;
    var arr = this._handlers[eventName] || [];
    for (var i = 0; i < arr.length; i++) { try { arr[i](data); } catch (e) { console.error(e); } }
    for (var j = 0; j < this._anyHandlers.length; j++) { try { this._anyHandlers[j](eventName, data); } catch (e) {} }
  };

  Overlay.prototype._emitControl = function (payload) {
    // Merge so a partial control push doesn't wipe fields not included.
    this.control = Object.assign({}, this.control, payload || {});
    for (var i = 0; i < this._controlHandlers.length; i++) {
      try { this._controlHandlers[i](this.control); } catch (e) { console.error(e); }
    }
  };

  Overlay.prototype._setStatus = function (which, value) {
    this._status[which] = value;
    for (var i = 0; i < this._connHandlers.length; i++) {
      try { this._connHandlers[i](this._status); } catch (e) {}
    }
  };

  // --- normalized convenience views over the raw contract ------------------

  // OT is genuinely hard: IsOT / isOT / bOvertime are inconsistent and unreliable
  // in bot/private matches. This mirrors the shipped overlay's hybrid: trust an
  // explicit flag if present, else infer from a tied score with an ascending
  // clock. Documented as best-effort, not gospel. See [[ot-detection-hybrid]].
  Overlay.prototype.isOvertime = function (data) {
    var d = data || this.state;
    if (!d || !d.Game) return false;
    var g = d.Game;
    var flag = g.IsOT != null ? g.IsOT : (g.isOT != null ? g.isOT : g.bOvertime);
    if (flag === true) return true;
    return false; // clock-direction inference is left to the overlay's own state machine
  };

  Overlay.prototype.teams = function (data) {
    var d = data || this.state;
    return (d && d.Game && d.Game.Teams) || [];
  };

  Overlay.prototype.scores = function (data) {
    var t = this.teams(data);
    return [t[0] ? (t[0].Score || 0) : 0, t[1] ? (t[1].Score || 0) : 0];
  };

  // RL team colors: TeamNum 0 = blue, 1 = orange. Prefer the feed's ColorPrimary
  // (hex without '#'); fall back to canonical RL blue/orange.
  Overlay.prototype.teamColor = function (teamNum, data) {
    var t = this.teams(data)[teamNum];
    if (t && t.ColorPrimary) return "#" + String(t.ColorPrimary).replace(/^#/, "");
    return teamNum === 0 ? "#3b8fff" : "#ff7a2f";
  };

  Overlay.prototype.players = function (data) {
    var d = data || this.state;
    return (d && d.Players) || [];
  };

  // The player currently being spectated (UpdateState.Target is a player Name).
  Overlay.prototype.target = function (data) {
    var d = data || this.state;
    return d ? (d.Target || (d.Game && d.Game.Target) || "") : "";
  };

  Overlay.prototype.format = {
    // 0-padded clock. In regulation the feed counts down; in OT it counts up.
    // Pass {ot:true} to prefix a '+'.
    clock: function (seconds, opts) {
      seconds = Math.max(0, Math.round(seconds || 0));
      var m = Math.floor(seconds / 60);
      var s = seconds % 60;
      var str = m + ":" + (s < 10 ? "0" + s : s);
      return opts && opts.ot ? "+" + str : str;
    },
    // Ball.Speed -> display string. region 'NA' (default) => MPH, else KPH.
    // See the unit caveat at the top of this file.
    ballSpeed: function (raw, opts) {
      raw = raw || 0;
      var region = (opts && opts.region) || "NA";
      if (region === "NA") return Math.round(raw / UU_PER_MPH) + " MPH";
      return Math.round(raw / UU_PER_KPH) + " KPH";
    },
  };

  // --- preview / approval badge -------------------------------------------
  // The production loader will set window.__RIVALRY_SIGNED__ = true for an
  // approved (signed) overlay. Absent that, the overlay is running in dev/preview
  // and we stamp a corner badge so a producer can never confuse an unapproved
  // overlay for an approved one on a live broadcast.
  Overlay.prototype.previewBadge = function (force) {
    if (global.__RIVALRY_SIGNED__ === true && !force) return;
    if (global.document.getElementById("rivalry-preview-badge")) return;
    var style = global.document.createElement("style");
    style.textContent =
      "#rivalry-preview-badge{position:fixed;left:16px;bottom:16px;z-index:99999;" +
      "font:600 13px/1 'Space Mono',monospace;letter-spacing:.08em;color:#0b0b0b;" +
      "background:#ffd23f;padding:7px 11px;border-radius:6px;opacity:.92;" +
      "box-shadow:0 2px 10px rgba(0,0,0,.45);pointer-events:none;}";
    global.document.head.appendChild(style);
    var el = global.document.createElement("div");
    el.id = "rivalry-preview-badge";
    el.textContent = "PREVIEW — NOT APPROVED";
    global.document.body.appendChild(el);
  };

  // --- connect -------------------------------------------------------------
  Overlay.prototype.connect = function (opts) {
    opts = opts || {};
    var self = this;
    var endpoints = url(opts);

    // Decide whether to use the real sockets or the built-in mock.
    //   mock:true  -> always mock
    //   mock:false -> always real
    //   (default)  -> mock on file:// (sockets are origin-blocked there) or ?mock=1
    var wantMock =
      opts.mock === true ||
      endpoints.query.mock === "1" ||
      (opts.mock !== false && global.location && global.location.protocol === "file:");

    if (wantMock) {
      this._mock = startMock(function (msg) { self._dispatchGame(msg); }, function (c) { self._emitControl(c); });
      this._setStatus("game", "mock");
      this._setStatus("control", "mock");
      // Show the preview badge by default in mock mode unless told otherwise.
      if (opts.badge !== false && global.document) {
        if (global.document.body) this.previewBadge();
        else global.addEventListener("DOMContentLoaded", function () { self.previewBadge(); });
      }
      return this;
    }

    if (opts.game !== false) {
      this._game = makeSocket("game", endpoints.game,
        function (msg) { self._dispatchGame(msg); },
        function (st) { self._setStatus("game", st); });
    }
    if (opts.control !== false) {
      this._control = makeSocket("control", endpoints.control,
        function (msg) { if (msg && msg.type === "control") self._emitControl(msg.payload); },
        function (st) { self._setStatus("control", st); });
    }

    // Stamp the preview badge unless this overlay was loaded as an approved one.
    if (opts.badge !== false && global.document) {
      if (global.document.body) this.previewBadge();
      else global.addEventListener("DOMContentLoaded", function () { self.previewBadge(); });
    }
    return this;
  };

  Overlay.prototype._dispatchGame = function (msg) {
    if (!msg || !msg.event) return;
    this._emit(msg.event, msg.data || {});
  };

  Overlay.prototype.sendControl = function (payload) {
    // Mostly for tooling/test pages: push a control payload onto the bus.
    if (this._control) this._control.send({ type: "control", payload: payload });
    else this._emitControl(payload); // mock mode: apply locally
  };

  function defaultControl() {
    return {
      teamA: { name: "BLUE", logo: "", tag: "" },
      teamB: { name: "ORANGE", logo: "", tag: "" },
      bestOf: 5,
      series: { a: 0, b: 0 },
      eventTitle: "RIVALRY",
    };
  }

  // --- built-in mock feed --------------------------------------------------
  // Schema-accurate fake data so a designer can build the whole overlay with
  // neither Rocket League nor the app running (e.g. opening index.html off disk
  // or on any static host). Mirrors bridge/rl-bridge.js startMockFeed() shape.
  function startMock(emitGame, emitControl) {
    var names = [["Comet", "Volt", "Nova"], ["Razor", "Echo", "Drift"]];
    var flat = ["Comet", "Volt", "Nova", "Razor", "Echo", "Drift"];
    var score = [0, 0];
    var clock = 300;
    var targetIdx = 0;
    var boost = [[33, 100, 12], [78, 5, 60]];
    // [Goals, Assists, Saves, Shots, Demos, Score] per player -> a realistic box score for the post-game scene.
    var STATS = [[[2, 1, 2, 5, 1, 520], [1, 2, 4, 3, 0, 470], [0, 1, 6, 2, 1, 410]],
                 [[1, 1, 2, 4, 1, 360], [1, 0, 3, 3, 0, 300], [0, 2, 5, 1, 0, 280]]];

    // Mirror the FULL control payload (see ../CONTRACT.md) so presentation
    // scenes (preview/up-next/casters) populate under the mock, not just the
    // gameplay overlay. Real values come from the control panel in production.
    emitControl({
      brand: { leagueName: "RIVALRY" },
      eventTitle: "RIVALRY SEASON 1 | PLAYOFFS",
      round: "UPPER BRACKET • ROUND 1",
      bestOf: 5,
      startTime: "8:00 PM ET",
      teamA: { name: "GUARDIANS", logo: "", tag: "NA1", seed: "#1", record: "12-3" },
      teamB: { name: "SENTINELS", logo: "", tag: "NA2", seed: "#4", record: "9-6" },
      series: { a: 1, b: 2 },
      casters: [
        { name: "MASTER CHIEF", role: "PLAY-BY-PLAY", handle: "@masterchief", avatar: "" },
        { name: "LARA CROFT", role: "COLOR", handle: "@laracroft", avatar: "" },
        { name: "GORDON FREEMAN", role: "DESK", handle: "@gordonfreeman", avatar: "" },
      ],
      upNext: [
        { teamA: "NOVA", teamB: "ECLIPSE", time: "9:30 ET", round: "UB R1" },
        { teamA: "VOLT", teamB: "DRIFT", time: "10:00 ET", round: "LB R1" },
        { teamA: "APEX", teamB: "ZENITH", time: "10:30 ET", round: "LB R1" },
      ],
      bracket: { rounds: [
        { name: "QUARTERFINALS", matchups: [
          { teamA: "GUARDIANS", teamB: "DRIFT", scoreA: 3, scoreB: 1 },
          { teamA: "SENTINELS", teamB: "VOLT", scoreA: 2, scoreB: 3 },
          { teamA: "NOVA", teamB: "ECHO", scoreA: 3, scoreB: 2 },
          { teamA: "APEX", teamB: "ZENITH", scoreA: 1, scoreB: 3 } ] },
        { name: "SEMIFINALS", matchups: [
          { teamA: "GUARDIANS", teamB: "VOLT", scoreA: 3, scoreB: 0 },
          { teamA: "NOVA", teamB: "ZENITH", scoreA: 2, scoreB: 3 } ] },
        { name: "FINAL", matchups: [ { teamA: "GUARDIANS", teamB: "ZENITH", scoreA: 4, scoreB: 2 } ] },
      ], champion: "GUARDIANS" },
    });

    var t1 = setInterval(function () { targetIdx = (targetIdx + 1) % flat.length; }, 3500);

    var t2 = setInterval(function () {
      clock = Math.max(0, clock - 1 / 5);
      var players = [];
      for (var team = 0; team < 2; team++) {
        for (var p = 0; p < 3; p++) {
          boost[team][p] = Math.max(0, Math.min(100, boost[team][p] + (Math.random() * 30 - 15)));
          var st = STATS[team][p];
          players.push({
            Name: names[team][p], TeamNum: team, Score: st[5],
            Goals: st[0], Shots: st[3], Assists: st[1], Saves: st[2], Demos: st[4],
            Touches: 12, Boost: Math.round(boost[team][p]),
          });
        }
      }
      emitGame({ event: "UpdateState", data: {
        MatchGuid: "mock-match", Target: flat[targetIdx], Players: players,
        Game: { Teams: [
          { Name: "GUARDIANS", TeamNum: 0, Score: score[0], ColorPrimary: "3b8fff" },
          { Name: "SENTINELS", TeamNum: 1, Score: score[1], ColorPrimary: "ff7a2f" },
        ], TimeSeconds: Math.round(clock), Ball: { Speed: 30 }, Winner: "" },
      }});
    }, 200);

    function goalSequence() {
      var team = Math.random() < 0.5 ? 0 : 1;
      score[team]++;
      var scorer = names[team][Math.floor(Math.random() * 3)];
      emitGame({ event: "GoalScored", data: { MatchGuid: "mock-match", GoalSpeed: 88, Scorer: { Name: scorer, TeamNum: team } } });
      setTimeout(function () { emitGame({ event: "GoalReplayStart", data: {} }); }, 3500);
      setTimeout(function () { emitGame({ event: "GoalReplayWillEnd", data: {} }); }, 10800);
      setTimeout(function () { emitGame({ event: "GoalReplayEnd", data: {} }); }, 13800);
      setTimeout(function () { emitGame({ event: "CountdownBegin", data: {} }); }, 13800);
      setTimeout(function () { emitGame({ event: "RoundStarted", data: {} }); }, 17800);
    }
    var t3 = setInterval(goalSequence, 20000);

    // Cycle a match end so the post-game results scene can preview its freeze, then reset to live.
    var t4 = setInterval(function () {
      emitGame({ event: "MatchEnded", data: {} });
      emitGame({ event: "PodiumStart", data: {} });
      setTimeout(function () { score[0] = 0; score[1] = 0; clock = 300; emitGame({ event: "MatchCreated", data: {} }); }, 6000);
    }, 45000);

    return { stop: function () { clearInterval(t1); clearInterval(t2); clearInterval(t3); clearInterval(t4); } };
  }

  // --- public surface ------------------------------------------------------
  var api = {
    VERSION: "1.0.0",
    CONTRACT: "1.x",
    GAME_WS: GAME_WS,
    CONTROL_WS: CONTROL_WS,
    // connect() returns a live instance; most overlays just keep the one.
    connect: function (opts) { return new Overlay().connect(opts); },
    // create() if you want the instance before connecting (e.g. wire handlers first).
    create: function () { return new Overlay(); },
  };

  global.RivalryOverlay = api;
})(typeof window !== "undefined" ? window : this);
