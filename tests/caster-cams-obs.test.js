/* =============================================================================
 * Caster cams in OBS (bridge/caster-cams.js), against an in-memory OBS
 * -----------------------------------------------------------------------------
 * The fake models what the module relies on: global inputs, per-scene items
 * in render order (index 0 = bottom, as in obs-websocket), and the handful of
 * v5 requests it sends. Unknown requests throw so a new call can't slip past.
 * ===========================================================================*/

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createCasterCamSync, overlayFromUrl, planCasterCams, overlayPlacement, feedKey, CAM_INPUT_SETTINGS } = require("../bridge/caster-cams");
const { RECTS } = require("../overlays/shared/rivalry-caster-cams");

const SCENE = "RIVALRY - Casters";
const CLASSIC = "http://localhost:49080/overlays/rivalry-casters/index.html";
const SC26 = "http://localhost:49080/overlays/rivalry-sc26-casters/index.html";

function fakeObs() {
  const inputs = new Map(); // name -> { kind, settings, sets }
  const scenes = new Map(); // name -> [{ sceneItemId, sourceName, enabled, transform }], bottom first
  let nextId = 1;
  const writes = [];
  const sceneOf = (name) => {
    const s = scenes.get(name);
    if (!s) throw new Error(`No source was found by the name of \`${name}\`.`);
    return s;
  };
  const itemOf = (d) => sceneOf(d.sceneName).find((x) => x.sceneItemId === d.sceneItemId);
  async function call(type, d = {}) {
    if (!/^Get/.test(type)) writes.push([type, d.inputName || d.sourceName || (itemOf(d) || {}).sourceName]);
    switch (type) {
      case "GetSceneItemList":
      case "GetGroupSceneItemList":
        return { sceneItems: sceneOf(d.sceneName).map((it, i) => ({
          sceneItemId: it.sceneItemId, sceneItemIndex: i, sourceName: it.sourceName,
          inputKind: (inputs.get(it.sourceName) || {}).kind, isGroup: inputs.has(it.sourceName) ? null : !!it.isGroup,
          sceneItemEnabled: it.enabled })) };
      case "GetInputList":
        return { inputs: [...inputs].filter(([, v]) => !d.inputKind || v.kind === d.inputKind).map(([inputName, v]) => ({ inputName, inputKind: v.kind })) };
      case "GetInputSettings": {
        const inp = inputs.get(d.inputName);
        if (!inp) throw new Error("No input " + d.inputName);
        return { inputKind: inp.kind, inputSettings: { ...inp.settings } };
      }
      case "SetInputSettings":
        Object.assign(inputs.get(d.inputName).settings, d.inputSettings);
        return {};
      case "CreateInput": {
        if (inputs.has(d.inputName)) throw new Error("A source already exists by that input name.");
        inputs.set(d.inputName, { kind: d.inputKind, settings: { ...d.inputSettings } });
        const it = { sceneItemId: nextId++, sourceName: d.inputName, enabled: d.sceneItemEnabled !== false, transform: {} };
        sceneOf(d.sceneName).push(it);
        return { sceneItemId: it.sceneItemId };
      }
      case "CreateSceneItem": {
        const it = { sceneItemId: nextId++, sourceName: d.sourceName, enabled: d.sceneItemEnabled !== false, transform: {} };
        sceneOf(d.sceneName).push(it);
        return { sceneItemId: it.sceneItemId };
      }
      case "SetSceneItemIndex": {
        const s = sceneOf(d.sceneName);
        const [it] = s.splice(s.findIndex((x) => x.sceneItemId === d.sceneItemId), 1);
        s.splice(d.sceneItemIndex, 0, it);
        return {};
      }
      case "SetSceneItemTransform":
        Object.assign(itemOf(d).transform, d.sceneItemTransform);
        return {};
      case "GetSceneItemTransform":
        // An untouched 1920x1080 browser source at the canvas origin, plus
        // whatever the test set on the item.
        return { sceneItemTransform: { positionX: 0, positionY: 0, rotation: 0, scaleX: 1, scaleY: 1, alignment: 5,
          boundsType: "OBS_BOUNDS_NONE", boundsAlignment: 0, boundsWidth: 0, boundsHeight: 0, sourceWidth: 1920, sourceHeight: 1080,
          cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0, ...itemOf(d).transform } };
      case "SetSceneItemEnabled":
        itemOf(d).enabled = d.sceneItemEnabled;
        return {};
      default:
        throw new Error("unexpected request " + type);
    }
  }
  // A source with `scene: [...]` is a nested scene, with `group: [...]` a group.
  function addScene(name, sources) {
    scenes.set(name, []);
    for (const s of sources) {
      const inner = s.scene || s.group;
      if (inner) addScene(s.name, inner);
      else if (!inputs.has(s.name)) inputs.set(s.name, { kind: s.kind || "browser_source", settings: { url: s.url || "" } });
      scenes.get(name).push({ sceneItemId: nextId++, sourceName: s.name, enabled: s.enabled !== false, transform: {}, isGroup: !!s.group });
    }
  }
  function view(name = SCENE) {
    return sceneOf(name).map((it, index) => ({ index, name: it.sourceName, enabled: it.enabled, url: inputs.get(it.sourceName).settings.url, t: it.transform }));
  }
  return { call, inputs, scenes, writes, addScene, view };
}

function setup({ overlayUrl = CLASSIC, extra = [], latency = 0, ...opts } = {}) {
  const obs = fakeObs();
  obs.addScene(SCENE, [{ name: "Casters Overlay", url: overlayUrl }, ...extra]);
  let control = {};
  const results = [];
  const call = latency ? (t, d) => new Promise((r) => setTimeout(r, latency)).then(() => obs.call(t, d)) : obs.call;
  const sync = createCasterCamSync({
    call, isConnected: () => true, getControl: () => control, sceneName: SCENE,
    onResult: (r) => results.push(r), debounceMs: 5, ...opts,
  });
  return { obs, sync, results, set(c) { control = c; } };
}

const caster = (name, stream = "") => ({ name, role: "", handle: "", stream, avatar: "" });
const cam = (v, n) => v.find((x) => x.name === "Caster Cam " + n);
const rectOf = (t) => ({ x: t.positionX, y: t.positionY, w: t.boundsWidth, h: t.boundsHeight });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const vdo = (id) => `https://vdo.ninja/?view=${id}&cleanoutput&autostart`;

test("two casters: two cams created under the overlay, in the duo holes, live", async () => {
  const { obs, sync, set } = setup();
  set({ casters: [caster("ALEX", "alexcam"), caster("SAM", "https://vdo.ninja/?room=r&view=sam")] });
  const r = await sync.syncNow();
  assert.deepEqual(r, { ok: true, scene: SCENE, overlay: "rivalry-casters", followed: true, frames: 2, names: ["ALEX", "SAM"], live: 2, hidden: [],
    waiting: [], noCaster: [], heardOnly: [], held: [], dupes: [], repeats: [], badLinks: [], clashes: [], unplaced: [] });
  const v = obs.view();
  const overlay = v.find((x) => x.name === "Casters Overlay");
  for (const n of [1, 2]) {
    const c = cam(v, n);
    assert.ok(c.index < overlay.index, `cam ${n} sits under the overlay`);
    assert.equal(c.enabled, true);
    assert.deepEqual(rectOf(c.t), RECTS["rivalry-casters"][2][n - 1]);
    assert.equal(c.t.boundsType, "OBS_BOUNDS_SCALE_INNER");
  }
  assert.equal(cam(v, 1).url, vdo("alexcam"));
  assert.equal(cam(v, 2).url, "https://vdo.ninja/?room=r&view=sam");
  assert.equal(cam(v, 3), undefined, "no source for a cam that loads nothing");
  const settings = obs.inputs.get("Caster Cam 1").settings;
  for (const [k, val] of Object.entries(CAM_INPUT_SETTINGS)) assert.equal(settings[k], val, k);
});

test("one cam picked for two remote casters: one frame, and the other caster is still heard", async () => {
  const { obs, sync, set } = setup();
  set({ casters: [caster("ALEX", "alexcam"), caster("SAM", "samcam")] });
  await sync.syncNow();
  set({ casterCams: 1, casters: [caster("ALEX", "alexcam"), caster("SAM", "samcam")] });
  const r = await sync.syncNow();
  assert.equal(r.frames, 1);
  assert.deepEqual(r.heardOnly, ["SAM"]);
  const v = obs.view();
  assert.deepEqual(rectOf(cam(v, 1).t), RECTS["rivalry-casters"][1][0]);
  assert.equal(cam(v, 1).enabled, true);
  assert.equal(cam(v, 2).enabled, false, "not shown");
  assert.equal(cam(v, 2).url, vdo("samcam"), "but still loaded, so SAM's mic stays on air");
});

test("two casters at one desk sharing one feed: one cam, nothing extra loaded", async () => {
  const { obs, sync, set } = setup();
  set({ casterCams: 1, casters: [caster("ALEX"), caster("SAM", "deskcam")] });
  const r = await sync.syncNow();
  assert.deepEqual(r.heardOnly, []);
  const v = obs.view();
  assert.equal(cam(v, 1).url, vdo("deskcam"));
  assert.equal(cam(v, 2), undefined);
});

test("auto with one caster: the classic look keeps its two frames, the SC26 look shows one", async () => {
  const classic = setup();
  classic.set({ casters: [caster("ALEX", "alexcam")] });
  const r = await classic.sync.syncNow();
  assert.equal(r.frames, 2);
  assert.deepEqual(r.noCaster, [2], "the second frame has nobody in it");
  assert.deepEqual(r.waiting, []);
  assert.deepEqual(rectOf(cam(classic.obs.view(), 1).t), RECTS["rivalry-casters"][2][0]);
  const sc26 = setup({ overlayUrl: SC26 });
  sc26.set({ casters: [caster("ALEX", "alexcam")] });
  assert.equal((await sc26.sync.syncNow()).frames, 1);
  assert.deepEqual(rectOf(cam(sc26.obs.view(), 1).t), RECTS["rivalry-sc26-casters"][1][0]);
});

test("a third caster adds a cam; a caster without a feed is dark", async () => {
  const { obs, sync, set } = setup();
  set({ casters: [caster("A", "a"), caster("B", "b")] });
  await sync.syncNow();
  set({ casters: [caster("A", "a"), caster("B", ""), caster("C", "c")] });
  await sync.syncNow();
  const v = obs.view();
  for (const n of [1, 3]) assert.deepEqual(rectOf(cam(v, n).t), RECTS["rivalry-casters"][3][n - 1]);
  assert.equal(cam(v, 2).enabled, false);
  assert.equal(cam(v, 3).enabled, true);
  assert.ok(cam(v, 3).index < v.find((x) => x.name === "Casters Overlay").index);
});

test("the SC26 look's holes are used when its overlay is in the scene", async () => {
  const { obs, sync, set } = setup({ overlayUrl: SC26 });
  set({ casters: [caster("A", "a"), caster("B", "b"), caster("C", "c")] });
  const r = await sync.syncNow();
  assert.equal(r.overlay, "rivalry-sc26-casters");
  const v = obs.view();
  for (const n of [1, 2, 3]) assert.deepEqual(rectOf(cam(v, n).t), RECTS["rivalry-sc26-casters"][3][n - 1]);
});

test("after a look change the cams follow the topmost visible overlay", async () => {
  // A rebuild stacks the new look's overlay over the old one.
  const { obs, sync, set } = setup({ extra: [{ name: "SC26 Casters Overlay", url: SC26 }] });
  set({ casters: [caster("A", "a"), caster("B", "b")] });
  assert.equal((await sync.syncNow()).overlay, "rivalry-sc26-casters");
  assert.deepEqual(rectOf(cam(obs.view(), 1).t), RECTS["rivalry-sc26-casters"][2][0]);
  // Hide the new one with the eye icon: the visible classic overlay rules again.
  obs.scenes.get(SCENE).find((x) => x.sourceName === "SC26 Casters Overlay").enabled = false;
  assert.equal((await sync.syncNow()).overlay, "rivalry-casters");
  assert.deepEqual(rectOf(cam(obs.view(), 1).t), RECTS["rivalry-casters"][2][0]);
});

test("?layout=solo on the classic overlay URL pins one cam", async () => {
  const { obs, sync, set } = setup({ overlayUrl: CLASSIC + "?layout=solo" });
  set({ casters: [caster("A", "a"), caster("B", "b")] });
  await sync.syncNow();
  const v = obs.view();
  assert.deepEqual(rectOf(cam(v, 1).t), RECTS["rivalry-casters"][1][0]);
  assert.equal(cam(v, 2).enabled, false, "B is heard, not shown");
});

test("a feed the producer's own source in the Casters scene plays is never loaded twice", async () => {
  // Cams added by hand before the app managed them, with their own extra
  // parameters, an old-domain link, and a name that only starts like the app's.
  const { obs, sync, set } = setup({ extra: [
    { name: "Alex cam", url: "https://vdo.ninja/?view=ALEXCAM&room=x" },
    { name: "Caster Cam - Sam", url: "https://obs.ninja/?view=samcam" },
  ] });
  set({ casters: [caster("ALEX", "alexcam"), caster("SAM", "obs.ninja/?view=samcam")] });
  const r = await sync.syncNow();
  assert.deepEqual(r.dupes, [{ cam: 1, name: "ALEX", source: "Alex cam" }, { cam: 2, name: "SAM", source: "Caster Cam - Sam" }]);
  assert.equal(r.live, 0);
  assert.ok(!obs.inputs.has("Caster Cam 1") && !obs.inputs.has("Caster Cam 2"), "no second copy of either feed");
  assert.equal(feedKey("https://vdo.ninja/?view=X&cleanoutput"), feedKey("https://obs.ninja/?view=x"));
  // Deleted from the scene: the app's cam takes over on the next sync.
  const items = obs.scenes.get(SCENE);
  items.splice(items.findIndex((x) => x.sourceName === "Alex cam"), 1);
  assert.equal((await sync.syncNow()).live, 1);
  assert.equal(cam(obs.view(), 1).url, vdo("alexcam"));
});

test("a copy of a feed in another scene leaves the Casters cam alone", async () => {
  const { obs, sync, set } = setup();
  obs.addScene("Interview", [{ name: "Alex fullscreen", url: vdo("alexcam") }]);
  set({ casters: [caster("ALEX", "alexcam"), caster("SAM", "samcam")] });
  const r = await sync.syncNow();
  assert.deepEqual(r.dupes, []);
  assert.equal(r.live, 2);
  assert.equal(cam(obs.view(), 1).enabled, true);
});

test("a caster's name blanked to retype it: no cam reloads a feed, and the name comes back instantly", async () => {
  const { obs, sync, set } = setup({ graceMs: 5000 });
  const full = { casters: [caster("A", "a"), caster("B", "b"), caster("C", "c")] };
  set(full);
  await sync.syncNow();
  const before = obs.writes.length;
  // The panel drops a row with no name, so B and C move up a hole.
  set({ casters: [caster("B", "b"), caster("C", "c")] });
  await sync.syncNow();
  let v = obs.view();
  const shows = (n) => v.find((x) => x.enabled && x.t.positionX === RECTS["rivalry-casters"][2][n - 1].x);
  assert.equal(shows(1).url, vdo("b"), "B's own source moved into the first hole");
  assert.equal(shows(2).url, vdo("c"));
  assert.equal(v.filter((x) => x.url === vdo("b")).length, 1, "B is loaded once");
  assert.ok(v.some((x) => !x.enabled && x.url === vdo("a")), "A's feed held, hidden, for the retype");
  set(full);
  await sync.syncNow();
  v = obs.view();
  assert.ok(!obs.writes.slice(before).some(([t]) => t === "SetInputSettings"), "no feed reloaded at any point");
  for (const [n, id] of [[1, "a"], [2, "b"], [3, "c"]]) {
    assert.equal(v.find((x) => x.url === vdo(id)).t.positionX, RECTS["rivalry-casters"][3][n - 1].x);
  }
});

test("clearing a named caster's link cuts their feed at once", async () => {
  const { obs, sync, set } = setup({ graceMs: 5000 });
  set({ casterCams: 1, casters: [caster("A", "a"), caster("B", "b")] });
  await sync.syncNow();
  assert.equal(cam(obs.view(), 2).url, vdo("b"), "B heard on the spare");
  set({ casterCams: 1, casters: [caster("A", "a"), caster("B", "")] });
  await sync.syncNow();
  assert.equal(cam(obs.view(), 2).url, "", "no grace for a link the producer cleared");
  set({ casterCams: 1, casters: [caster("A", "a2"), caster("B", "")] });
  await sync.syncNow();
  assert.ok(!obs.view().some((x) => x.url === vdo("a")), "a changed link replaces the old feed outright");
});

test("only Caster Cam 1-3 browser sources are the app's: a webcam by that name is left alone", async () => {
  const { obs, sync, set } = setup({ extra: [{ name: "Caster Cam 1", kind: "dshow_input" }] });
  set({ casters: [caster("A", "a"), caster("B", "b")] });
  const r = await sync.syncNow();
  assert.deepEqual(r.clashes, ["Caster Cam 1"]);
  assert.ok(obs.writes.every(([, target]) => target !== "Caster Cam 1"), "the webcam is not touched");
  assert.equal(r.live, 2, "the other two sources carry both cams");
  const v = obs.view();
  assert.deepEqual([cam(v, 2).url, cam(v, 3).url], [vdo("a"), vdo("b")]);
});

test("one feed is never loaded twice by the app either (ID and link for the same desk)", async () => {
  const { obs, sync, set } = setup();
  set({ casterCams: 1, casters: [caster("A", "deskcam"), caster("B", "vdo.ninja/?view=DeskCam")] });
  let r = await sync.syncNow();
  assert.deepEqual(r.heardOnly, []);
  assert.equal(obs.view().filter((x) => /^Caster Cam/.test(x.name) && x.url).length, 1);
  set({ casters: [caster("A", "deskcam"), caster("B", "vdo.ninja/?view=deskcam&cleanoutput")] });
  r = await sync.syncNow();
  assert.deepEqual(r.repeats, [{ cam: 2, of: 1 }]);
  assert.equal(r.live, 1);
  assert.equal(obs.view().filter((x) => /^Caster Cam/.test(x.name) && x.url).length, 1);
});

test("a link that is not VDO.Ninja is reported, and a shared cam shows the next caster's feed", async () => {
  const { obs, sync, set } = setup();
  set({ casterCams: 1, casters: [caster("A", "https://youtube.com/watch?v=x"), caster("B", "b")] });
  const r = await sync.syncNow();
  assert.deepEqual(r.badLinks, ["A"]);
  assert.equal(r.live, 1);
  assert.equal(cam(obs.view(), 1).url, vdo("b"));
});

test("the cams follow the overlay's transform (720p canvas, moved or fitted overlay)", async () => {
  const { obs, sync, set } = setup();
  const overlayItem = obs.scenes.get(SCENE).find((x) => x.sourceName === "Casters Overlay");
  Object.assign(overlayItem.transform, { scaleX: 2 / 3, scaleY: 2 / 3 }); // an imported collection on a 1280x720 canvas
  set({ casters: [caster("A", "a"), caster("B", "b")] });
  let r = await sync.syncNow();
  assert.equal(r.followed, true);
  const want = RECTS["rivalry-casters"][2][0];
  const t = cam(obs.view(), 1).t;
  for (const [got, exp] of [[t.positionX, want.x * 2 / 3], [t.positionY, want.y * 2 / 3], [t.boundsWidth, want.w * 2 / 3], [t.boundsHeight, want.h * 2 / 3]]) {
    assert.ok(Math.abs(got - exp) < 0.01, `${got} vs ${exp}`);
  }
  // Rotated: can't be followed, so the 1080p rects, and the panel is told.
  Object.assign(overlayItem.transform, { scaleX: 1, scaleY: 1, rotation: 90 });
  r = await sync.syncNow();
  assert.equal(r.followed, false);
  assert.deepEqual(rectOf(cam(obs.view(), 1).t), want);
});

test("overlayPlacement maps the stage through position, alignment, bounds and crop", () => {
  const base = { positionX: 0, positionY: 0, rotation: 0, scaleX: 1, scaleY: 1, alignment: 5, boundsType: "OBS_BOUNDS_NONE",
    boundsAlignment: 0, sourceWidth: 1920, sourceHeight: 1080, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 };
  assert.deepEqual(overlayPlacement(base), { x: 0, y: 0, sx: 1, sy: 1 });
  assert.deepEqual(overlayPlacement({ ...base, positionX: 960, positionY: 540, alignment: 0, scaleX: 0.5, scaleY: 0.5 }), { x: 480, y: 270, sx: 0.5, sy: 0.5 });
  assert.deepEqual(overlayPlacement({ ...base, boundsType: "OBS_BOUNDS_SCALE_INNER", boundsWidth: 2560, boundsHeight: 1440 }), { x: 0, y: 0, sx: 4 / 3, sy: 4 / 3 });
  // Fitted into a 4:3 box, centred: letterboxed top and bottom.
  const lb = overlayPlacement({ ...base, boundsType: "OBS_BOUNDS_SCALE_INNER", boundsWidth: 1920, boundsHeight: 1440 });
  assert.deepEqual(lb, { x: 0, y: 180, sx: 1, sy: 1 });
  assert.deepEqual(overlayPlacement({ ...base, cropLeft: 100, positionX: 100 }), { x: 0, y: 0, sx: 1, sy: 1 }, "cropped and nudged back into place");
  assert.deepEqual(overlayPlacement({ ...base, sourceWidth: 1280, sourceHeight: 720, scaleX: 1.5, scaleY: 1.5 }), { x: 0, y: 0, sx: 1, sy: 1 }, "a 720p browser source scaled up");
  for (const bad of [{ rotation: 45 }, { scaleX: -1 }, { boundsType: "OBS_BOUNDS_SCALE_OUTER", boundsWidth: 1, boundsHeight: 1 }, { sourceWidth: 0 }]) {
    assert.equal(overlayPlacement({ ...base, ...bad }), null, JSON.stringify(bad));
  }
});

test("a feed blanked for a moment stays loaded, then unloads after the grace period", async () => {
  const { obs, sync, set } = setup({ graceMs: 80 });
  set({ casters: [caster("A", "a"), caster("B", "b"), caster("C", "c")] });
  await sync.syncNow();
  // Producer clears C's name to retype it.
  set({ casters: [caster("A", "a"), caster("B", "b")] });
  await sync.syncNow();
  let v = obs.view();
  assert.equal(cam(v, 3).enabled, false);
  assert.equal(cam(v, 3).url, vdo("c"), "still loaded during the grace period");
  // Retyped in time: back on air with no reload.
  set({ casters: [caster("A", "a"), caster("B", "b"), caster("C", "c")] });
  const before = obs.writes.length;
  await sync.syncNow();
  assert.ok(!obs.writes.slice(before).some(([t, n]) => t === "SetInputSettings" && n === "Caster Cam 3"), "no reconnect");
  assert.equal(cam(obs.view(), 3).enabled, true);
  // Cleared for good: unloaded once the grace runs out.
  set({ casters: [caster("A", "a"), caster("B", "b")] });
  await sync.syncNow();
  await sleep(200);
  v = obs.view();
  assert.equal(cam(v, 3).url, "", "unloaded after the grace period");
});

test("a change to the frames reaches OBS at once; a link being typed waits for a pause", async () => {
  const { obs, sync, set } = setup({ debounceMs: 300 });
  set({ casters: [caster("A", "a"), caster("B", "b")] });
  await sync.syncNow();
  set({ casterCams: 1, casters: [caster("A", "a"), caster("B", "b")] });
  sync.request();
  await sleep(40);
  assert.deepEqual(rectOf(cam(obs.view(), 1).t), RECTS["rivalry-casters"][1][0], "moved with the overlay's frames");
  const before = obs.writes.length;
  for (let i = 0; i < 5; i++) { set({ casterCams: 1, casters: [caster("A", "a" + i), caster("B", "b")] }); sync.request(); await sleep(10); }
  assert.equal(obs.writes.length, before, "nothing yet while typing");
  await sleep(400);
  assert.equal(cam(obs.view(), 1).url, vdo("a4"), "the last link, once");
  assert.equal(obs.writes.slice(before).filter(([t, n]) => t === "SetInputSettings" && n === "Caster Cam 1").length, 1);
});

test("an unchanged plan writes nothing; a forced sync re-places without reloading feeds", async () => {
  const { obs, sync, set } = setup();
  set({ casters: [caster("A", "a"), caster("B", "b")] });
  await sync.syncNow();
  const before = obs.writes.length;
  sync.request();
  await sleep(30);
  assert.equal(obs.writes.length, before, "nothing changed, nothing written");
  await sync.syncNow();
  const forced = obs.writes.slice(before);
  assert.ok(forced.some(([t]) => t === "SetSceneItemTransform"));
  assert.ok(!forced.some(([t]) => t === "SetInputSettings"), "same URL: a live camera is not reloaded");
});

test("a forced request (OBS reconnect) puts back a cam deleted or dragged above the overlay", async () => {
  const { obs, sync, set } = setup();
  set({ casters: [caster("A", "a"), caster("B", "b")] });
  await sync.syncNow();
  const items = obs.scenes.get(SCENE);
  items.splice(items.findIndex((x) => x.sourceName === "Caster Cam 1"), 1); // deleted from the scene
  const c2 = items.splice(items.findIndex((x) => x.sourceName === "Caster Cam 2"), 1)[0];
  items.push(c2); // dragged to the top
  sync.request(true);
  await sleep(30);
  const v = obs.view();
  const ov = v.find((x) => x.name === "Casters Overlay").index;
  assert.ok(cam(v, 1) && cam(v, 1).index < ov, "re-added under the overlay");
  assert.ok(cam(v, 2).index < ov, "moved back under the overlay");
});

test("an edit that lands while a sync is running is applied right after it", async () => {
  const { obs, sync, set } = setup({ latency: 5 });
  set({ casters: [caster("A", "a"), caster("B", "b")] });
  const first = sync.syncNow();
  await sleep(12);
  set({ casters: [caster("A", "a"), caster("B", "newlink")] });
  sync.request();
  await first;
  await sleep(400);
  assert.equal(cam(obs.view(), 2).url, vdo("newlink"));
});

test("rapid edits (one per keystroke) collapse into one sync that applies the last", async () => {
  const { obs, sync, set } = setup({ debounceMs: 30 });
  set({ casters: [caster("A", "a")] });
  await sync.syncNow();
  const lists = () => obs.writes.length;
  const before = lists();
  for (let i = 0; i < 10; i++) { set({ casters: [caster("A", "a" + i)] }); sync.request(); await sleep(2); }
  await sleep(120);
  const setUrls = obs.writes.slice(before).filter(([t]) => t === "SetInputSettings");
  assert.equal(setUrls.length, 1, "one reload, not ten");
  assert.equal(cam(obs.view(), 1).url, vdo("a9"));
});

test("the producer's own webcam in the scene is never touched", async () => {
  const { obs, sync, set } = setup({ extra: [{ name: "Webcam", kind: "dshow_input" }] });
  set({ casters: [caster("A", "a")] });
  await sync.syncNow();
  assert.ok(obs.writes.every(([, target]) => target !== "Webcam"), JSON.stringify(obs.writes));
  assert.ok(obs.view().some((x) => x.name === "Webcam"));
});

test("a cam input that survives outside the scene is re-added, not duplicated", async () => {
  const { obs, sync, set } = setup();
  obs.inputs.set("Caster Cam 1", { kind: "browser_source", settings: { url: "" } });
  set({ casters: [caster("A", "a")] });
  await sync.syncNow();
  assert.ok(obs.writes.some(([t, n]) => t === "CreateSceneItem" && n === "Caster Cam 1"));
  assert.ok(!obs.writes.some(([t, n]) => t === "CreateInput" && n === "Caster Cam 1"));
  assert.equal(cam(obs.view(), 1).url, vdo("a"));
});

test("OBS integration off, OBS offline, no Casters scene, no casters overlay: reported, nothing written", async () => {
  const obs = fakeObs();
  const mk = (isConnected, isEnabled = () => true) => createCasterCamSync({ call: obs.call, isConnected, isEnabled, getControl: () => ({ casters: [caster("A", "a")] }), sceneName: SCENE });
  assert.equal((await mk(() => true, () => false).syncNow()).reason, "obs-off");
  assert.equal((await mk(() => false).syncNow()).reason, "obs-offline");
  assert.equal((await mk(() => true).syncNow()).reason, "no-scene");
  obs.addScene(SCENE, [{ name: "Other", url: "http://localhost:49080/overlays/rivalry-brb/index.html" }]);
  assert.equal((await mk(() => true).syncNow()).reason, "no-overlay");
  assert.deepEqual(obs.writes, []);
});

test("overlayFromUrl and planCasterCams edge cases", () => {
  assert.equal(overlayFromUrl("not a url"), null);
  assert.equal(overlayFromUrl("http://localhost:49080/overlays/rivalry-brb/index.html"), null);
  assert.equal(overlayFromUrl("http://localhost:49080/overlays/toString/index.html"), null);
  assert.deepEqual(overlayFromUrl(SC26 + "?layout=solo"), { id: "rivalry-sc26-casters", pinned: 0, cover: false }, "only classic reads ?layout=");
  assert.deepEqual(overlayFromUrl(CLASSIC + "?layout=toString"), { id: "rivalry-casters", pinned: 0, cover: false }, "no prototype keys");
  assert.equal(overlayFromUrl(CLASSIC + "?fit=cover").cover, true);
  const plan = planCasterCams({ id: "rivalry-casters", pinned: 0 }, { casters: [caster("A", "https://evil.example/x")] });
  assert.equal(plan[0].url, "", "a non-VDO.Ninja link never loads into OBS");
  assert.equal(plan[0].enabled, false);
});

test("the overlay is still found when OBS leaves inputKind off the scene items", async () => {
  const obs = fakeObs();
  obs.addScene(SCENE, [{ name: "Casters Overlay", url: CLASSIC }]);
  const bare = async (type, d) => {
    const r = await obs.call(type, d);
    if (type === "GetSceneItemList") r.sceneItems.forEach((it) => delete it.inputKind);
    return r;
  };
  const sync = createCasterCamSync({ call: bare, isConnected: () => true, getControl: () => ({ casters: [caster("A", "a")] }), sceneName: SCENE });
  assert.equal((await sync.syncNow()).overlay, "rivalry-casters");
});

test("a link cleared and a name changed in one debounce window still cut the feed", async () => {
  const { obs, sync, set } = setup({ debounceMs: 60, graceMs: 5000 });
  set({ casterCams: 1, casters: [caster("ALEX", "alexcam"), caster("SAM", "samcam")] });
  await sync.syncNow();
  assert.equal(cam(obs.view(), 2).url, vdo("samcam"));
  // Replacing SAM: link cleared, then the name typed over, keystrokes 10 ms apart.
  for (const step of [caster("SAM", ""), caster("", ""), caster("K", ""), caster("KI", ""), caster("KIM", "")]) {
    set({ casterCams: 1, casters: [caster("ALEX", "alexcam"), step].filter((c) => c.name) });
    sync.request();
    await sleep(10);
  }
  await sleep(150);
  assert.ok(!obs.view().some((x) => x.url === vdo("samcam")), "SAM is cut, not held for the retype grace");
});

test("a hand-made copy inside a group or nested scene in the Casters scene counts as the producer's", async () => {
  const { obs, sync, set } = setup({ extra: [
    { name: "Cams", group: [{ name: "Alex cam", url: vdo("alexcam") }] },
    { name: "Sam corner", scene: [{ name: "Sam cam", url: "https://vdo.ninja/?view=samcam" }] },
  ] });
  set({ casters: [caster("ALEX", "alexcam"), caster("SAM", "samcam")] });
  const r = await sync.syncNow();
  assert.deepEqual(r.dupes.map((d) => d.source), ["Alex cam", "Sam cam"]);
  assert.ok(!obs.inputs.has("Caster Cam 1") && !obs.inputs.has("Caster Cam 2"));
});

test("a cam the producer hides in OBS is reported hidden, not live", async () => {
  const { obs, sync, set, results } = setup();
  set({ casters: [caster("A", "a"), caster("B", "b")] });
  await sync.syncNow();
  obs.scenes.get(SCENE).find((x) => x.sourceName === "Caster Cam 2").enabled = false; // the eye icon
  sync.request(); // OBS's SceneItemEnableStateChanged: a re-check, nothing forced
  await sleep(40);
  const last = results[results.length - 1];
  assert.equal(last.live, 1);
  assert.deepEqual(last.hidden, [2]);
  assert.equal(cam(obs.view(), 2).enabled, false, "the app doesn't fight the producer on a re-check");
});

test("a held feed is reported, and a new feed takes a free source before evicting it", async () => {
  const { obs, sync, set } = setup({ graceMs: 5000 });
  set({ casters: [caster("ALEX", "alexcam"), caster("SAM", "samcam"), caster("JO", "jocam")] });
  await sync.syncNow();
  // ALEX's name blanked to retype it while SAM's link is replaced.
  set({ casters: [caster("SAM", "samcam2"), caster("JO", "jocam")] });
  const r = await sync.syncNow();
  assert.deepEqual(r.held, ["ALEX"]);
  assert.ok(obs.view().some((x) => !x.enabled && x.url === vdo("alexcam")), "ALEX still loaded for the retype");
  const before = obs.writes.length;
  set({ casters: [caster("ALEX", "alexcam"), caster("SAM", "samcam2"), caster("JO", "jocam")] });
  await sync.syncNow();
  assert.ok(!obs.writes.slice(before).some(([t]) => t === "SetInputSettings"), "ALEX back with no reload");
});

test("overlayPlacement follows the page's own fit inside a non-16:9 source, and refuses flips in a box", () => {
  const base = { positionX: 0, positionY: 0, rotation: 0, scaleX: 1, scaleY: 1, alignment: 5, boundsType: "OBS_BOUNDS_NONE",
    boundsAlignment: 0, sourceWidth: 1920, sourceHeight: 1080, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 };
  // A 1920x1440 (4:3) browser source: the stage is letterboxed 180 px top and bottom.
  assert.deepEqual(overlayPlacement({ ...base, sourceHeight: 1440 }), { x: 0, y: 180, sx: 1, sy: 1 });
  // ?fit=cover in the same source: scaled to fill the height, cropped at the sides.
  const cover = overlayPlacement({ ...base, sourceHeight: 1440 }, true);
  assert.ok(Math.abs(cover.sx - 4 / 3) < 1e-9 && Math.abs(cover.x - (1920 - 2560) / 2) < 1e-9 && cover.y === 0, JSON.stringify(cover));
  for (const bad of [{ scaleX: -1, boundsType: "OBS_BOUNDS_STRETCH", boundsWidth: 1920, boundsHeight: 1080 },
    { scaleX: 1, scaleY: 0.5, boundsType: "OBS_BOUNDS_SCALE_INNER", boundsWidth: 1920, boundsHeight: 1080 }]) {
    assert.equal(overlayPlacement({ ...base, ...bad }), null, JSON.stringify(bad));
  }
});
