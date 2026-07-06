/* =============================================================================
 * RIVALRY OBS Scene-Collection Generator
 * -----------------------------------------------------------------------------
 * Builds an importable OBS scene collection (OBS: Scene Collection -> Import)
 * from the overlay registry: one scene per overlay, each with its browser
 * source pre-wired. Producers who can't (or won't) enable obs-websocket get
 * the same 8 broadcast scenes as a one-file import instead. Generated at
 * runtime from the registry so scene names and URLs can never drift from what
 * the app actually serves.
 *
 * The output shape is modeled field-for-field on a real scene-collection JSON
 * exported by OBS 31.0.1 on this project's reference machine. uuids are freshly
 * generated (scene items reference their browser source by BOTH name and
 * source_uuid, exactly how OBS links them).
 *
 * Every scene MUST carry canvas_uuid pointing at OBS's built-in main canvas
 * (MAIN_CANVAS_UUID below). OBS 31 ties each scene to a canvas at import; a
 * scene with no canvas_uuid is silently dropped, so the whole collection
 * imports as an empty set (name only). The main canvas is implicit (it is not
 * listed in the top-level `canvases` array, which stays empty) but its UUID is
 * a fixed libobs constant every OBS install resolves.
 *
 * Pure + dependency-light on purpose: an HTTP route (owned elsewhere) calls
 * buildSceneCollection() and serves the JSON; tests exercise it without
 * Electron or OBS.
 * ===========================================================================*/

"use strict";

const crypto = require("crypto");

// Canonical manifest `scene` -> OBS scene name map. This is THE source of
// truth (moved here from main.js) so the obs-websocket live setup and this
// importable file can never disagree about scene names. Key order doubles as
// broadcast scene order (the sequence a show runs in). Bracket is intentionally
// absent for now (only needed at playoffs); the scene folder is in git history.
const OBS_SCENE_NAMES = {
  "starting-soon": "RIVALRY - Starting Soon",
  "caster": "RIVALRY - Casters",
  "match-preview": "RIVALRY - Match Preview",
  "gameplay": "RIVALRY - Live",
  "postgame": "RIVALRY - Post-Game",
  "up-next": "RIVALRY - Up Next",
  "brb": "RIVALRY - BRB",
};

// OBS 31.0.1 stamps this version encoding on every saved source; included
// verbatim (from the reference export) so imports read as same-generation and
// no migration heuristics kick in.
const OBS_PREV_VER = 520093697;

// OBS's built-in main-canvas UUID (ASCII "libobs...main"). Deterministic across
// installs, and resolved even though the canvas is not declared in `canvases`.
// Every scene references it; without it OBS drops the scene on import.
const MAIN_CANVAS_UUID = "6c69626f-6273-4c00-9d88-c5136d61696e";

// Envelope fields OBS writes on every source entry, scene and input alike.
// Values copied from the reference export; they are OBS's own defaults.
function sourceEnvelope() {
  return {
    mixers: 255,
    sync: 0,
    flags: 0,
    volume: 1.0,
    balance: 0.5,
    enabled: true,
    muted: false,
    "push-to-mute": false,
    "push-to-mute-delay": 0,
    "push-to-talk": false,
    "push-to-talk-delay": 0,
    hotkeys: {},
    deinterlace_mode: 0,
    deinterlace_field_order: 0,
    monitoring_type: 0,
    private_settings: {},
  };
}

// 1080p60 browser source. Settings mirror what the obs-websocket path creates
// (see bridge/obs-controller.js createSceneWithBrowserSource) so a producer
// gets identical sources whichever setup route they took.
function makeBrowserSource(sourceName, url) {
  return {
    prev_ver: OBS_PREV_VER,
    name: sourceName,
    uuid: crypto.randomUUID(),
    id: "browser_source",
    versioned_id: "browser_source",
    settings: {
      url,
      width: 1920,
      height: 1080,
      fps: 60,
      fps_custom: true,
      shutdown: false,
      reroute_audio: false,
    },
    ...sourceEnvelope(),
  };
}

// Scene wrapping exactly one browser source, full-canvas, locked so a stray
// click in OBS can't nudge the overlay off 1:1 pixel alignment.
function makeScene(sceneName, browserSource) {
  return {
    prev_ver: OBS_PREV_VER,
    name: sceneName,
    uuid: crypto.randomUUID(),
    id: "scene",
    versioned_id: "scene",
    settings: {
      custom_size: false,
      id_counter: 1,
      items: [
        {
          name: browserSource.name,
          source_uuid: browserSource.uuid,
          visible: true,
          locked: true,
          rot: 0,
          scale_ref: { x: 1920, y: 1080 },
          align: 5,
          bounds_type: 0,
          bounds_align: 0,
          bounds_crop: false,
          crop_left: 0,
          crop_top: 0,
          crop_right: 0,
          crop_bottom: 0,
          id: 1,
          group_item_backup: false,
          pos: { x: 0, y: 0 },
          // *_rel are OBS 31's canvas-relative coordinates. For a full-frame
          // 1920x1080 source at 0,0 with top-left align, top-left in the 16:9
          // relative space is (-16/9, -1); scale 1:1, no bounds.
          pos_rel: { x: -1.7777777910232544, y: -1 },
          scale: { x: 1, y: 1 },
          scale_rel: { x: 1, y: 1 },
          bounds: { x: 0, y: 0 },
          bounds_rel: { x: 0, y: 0 },
          scale_filter: "disable",
          blend_method: "default",
          blend_type: "normal",
          show_transition: { duration: 0 },
          hide_transition: { duration: 0 },
          private_settings: {},
        },
      ],
    },
    ...sourceEnvelope(),
    canvas_uuid: MAIN_CANVAS_UUID,
  };
}

// OBS requires globally unique source names (scenes are sources too), so
// collisions get " (2)", " (3)", ... suffixes instead of silently clobbering.
function uniqueName(base, taken) {
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base} (${n})`;
  taken.add(name);
  return name;
}

// Build the full scene-collection object (plain data, ready to stringify).
//   overlays: registry entries (bridge/overlay-registry.js shape); the caller
//             pre-filters to approved ones in production.
//   baseUrl:  e.g. "http://localhost:8477"; joined with each entry's url.
// Scene order: gameplay ("RIVALRY - Live") first, then OBS_SCENE_NAMES key
// order, then any unmapped scenes in input order.
function buildSceneCollection({ overlays = [], baseUrl = "", name = "RIVALRY Overlays" } = {}) {
  const keyOrder = Object.keys(OBS_SCENE_NAMES);
  const base = String(baseUrl).replace(/\/+$/, ""); // entry urls start with "/"

  const ordered = overlays
    .map((o, i) => {
      const k = keyOrder.indexOf(o.scene);
      return { o, i, rank: k === -1 ? keyOrder.length : k };
    })
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((r) => r.o);

  const takenSceneNames = new Set();
  const takenSourceNames = new Set();
  const browserSources = [];
  const sceneSources = [];

  for (const o of ordered) {
    const sceneName = uniqueName(OBS_SCENE_NAMES[o.scene] || ("RIVALRY - " + o.name), takenSceneNames);
    const sourceName = uniqueName(o.name + " Overlay", takenSourceNames);
    const src = makeBrowserSource(sourceName, base + o.url);
    browserSources.push(src);
    sceneSources.push(makeScene(sceneName, src));
  }

  const firstScene = sceneSources.length ? sceneSources[0].name : "";

  // Top-level shape and key set copied from the OBS 31.0.1 reference export.
  return {
    name,
    sources: [...browserSources, ...sceneSources],
    groups: [],
    scene_order: sceneSources.map((s) => ({ name: s.name })),
    current_scene: firstScene,
    current_program_scene: firstScene,
    // Empty like the reference export: the main canvas is implicit, scenes
    // reference it by MAIN_CANVAS_UUID rather than declaring it here.
    canvases: [],
    current_transition: "Fade",
    transition_duration: 300,
    transitions: [],
    quick_transitions: [
      { name: "Cut", duration: 300, hotkeys: [], id: 1, fade_to_black: false },
      { name: "Fade", duration: 300, hotkeys: [], id: 2, fade_to_black: false },
      { name: "Fade", duration: 300, hotkeys: [], id: 3, fade_to_black: true },
    ],
    saved_projectors: [],
    preview_locked: false,
    scaling_enabled: false,
    scaling_level: 0,
    scaling_off_x: 0,
    scaling_off_y: 0,
    "virtual-camera": {},
    modules: {},
    version: 2,
  };
}

module.exports = { buildSceneCollection, OBS_SCENE_NAMES };
