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

const { buildSceneCollection, OBS_SCENE_NAMES, CHROME_SCENE_TYPE, CHROME_SOURCE_NAME } = require("../bridge/obs-collection");
const { SAFE_AREA } = require("../bridge/broadcast-geometry");

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

test("every scene item resolves to a real source by uuid AND name", () => {
  const col = build();
  const byUuid = new Map(col.sources.filter((s) => s.id !== "scene").map((s) => [s.uuid, s]));
  const scenes = scenesOf(col);
  assert.equal(scenes.length, fixture().length);
  for (const scene of scenes) {
    for (const item of scene.settings.items) {
      const src = byUuid.get(item.source_uuid);
      assert.ok(src, `item in "${scene.name}" points at a missing source uuid`);
      assert.equal(item.name, src.name, `item/source name mismatch in "${scene.name}"`);
    }
  }
});

test("the gameplay scene ships a game capture under the overlay, scaled to fill", () => {
  const col = build();
  const byUuid = new Map(col.sources.filter((s) => s.id !== "scene").map((s) => [s.uuid, s]));
  const live = scenesOf(col).find((s) => s.name === "RIVALRY - Live");
  assert.ok(live, "expected a RIVALRY - Live scene");
  assert.equal(live.settings.items.length, 2, "overlay + game capture");
  // Array order is back-to-front (OBS appends each loaded item on top, libobs
  // obs-scene.c): capture behind (index 0), overlay on top (1).
  const [bottom, top] = live.settings.items;
  assert.equal(byUuid.get(top.source_uuid).id, "browser_source");
  const cap = byUuid.get(bottom.source_uuid);
  assert.equal(cap.id, "game_capture");
  assert.equal(cap.settings.capture_mode, "any");
  assert.equal(bottom.bounds_type, 2, "scale-to-fit bounds");
  assert.deepEqual(bottom.bounds, { x: 1920, y: 1080 });
  // Non-gameplay scenes stay single-item.
  assert.equal(scenesOf(col).find((s) => s.name === "RIVALRY - Starting Soon").settings.items.length, 1);
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

// libobs pos_to_absolute / size_to_absolute on the 1920x1080 reference: what
// OBS 31 turns *_rel into on load, because it reads them IN PREFERENCE to
// pos/bounds (scene_load_item). A placeholder here lands the item at 0,0, 0x0.
const absPos = (r) => ({ x: (r.x * 1080 + 1920) / 2, y: (r.y * 1080 + 1080) / 2 });
const absSize = (r) => ({ x: (r.x * 1080) / 2, y: (r.y * 1080) / 2 });
const close = (a, b) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;

test("every item's OBS 31 relative coordinates decode to its real position and size", () => {
  const control = { casters: [C("ALEX", "alexcam"), C("SAM", "samcam")] };
  for (const col of [build(), buildSceneCollection({ overlays: fixtureWithChrome(), baseUrl: BASE, control })]) {
    for (const scene of scenesOf(col)) {
      for (const item of scene.settings.items) {
        assert.deepEqual(item.scale_rel, { x: 1, y: 1 });
        assert.deepEqual(item.scale_ref, { x: 1920, y: 1080 });
        assert.ok(close(absPos(item.pos_rel), item.pos), `${scene.name} / ${item.name}: pos_rel ${JSON.stringify(item.pos_rel)} vs pos ${JSON.stringify(item.pos)}`);
        assert.ok(close(absSize(item.bounds_rel), item.bounds), `${scene.name} / ${item.name}: bounds_rel vs bounds`);
      }
    }
  }
});

test("caster cams and the game capture decode to their holes, not 0,0 at 0x0", () => {
  const control = { casters: [C("ALEX", "alexcam"), C("SAM", "samcam")] };
  const col = buildSceneCollection({ overlays: fixtureWithChrome(), baseUrl: BASE, control });
  for (const [n, r] of RECTS["rivalry-casters"][2].entries()) {
    const it = castersScene(col).find((x) => x.src.name === "Caster Cam " + (n + 1)).it;
    assert.ok(close(absPos(it.pos_rel), { x: r.x, y: r.y }));
    assert.ok(close(absSize(it.bounds_rel), { x: r.w, y: r.h }));
  }
  const cap = scenesOf(col).find((s) => s.name === "RIVALRY - Live").settings.items[0];
  assert.ok(close(absSize(cap.bounds_rel), { x: SAFE_AREA.width, y: SAFE_AREA.height }));
  assert.ok(close(absPos(cap.pos_rel), { x: SAFE_AREA.x, y: SAFE_AREA.y }));
  const overlay = scenesOf(col).find((s) => s.name === "RIVALRY - Live").settings.items[1];
  assert.ok(close(overlay.pos_rel, { x: -16 / 9, y: -1 }), "overlays stay at the top-left corner");
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
  const browsers = browsersOf(col).filter((b) => !b.name.startsWith("Caster Cam "));
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
  assert.equal(col.name, "RIVALRY Casterverse");
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

test("one overlay per scene type: same-type overlays collapse instead of suffixing", () => {
  // With overlay sets, two overlays of the same scene type are alternates of
  // one broadcast scene, never two OBS scenes. House set wins by default.
  const overlays = [
    { ...entry({ folder: "gameplay-a", name: "Gameplay A", scene: "gameplay" }), set: "kinetic-bold" },
    { ...entry({ folder: "gameplay-b", name: "Gameplay B", scene: "gameplay" }), set: "sc26" },
  ];
  const col = buildSceneCollection({ overlays, baseUrl: BASE });
  assert.deepEqual(scenesOf(col).map((s) => s.name), ["RIVALRY - Live"]);
  assert.ok(browsersOf(col).some((b) => b.name === "Gameplay A Overlay"), "house set is the default");
  assert.equal(col.current_program_scene, "RIVALRY - Live");
});

test("preferredSet picks that set's overlay, house set fills uncovered scene types", () => {
  const { selectOverlaysForSet, DEFAULT_SET } = require("../bridge/obs-collection");
  assert.equal(DEFAULT_SET, "kinetic-bold");
  const overlays = [
    { ...entry({ folder: "rivalry-brb", name: "RIVALRY BRB", scene: "brb" }), set: "kinetic-bold" },
    { ...entry({ folder: "sc26-brb", name: "SC26 BRB", scene: "brb" }), set: "sc26" },
    { ...entry({ folder: "rivalry-gameplay", name: "RIVALRY Gameplay", scene: "gameplay" }), set: "kinetic-bold" },
  ];
  const chosen = selectOverlaysForSet(overlays, "sc26");
  const byScene = Object.fromEntries(chosen.map((o) => [o.scene, o.folder]));
  assert.equal(byScene.brb, "sc26-brb", "preferred set covers brb");
  assert.equal(byScene.gameplay, "rivalry-gameplay", "sc26 has no gameplay: house set fills it");
  // And the built collection agrees.
  const col = buildSceneCollection({ overlays, baseUrl: BASE, preferredSet: "sc26" });
  assert.ok(browsersOf(col).some((b) => b.name === "SC26 BRB Overlay"));
  assert.ok(browsersOf(col).some((b) => b.name === "RIVALRY Gameplay Overlay"));
});

test("a missing set field reads as the house set", () => {
  const { selectOverlaysForSet } = require("../bridge/obs-collection");
  const legacy = entry({ folder: "rivalry-brb", name: "RIVALRY BRB", scene: "brb" }); // no .set
  const chosen = selectOverlaysForSet([legacy], "sc26");
  assert.equal(chosen.length, 1, "legacy entries without a set still serve as fallback");
});

test("opaque scenes never get the chrome pinned on top", () => {
  const overlays = [
    entry({ folder: "rivalry-chrome", name: "Chrome (persistent frame)", scene: "chrome" }),
    entry({ folder: "rivalry-gameplay", name: "RIVALRY Gameplay", scene: "gameplay" }),
    { ...entry({ folder: "sc26-brb", name: "SC26 BRB", scene: "brb" }), set: "sc26", opaque: true },
  ];
  const col = buildSceneCollection({ overlays, baseUrl: BASE, preferredSet: "sc26" });
  const chromeSrc = browsersOf(col).find((b) => b.name === CHROME_SOURCE_NAME);
  const live = scenesOf(col).find((s) => s.name === "RIVALRY - Live");
  assert.equal(live.settings.items.at(-1).source_uuid, chromeSrc.uuid, "transparent scene keeps the chrome");
  const brb = scenesOf(col).find((s) => s.name === "RIVALRY - BRB");
  assert.ok(
    !brb.settings.items.some((i) => i.source_uuid === chromeSrc.uuid),
    "opaque scene must not composite the house frame over its own art"
  );
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

test("OBS_SCENE_NAMES covers the 7 switchable broadcast scenes, Starting Soon first, no bracket", () => {
  const keys = Object.keys(OBS_SCENE_NAMES);
  assert.equal(keys.length, 7);
  assert.equal(keys[0], "starting-soon");
  assert.equal(OBS_SCENE_NAMES["gameplay"], "RIVALRY - Live");
  assert.ok(!("bracket" in OBS_SCENE_NAMES), "bracket is removed until playoffs");
  // The chrome is deliberately NOT in the map: it is a layered source in every
  // scene, never a scene of its own.
  assert.ok(!(CHROME_SCENE_TYPE in OBS_SCENE_NAMES), "chrome must not become a switchable scene");
});

// ---------------------------------------------------------------------------
// The chrome: one shared source pinned on top of every scene
// ---------------------------------------------------------------------------

function fixtureWithChrome() {
  return [
    ...fixture(),
    entry({ folder: "rivalry-chrome", name: "Chrome (persistent frame)", scene: "chrome" }),
  ];
}

test("chrome never becomes a scene; every scene gets it as the TOP item", () => {
  const col = buildSceneCollection({ overlays: fixtureWithChrome(), baseUrl: BASE });
  const scenes = scenesOf(col);
  assert.equal(scenes.length, fixture().length, "chrome must not add a scene");
  assert.ok(!scenes.some((s) => /chrome/i.test(s.name)), "no chrome-named scene");
  const chromeSrc = browsersOf(col).find((b) => b.name === CHROME_SOURCE_NAME);
  assert.ok(chromeSrc, "one shared chrome browser source");
  for (const scene of scenes) {
    const top = scene.settings.items.at(-1); // the last item renders in front
    assert.equal(top.source_uuid, chromeSrc.uuid, `chrome not on top of "${scene.name}"`);
    assert.equal(top.locked, true);
    assert.equal(top.bounds_type, 0, "chrome is authored at canvas size, no bounds scaling");
  }
  // Exactly one chrome SOURCE exists even though every scene references it.
  assert.equal(browsersOf(col).filter((b) => b.name === CHROME_SOURCE_NAME).length, 1);
});

test("with the chrome present, the game capture scales into the safe area", () => {
  const col = buildSceneCollection({ overlays: fixtureWithChrome(), baseUrl: BASE });
  const byUuid = new Map(col.sources.filter((s) => s.id !== "scene").map((s) => [s.uuid, s]));
  const live = scenesOf(col).find((s) => s.name === "RIVALRY - Live");
  assert.equal(live.settings.items.length, 3, "capture + overlay + chrome");
  const capItem = live.settings.items[0];
  assert.equal(byUuid.get(capItem.source_uuid).id, "game_capture");
  assert.equal(capItem.bounds_type, 2);
  assert.deepEqual(capItem.bounds, { x: SAFE_AREA.width, y: SAFE_AREA.height });
  assert.deepEqual(capItem.pos, { x: SAFE_AREA.x, y: SAFE_AREA.y });
  // Non-gameplay scenes: chrome + overlay only.
  const brb = scenesOf(col).find((s) => s.name === "RIVALRY - BRB");
  assert.equal(brb.settings.items.length, 2);
});

test("dark-launched scene types never reach the producer's collection", () => {
  const { DARK_SCENE_TYPES } = require("../bridge/obs-collection");
  assert.ok(DARK_SCENE_TYPES.has("standings"), "standings is dark until the league API ships");
  const overlays = [
    ...fixtureWithChrome(),
    entry({ folder: "rivalry-standings", name: "Standings", scene: "standings" }),
  ];
  const col = buildSceneCollection({ overlays, baseUrl: BASE });
  assert.equal(scenesOf(col).length, fixture().length, "standings must not add a scene");
  assert.ok(!scenesOf(col).some((s) => /standings/i.test(s.name)));
  assert.ok(!browsersOf(col).some((b) => /standings/i.test(b.name)), "no orphan standings source either");
});

test("without a chrome overlay the collection keeps the pre-chrome shape", () => {
  const col = build();
  const live = scenesOf(col).find((s) => s.name === "RIVALRY - Live");
  assert.equal(live.settings.items.length, 2, "overlay + capture, no chrome");
  assert.deepEqual(live.settings.items[0].bounds, { x: 1920, y: 1080 }, "capture fills the canvas");
  assert.ok(!browsersOf(col).some((b) => b.name === CHROME_SOURCE_NAME));
});

// ---------------------------------------------------------------------------
// Caster cams in the importable collection
// ---------------------------------------------------------------------------

const { RECTS } = require("../overlays/shared/rivalry-caster-cams");
const C = (name, stream = "") => ({ name, role: "", handle: "", stream, avatar: "" });

function castersScene(col) {
  const byUuid = new Map(col.sources.filter((s) => s.id !== "scene").map((s) => [s.uuid, s]));
  const scene = scenesOf(col).find((s) => s.name === "RIVALRY - Casters");
  return scene.settings.items.map((it) => ({ it, src: byUuid.get(it.source_uuid) }));
}

test("the Casters scene ships a cam per caster under the overlay, in its holes", () => {
  const control = { casters: [C("ALEX", "alexcam"), C("SAM", "https://vdo.ninja/?view=sam")] };
  const col = buildSceneCollection({ overlays: fixtureWithChrome(), baseUrl: BASE, control });
  const items = castersScene(col);
  const names = items.map((x) => x.src.name);
  assert.deepEqual(names, ["Caster Cam 1", "Caster Cam 2", "RIVALRY Casters Overlay", CHROME_SOURCE_NAME], "cams at the back, chrome in front");
  for (const n of [0, 1]) {
    const { it, src } = items[n];
    const r = RECTS["rivalry-casters"][2][n];
    assert.deepEqual(it.pos, { x: r.x, y: r.y });
    assert.deepEqual(it.bounds, { x: r.w, y: r.h });
    assert.equal(it.bounds_type, 2);
    assert.equal(it.visible, true);
    assert.equal(src.settings.shutdown, false);
  }
  assert.equal(items[0].src.settings.url, "https://vdo.ninja/?view=alexcam&cleanoutput&autostart");
  assert.equal(items[1].src.settings.url, "https://vdo.ninja/?view=sam");
});

test("one cam picked: a single cam in the solo hole", () => {
  const control = { casterCams: 1, casters: [C("ALEX", "deskcam"), C("SAM")] };
  const items = castersScene(buildSceneCollection({ overlays: fixture(), baseUrl: BASE, control }));
  const cams = items.filter((x) => x.src.name.startsWith("Caster Cam "));
  assert.equal(cams.length, 1);
  assert.deepEqual(cams[0].it.bounds, { x: RECTS["rivalry-casters"][1][0].w, y: RECTS["rivalry-casters"][1][0].h });
});

test("cams with no feed yet are placed but hidden, ready for a link", () => {
  const items = castersScene(build()); // no control state at all: the designed two-cam look
  const cams = items.filter((x) => x.src.name.startsWith("Caster Cam "));
  assert.equal(cams.length, 2);
  assert.ok(cams.every((x) => x.it.visible === false && x.src.settings.url === ""));
});

test("a casters overlay without known cam geometry gets no cams", () => {
  const overlays = [entry({ folder: "community-casters", name: "Community Casters", scene: "caster" })];
  const col = buildSceneCollection({ overlays, baseUrl: BASE, control: { casters: [C("A", "a")] } });
  assert.ok(!browsersOf(col).some((b) => b.name.startsWith("Caster Cam ")));
});

test("the SC26 casters overlay gets its own hole geometry", () => {
  const overlays = [{ ...entry({ folder: "rivalry-sc26-casters", name: "SC26 Casters", scene: "caster" }), set: "sc26", opaque: true }];
  const control = { casters: [C("A", "a"), C("B", "b"), C("C", "c")] };
  const items = castersScene(buildSceneCollection({ overlays, baseUrl: BASE, preferredSet: "sc26", control }));
  const cams = items.filter((x) => x.src.name.startsWith("Caster Cam "));
  assert.deepEqual(cams.map((x) => x.it.pos), RECTS["rivalry-sc26-casters"][3].map((r) => ({ x: r.x, y: r.y })));
});

test("a caster sharing a cam rides a hidden spare source, so they are still heard", () => {
  const control = { casterCams: 1, casters: [C("ALEX", "alexcam"), C("SAM", "samcam")] };
  const items = castersScene(buildSceneCollection({ overlays: fixture(), baseUrl: BASE, control }));
  const spare = items.find((x) => x.src.name === "Caster Cam 2");
  assert.ok(spare, "SAM's feed is in the collection");
  assert.equal(spare.it.visible, false);
  assert.equal(spare.src.settings.url, "https://vdo.ninja/?view=samcam&cleanoutput&autostart");
});
