/* =============================================================================
 * Tests for bridge/obs-collection.js (run: node --test tests/)
 * -----------------------------------------------------------------------------
 * The generated file is imported straight into a producer's OBS, so the
 * assertions here focus on what would actually break an import: dangling
 * source_uuid references, duplicate names, wrong scene order, and settings
 * drift from the obs-websocket setup path.
 * ===========================================================================*/

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildSceneCollection, OBS_SCENE_NAMES } = require("../bridge/obs-collection");

const BASE = "http://localhost:8477";

// Registry-entry-shaped fixture (bridge/overlay-registry.js scanOverlays).
function entry({ folder, name, scene }) {
  return {
    folder,
    id: folder,
    name,
    scene,
    needs: [],
    version: "1.0.0",
    entry: "index.html",
    approved: true,
    reason: "signature ok",
    keyId: "rivalry-2026",
    url: `/overlays/${folder}/index.html`,
  };
}

// Deliberately out of broadcast order, with one unmapped scene ("freestyle"),
// so the ordering and fallback-naming rules actually get exercised.
function fixture() {
  return [
    entry({ folder: "rivalry-casters", name: "RIVALRY Casters", scene: "caster" }),
    entry({ folder: "rivalry-brb", name: "RIVALRY BRB", scene: "brb" }),
    entry({ folder: "community-freestyle", name: "Freestyle Cam", scene: "freestyle" }),
    entry({ folder: "rivalry-gameplay", name: "RIVALRY Gameplay", scene: "gameplay" }),
    entry({ folder: "rivalry-starting-soon", name: "RIVALRY Starting Soon", scene: "starting-soon" }),
  ];
}

function build() {
  return buildSceneCollection({ overlays: fixture(), baseUrl: BASE });
}

function scenesOf(col) {
  return col.sources.filter((s) => s.id === "scene");
}

function browsersOf(col) {
  return col.sources.filter((s) => s.id === "browser_source");
}

test("every scene item resolves to a real browser source by uuid AND name", () => {
  const col = build();
  const byUuid = new Map(browsersOf(col).map((s) => [s.uuid, s]));
  const scenes = scenesOf(col);
  assert.equal(scenes.length, fixture().length);
  for (const scene of scenes) {
    assert.equal(scene.settings.items.length, 1);
    for (const item of scene.settings.items) {
      const src = byUuid.get(item.source_uuid);
      assert.ok(src, `item in "${scene.name}" points at a missing source uuid`);
      assert.equal(item.name, src.name, `item/source name mismatch in "${scene.name}"`);
    }
  }
});

test("scene names are unique", () => {
  const names = scenesOf(build()).map((s) => s.name);
  assert.equal(new Set(names).size, names.length);
});

// Regression: without canvas_uuid on each scene, OBS 31 imports an empty
// collection (name only). This is the exact bug that shipped in beta.36.
test("every scene carries the main-canvas uuid so OBS does not drop it", () => {
  const col = build();
  const MAIN = "6c69626f-6273-4c00-9d88-c5136d61696e";
  assert.deepEqual(col.canvases, []);
  for (const scene of scenesOf(col)) {
    assert.equal(scene.canvas_uuid, MAIN, `scene "${scene.name}" is missing canvas_uuid`);
  }
  // Browser sources are placed via their scene item, not the canvas directly.
  for (const b of browsersOf(col)) {
    assert.ok(!("canvas_uuid" in b), "browser sources must not carry canvas_uuid");
  }
});

test("scene items carry OBS 31 canvas-relative coordinates", () => {
  for (const scene of scenesOf(build())) {
    const item = scene.settings.items[0];
    assert.deepEqual(item.pos_rel, { x: -1.7777777910232544, y: -1 });
    assert.deepEqual(item.scale_rel, { x: 1, y: 1 });
    assert.deepEqual(item.bounds_rel, { x: 0, y: 0 });
  }
});

test("the first scene in broadcast order is the current program scene", () => {
  const col = build();
  // Starting Soon is first in the scene map, so a broadcast opens on it.
  assert.equal(col.scene_order[0].name, "RIVALRY - Starting Soon");
  assert.equal(col.current_scene, "RIVALRY - Starting Soon");
  assert.equal(col.current_program_scene, "RIVALRY - Starting Soon");
});

test("scene order follows OBS_SCENE_NAMES key order, unmapped scenes last", () => {
  const col = build();
  assert.deepEqual(
    col.scene_order.map((s) => s.name),
    ["RIVALRY - Starting Soon", "RIVALRY - Casters", "RIVALRY - Live", "RIVALRY - BRB", "RIVALRY - Freestyle Cam"]
  );
});

test("browser sources carry 1080p60 settings and baseUrl-joined urls", () => {
  const col = build();
  const browsers = browsersOf(col);
  assert.equal(browsers.length, fixture().length);
  for (const b of browsers) {
    assert.equal(b.settings.width, 1920);
    assert.equal(b.settings.height, 1080);
    assert.equal(b.settings.fps, 60);
    assert.equal(b.settings.fps_custom, true);
    assert.equal(b.settings.shutdown, false);
    assert.equal(b.settings.reroute_audio, false);
  }
  const gameplay = browsers.find((b) => b.name === "RIVALRY Gameplay Overlay");
  assert.ok(gameplay);
  assert.equal(gameplay.settings.url, `${BASE}/overlays/rivalry-gameplay/index.html`);
});

test("trailing slash on baseUrl does not double up the url", () => {
  const col = buildSceneCollection({ overlays: fixture(), baseUrl: BASE + "/" });
  for (const b of browsersOf(col)) {
    assert.doesNotMatch(b.settings.url, /\/\/overlays\//);
  }
});

test("collection survives a JSON stringify/parse round-trip", () => {
  const col = build();
  assert.deepEqual(JSON.parse(JSON.stringify(col)), col);
});

test("empty overlays input yields a valid zero-scene collection", () => {
  const col = buildSceneCollection({ overlays: [], baseUrl: BASE });
  assert.equal(col.name, "RIVALRY Overlays");
  assert.deepEqual(col.sources, []);
  assert.deepEqual(col.groups, []);
  assert.deepEqual(col.scene_order, []);
  assert.equal(col.current_scene, "");
  assert.equal(col.current_program_scene, "");
  assert.equal(col.current_transition, "Fade");
  assert.equal(col.transition_duration, 300);
  assert.deepEqual(col.transitions, []);
  assert.equal(col.quick_transitions.length, 3);
  assert.deepEqual(col.saved_projectors, []);
  assert.equal(col.preview_locked, false);
  assert.equal(col.scaling_enabled, false);
  assert.deepEqual(col["virtual-camera"], {});
  assert.deepEqual(col.modules, {});
  assert.equal(col.version, 2);
});

test("custom collection name is honored", () => {
  const col = buildSceneCollection({ overlays: [], baseUrl: BASE, name: "Summer Circuit" });
  assert.equal(col.name, "Summer Circuit");
});

test("duplicate scene mappings get numeric suffixes, first keeps the clean name", () => {
  const overlays = [
    entry({ folder: "gameplay-a", name: "Gameplay A", scene: "gameplay" }),
    entry({ folder: "gameplay-b", name: "Gameplay B", scene: "gameplay" }),
    entry({ folder: "gameplay-c", name: "Gameplay C", scene: "gameplay" }),
  ];
  const col = buildSceneCollection({ overlays, baseUrl: BASE });
  assert.deepEqual(
    scenesOf(col).map((s) => s.name),
    ["RIVALRY - Live", "RIVALRY - Live (2)", "RIVALRY - Live (3)"]
  );
  assert.deepEqual(
    col.scene_order.map((s) => s.name),
    ["RIVALRY - Live", "RIVALRY - Live (2)", "RIVALRY - Live (3)"]
  );
  assert.equal(col.current_program_scene, "RIVALRY - Live");
});

test("duplicate overlay names get suffixed source names that scene items still resolve", () => {
  const overlays = [
    entry({ folder: "brb-red", name: "BRB", scene: "brb" }),
    entry({ folder: "brb-blue", name: "BRB", scene: "custom-brb" }),
  ];
  const col = buildSceneCollection({ overlays, baseUrl: BASE });
  const names = browsersOf(col).map((b) => b.name);
  assert.deepEqual(names, ["BRB Overlay", "BRB Overlay (2)"]);
  const byUuid = new Map(browsersOf(col).map((s) => [s.uuid, s]));
  for (const scene of scenesOf(col)) {
    const item = scene.settings.items[0];
    assert.equal(byUuid.get(item.source_uuid).name, item.name);
  }
});

test("OBS_SCENE_NAMES covers the 7 active broadcast scenes, Starting Soon first, no bracket", () => {
  const keys = Object.keys(OBS_SCENE_NAMES);
  assert.equal(keys.length, 7);
  assert.equal(keys[0], "starting-soon");
  assert.equal(OBS_SCENE_NAMES["gameplay"], "RIVALRY - Live");
  assert.ok(!("bracket" in OBS_SCENE_NAMES), "bracket is removed until playoffs");
});
