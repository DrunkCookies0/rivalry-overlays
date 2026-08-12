/* =============================================================================
 * RIVALRY OBS Controller
 * -----------------------------------------------------------------------------
 * Thin wrapper around obs-websocket-js. The producer's OBS is a black box from
 * our side: we connect when settings allow it, auto-reconnect when it drops
 * (OBS gets relaunched mid-stream more often than you'd think), expose a small
 * set of scene operations the rest of the app calls into, and emit status
 * updates so the tray menu can show "connected" vs "disconnected".
 *
 * Designed to be a NO-OP when disabled. The shipped app still works without
 * obs-websocket enabled, without a password, or without OBS open at all.
 * ===========================================================================*/

"use strict";

const EventEmitter = require("events");

const RECONNECT_MS = 5000;

function createOBSController() {
  const emitter = new EventEmitter();
  let obs = null;            // lazy-required obs-websocket-js client
  let settings = null;       // { enabled, url, password }
  let connected = false;
  let connecting = false;
  let lastError = null;
  let reconnectTimer = null;
  // Bumped on every applySettings/disconnect; an in-flight connect that
  // resolves under an old generation must not claim "connected" against
  // settings that have since changed.
  let generation = 0;

  function setStatus(s) {
    emitter.emit("status", {
      connected,
      enabled: !!(settings && settings.enabled),
      error: lastError,
      ...s,
    });
  }

  async function connect() {
    if (!settings || !settings.enabled) return;
    if (connecting || connected) return;
    if (!obs) {
      // Lazy-require so the app still boots if the dep is missing in dev.
      const { default: OBSWebSocket } = await import("obs-websocket-js");
      obs = new OBSWebSocket();
      obs.on("ConnectionClosed", () => {
        connected = false;
        setStatus();
        scheduleReconnect();
      });
    }
    connecting = true;
    const gen = generation;
    try {
      await obs.connect(settings.url, settings.password || undefined);
      connecting = false;
      if (gen !== generation) {
        // Settings changed while dialing: this connection targets the old
        // url/password. Drop it and dial the current settings (the newer
        // applySettings' connect() early-returned while we were in flight).
        try { await obs.disconnect(); } catch { /* already closed */ }
        connect();
        return;
      }
      connected = true;
      lastError = null;
      setStatus();
    } catch (e) {
      connecting = false;
      if (gen !== generation) { connect(); return; }
      connected = false;
      lastError = e && e.message ? e.message : String(e);
      setStatus();
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (!settings || !settings.enabled) return;
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_MS);
  }

  async function disconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (obs && connected) {
      try { await obs.disconnect(); } catch (e) { /* ignore */ }
    }
    connected = false;
    setStatus();
  }

  async function applySettings(next) {
    const wasEnabled = !!(settings && settings.enabled);
    const sameTarget = settings &&
      settings.url === next.url &&
      settings.password === next.password &&
      settings.enabled === next.enabled;
    if (sameTarget) { setStatus(); return; }
    generation++; // invalidate any in-flight connect against the old target
    settings = { ...next };
    if (!next.enabled) {
      await disconnect();
      setStatus();
      return;
    }
    // Settings changed or first enable: reconnect cleanly.
    if (wasEnabled) await disconnect();
    connect();
  }

  async function listScenes() {
    if (!connected) throw new Error("OBS not connected");
    const r = await obs.call("GetSceneList");
    return r.scenes.map((s) => s.sceneName).reverse(); // OBS returns bottom-up
  }

  // Raw scene names in OBS's own order (no reverse) — used when cleaning up a
  // freshly-created collection's default scene.
  async function sceneNames() {
    if (!connected) throw new Error("OBS not connected");
    return (await obs.call("GetSceneList")).scenes.map((s) => s.sceneName);
  }

  // Create (or switch to) a dedicated scene collection so we build our scenes
  // in their own space and never touch the producer's existing collections.
  // CreateSceneCollection both creates AND switches, blocking until the switch
  // finishes, so calls made right after are safe. Returns { created } so the
  // caller knows whether to clean up the default empty scene.
  async function ensureSceneCollection(name) {
    if (!connected) throw new Error("OBS not connected");
    const { sceneCollections, currentSceneCollectionName } =
      await obs.call("GetSceneCollectionList");
    if (sceneCollections.includes(name)) {
      if (currentSceneCollectionName !== name) {
        await obs.call("SetCurrentSceneCollection", { sceneCollectionName: name });
      }
      return { created: false };
    }
    await obs.call("CreateSceneCollection", { sceneCollectionName: name });
    return { created: true };
  }

  async function removeScene(sceneName) {
    if (!connected || !sceneName) return false;
    try { await obs.call("RemoveScene", { sceneName }); return true; }
    catch (e) { return false; } // e.g. can't remove the last/only scene
  }

  async function switchScene(sceneName) {
    if (!connected || !sceneName) return false;
    try {
      await obs.call("SetCurrentProgramScene", { sceneName });
      return true;
    } catch (e) {
      lastError = e && e.message ? e.message : String(e);
      setStatus();
      return false;
    }
  }

  // Idempotent scene+browser-source template creator. Used by the tray's
  // "Set up OBS scenes" action so casters don't have to add browser sources
  // by hand. If a scene already exists we leave it alone. If a browser source
  // with the same name exists in a scene we leave it alone.
  async function createSceneWithBrowserSource({ sceneName, sourceName, url, width = 1920, height = 1080 }) {
    if (!connected) throw new Error("OBS not connected");
    const existingScenes = (await obs.call("GetSceneList")).scenes.map((s) => s.sceneName);
    if (!existingScenes.includes(sceneName)) {
      await obs.call("CreateScene", { sceneName });
    }
    const existingInputs = (await obs.call("GetInputList", {})).inputs.map((i) => i.inputName);
    if (existingInputs.includes(sourceName)) return { sceneCreated: !existingScenes.includes(sceneName), sourceCreated: false };
    await obs.call("CreateInput", {
      sceneName,
      inputName: sourceName,
      inputKind: "browser_source",
      // Keep in lockstep with bridge/obs-collection.js makeBrowserSource so
      // websocket-created sources match ones from an imported collection.
      inputSettings: { url, width, height, fps: 60, fps_custom: true, shutdown: false, reroute_audio: false },
    });
    return { sceneCreated: !existingScenes.includes(sceneName), sourceCreated: true };
  }

  // Pre-place a game-capture source at the BOTTOM of a scene (under the overlay)
  // set to grab any fullscreen game. `rect` scales it into a sub-rectangle of
  // the canvas (the chrome safe area); omitted, it fills the full canvas.
  // Idempotent: if a source with this name already exists it is left alone.
  async function ensureGameCapture({ sceneName, sourceName, rect }) {
    if (!connected) throw new Error("OBS not connected");
    const r = rect || { x: 0, y: 0, width: 1920, height: 1080 };
    const inputs = (await obs.call("GetInputList", {})).inputs.map((i) => i.inputName);
    if (inputs.includes(sourceName)) return { created: false };
    const created = await obs.call("CreateInput", {
      sceneName,
      inputName: sourceName,
      inputKind: "game_capture",
      inputSettings: { capture_mode: "any", capture_cursor: false, allow_transparency: false },
    });
    // New inputs land on top; push to the bottom so the overlay stays in front.
    await obs.call("SetSceneItemIndex", { sceneName, sceneItemId: created.sceneItemId, sceneItemIndex: 0 });
    await obs.call("SetSceneItemTransform", {
      sceneName,
      sceneItemId: created.sceneItemId,
      sceneItemTransform: {
        boundsType: "OBS_BOUNDS_SCALE_INNER",
        boundsWidth: r.width,
        boundsHeight: r.height,
        positionX: r.x,
        positionY: r.y,
        alignment: 5,
      },
    });
    return { created: true };
  }

  // Pin one shared input (the chrome frame) on TOP of a scene. OBS inputs are
  // global: the first call creates the input, later calls just add a scene
  // item referencing it. Idempotent per scene: if the scene already contains
  // an item for this source, only its z-order is reasserted.
  async function ensureSourceOnTop({ sceneName, sourceName, url, width = 1920, height = 1080 }) {
    if (!connected) throw new Error("OBS not connected");
    const items = (await obs.call("GetSceneItemList", { sceneName })).sceneItems;
    let itemId = null;
    const existing = items.find((i) => i.sourceName === sourceName);
    if (existing) {
      itemId = existing.sceneItemId;
    } else {
      const inputs = (await obs.call("GetInputList", {})).inputs.map((i) => i.inputName);
      if (inputs.includes(sourceName)) {
        itemId = (await obs.call("CreateSceneItem", { sceneName, sourceName })).sceneItemId;
      } else {
        itemId = (await obs.call("CreateInput", {
          sceneName,
          inputName: sourceName,
          inputKind: "browser_source",
          // Keep in lockstep with makeBrowserSource in bridge/obs-collection.js.
          inputSettings: { url, width, height, fps: 60, fps_custom: true, shutdown: false, reroute_audio: false },
        })).sceneItemId;
      }
    }
    // Highest index renders in front; re-fetch the count since we may have
    // just added an item.
    const count = (await obs.call("GetSceneItemList", { sceneName })).sceneItems.length;
    await obs.call("SetSceneItemIndex", { sceneName, sceneItemId: itemId, sceneItemIndex: Math.max(0, count - 1) });
    return { itemId };
  }

  return {
    on: emitter.on.bind(emitter),
    applySettings,
    connect,
    disconnect,
    listScenes,
    sceneNames,
    ensureSceneCollection,
    removeScene,
    switchScene,
    createSceneWithBrowserSource,
    ensureGameCapture,
    ensureSourceOnTop,
    get status() {
      return { connected, enabled: !!(settings && settings.enabled), error: lastError };
    },
  };
}

module.exports = { createOBSController };
