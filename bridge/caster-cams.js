/* =============================================================================
 * RIVALRY caster cams in OBS
 * -----------------------------------------------------------------------------
 * The casters overlay is art with transparent holes; each caster's camera is an
 * OBS browser source BEHIND it, sized to its hole. This module puts those
 * sources there and keeps them in step with the panel's Casters card: which
 * feed each cam shows, where it sits for the current cam count, and whether
 * it is on at all.
 *
 * The layout comes from overlays/shared/rivalry-caster-cams.js, the same file
 * the scenes cut their holes from, mapped through the overlay's own transform
 * in OBS (an imported collection on a 720p canvas scales the overlay; so do
 * the cams). Which overlay's holes to follow is read from OBS: the topmost
 * visible casters overlay in the Casters scene, so after a look change and
 * rebuild (which stacks the new overlay over the old one) the cams follow the
 * look that is actually on air.
 *
 * The app owns exactly "Caster Cam 1".."Caster Cam 3", and only as browser
 * sources: a producer's webcam or source by another name is left alone. A
 * feed one of the producer's own browser sources in the Casters scene already
 * plays (a cam added by hand before the app managed them) is not loaded a
 * second time: that would put the caster's audio on air twice. Casters who
 * share a cam without being the feed it shows stay loaded on a spare cam
 * source, hidden, so they are still heard.
 *
 * Feeds stick to their source: when a cam count or a caster's position on the
 * card changes, the source already playing a feed moves to its new hole
 * rather than another source reloading it, so a live camera never blinks for
 * a reconnect it does not need.
 *
 * Everything goes through one injected `call(requestType, data)`
 * (obs-websocket v5), so the tests drive it against an in-memory OBS.
 * ===========================================================================*/

"use strict";

const layout = require("../overlays/shared/rivalry-caster-cams");

const CAM_SOURCE_PREFIX = "Caster Cam ";
const camSourceName = (i) => CAM_SOURCE_PREFIX + (i + 1);
// Exactly the app's names: a producer's "Caster Cam - Alex" is theirs.
const OWN_NAMES = Array.from({ length: layout.MAX_CAMS }, (_, i) => camSourceName(i));
const isOwnName = (name) => OWN_NAMES.includes(name);

// Browser-source settings for a cam. shutdown:false keeps the VDO.Ninja
// connection up while the Casters scene is off program, so a cut to it never
// waits on a reconnect; audio plays the way the old in-scene embed did.
const CAM_INPUT_SETTINGS = Object.freeze({ width: 1920, height: 1080, fps: 30, fps_custom: true, shutdown: false, reroute_audio: false });

// A caster whose row drops off the card (the name blanked to retype it) keeps
// their feed loaded, hidden, this long, so putting the name back is instant
// instead of a VDO.Ninja reconnect. Clearing or changing a named caster's
// link unloads the old feed at once: that is how a producer cuts a caster.
const RELEASE_GRACE_MS = 15000;

// Only rivalry-casters reads ?layout=solo|duo|trio (kept from before cam counts
// existed); it pins the frame count whatever the payload says.
const LAYOUT_PINS = { solo: 1, duo: 2, trio: 3 };

// The casters overlay a browser-source URL points at, or null.
function overlayFromUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch (e) { return null; }
  const m = u.pathname.match(/^\/overlays\/([^/]+)\//);
  if (!m || !Object.prototype.hasOwnProperty.call(layout.RECTS, m[1])) return null;
  const pin = u.searchParams.get("layout");
  const pinned = m[1] === "rivalry-casters" && Object.prototype.hasOwnProperty.call(LAYOUT_PINS, pin) ? LAYOUT_PINS[pin] : 0;
  // ?fit=cover (overlays/sdk/rivalry-fit.js) fills a non-16:9 source instead of letterboxing.
  return { id: m[1], pinned, cover: u.searchParams.get("fit") === "cover" };
}

const feedKey = layout.feedKey;

// One entry per cam source, in natural order. Cams 1..n are the frames (rect
// set); the spares carry the feeds of casters who share a frame, hidden. A
// frame whose feed an earlier frame already shows stays empty (`repeatOf`).
function planCasterCams(overlay, control) {
  const n = overlay.pinned || layout.camCount(control, overlay.id);
  const rects = layout.RECTS[overlay.id][n];
  const slots = layout.slots(control, n);
  const extras = layout.extraFeeds(control, n);
  const shown = [];
  return Array.from({ length: layout.MAX_CAMS }, (_, i) => {
    if (i < n) {
      const url = layout.vdoUrl(slots[i].stream);
      const k = feedKey(url);
      const at = k ? shown.indexOf(k) : -1;
      shown.push(k);
      if (at >= 0) return { sourceName: camSourceName(i), url: "", rect: rects[i], enabled: false, repeatOf: at + 1 };
      return { sourceName: camSourceName(i), url, rect: rects[i], enabled: !!url };
    }
    const extra = extras[i - n];
    return { sourceName: camSourceName(i), url: extra ? extra.url : "", rect: null, enabled: false, heardOnly: extra ? extra.name : "" };
  });
}

// The topmost VISIBLE casters overlay in the scene (items come bottom-first).
// kinds: input name -> inputKind for the whole collection.
async function findOverlay(call, items, kinds) {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.sceneItemEnabled === false || it.isGroup || isOwnName(it.sourceName)) continue;
    if (kinds.get(it.sourceName) !== "browser_source") continue;
    let url;
    try { url = (await call("GetInputSettings", { inputName: it.sourceName })).inputSettings.url; } catch (e) { continue; }
    const o = overlayFromUrl(url);
    if (o) return { ...o, index: i, sceneItemId: it.sceneItemId };
  }
  return null;
}

// Where the overlay's 1920x1080 stage lands on the canvas, from its scene item
// transform: { x, y, sx, sy } (stage px -> canvas px). Inside the source the
// page fits the stage the way overlays/sdk/rivalry-fit.js does: uniformly,
// centred, letterboxed (or cropped with ?fit=cover) in a non-16:9 source.
// null when the transform is one the cams can't follow (rotated, flipped,
// unevenly scaled into a box, an unusual bounds mode).
const ALIGN_X = (a) => (a & 1 ? 0 : a & 2 ? 1 : 0.5); // OBS_ALIGN_LEFT / RIGHT / centre
const ALIGN_Y = (a) => (a & 4 ? 0 : a & 8 ? 1 : 0.5); // OBS_ALIGN_TOP / BOTTOM / centre
function overlayPlacement(t, cover = false) {
  if (!t) return null;
  const sw = Number(t.sourceWidth), sh = Number(t.sourceHeight);
  const cl = Number(t.cropLeft) || 0, ct = Number(t.cropTop) || 0;
  const cw = sw - cl - (Number(t.cropRight) || 0), ch = sh - ct - (Number(t.cropBottom) || 0);
  if (!(cw > 0 && ch > 0) || Math.abs(Number(t.rotation) || 0) > 0.01) return null;
  const scaleX = Number(t.scaleX == null ? 1 : t.scaleX), scaleY = Number(t.scaleY == null ? 1 : t.scaleY);
  if (!(scaleX > 0 && scaleY > 0)) return null; // flipped, in any bounds mode
  const bounds = t.boundsType || "OBS_BOUNDS_NONE";
  let kx, ky, boxW, boxH;
  if (bounds === "OBS_BOUNDS_NONE") {
    kx = scaleX; ky = scaleY;
    boxW = cw * kx; boxH = ch * ky;
  } else if (bounds === "OBS_BOUNDS_STRETCH" || bounds === "OBS_BOUNDS_SCALE_INNER") {
    boxW = Number(t.boundsWidth); boxH = Number(t.boundsHeight);
    if (!(boxW > 0 && boxH > 0)) return null;
    // libobs keeps an uneven stored scale's ratio inside a fitted box.
    if (bounds === "OBS_BOUNDS_SCALE_INNER" && Math.abs(scaleX - scaleY) > 1e-6) return null;
    kx = bounds === "OBS_BOUNDS_STRETCH" ? boxW / cw : Math.min(boxW / cw, boxH / ch);
    ky = bounds === "OBS_BOUNDS_STRETCH" ? boxH / ch : kx;
  } else {
    return null;
  }
  const align = t.alignment == null ? 5 : Number(t.alignment);
  const inner = bounds === "OBS_BOUNDS_NONE" ? 5 : (t.boundsAlignment == null ? 0 : Number(t.boundsAlignment));
  const left = Number(t.positionX) - ALIGN_X(align) * boxW + ALIGN_X(inner) * (boxW - cw * kx);
  const top = Number(t.positionY) - ALIGN_Y(align) * boxH + ALIGN_Y(inner) * (boxH - ch * ky);
  // The stage inside the source (source px).
  const fit = cover ? Math.max(sw / 1920, sh / 1080) : Math.min(sw / 1920, sh / 1080);
  const offX = (sw - 1920 * fit) / 2, offY = (sh - 1080 * fit) / 2;
  return { x: left + (offX - cl) * kx, y: top + (offY - ct) * ky, sx: fit * kx, sy: fit * ky };
}

const r2 = (v) => Math.round(v * 100) / 100;
const placeRect = (p, r) => (p ? { x: r2(p.x + r.x * p.sx), y: r2(p.y + r.y * p.sy), w: r2(r.w * p.sx), h: r2(r.h * p.sy) } : r);

// Puts one cam source in the state `tg` asks for: { name, exists, item, url }
// (what OBS has now) -> tg.url / tg.rect / tg.enabled. overlayIndex: a cam
// found above the overlay is put back underneath.
async function applyCam(call, sceneName, src, tg, overlayIndex) {
  let item = src.item;
  if (!item) {
    if (!tg.url) {
      // Not in the scene and nothing to show: just make sure it plays nothing.
      if (src.exists && src.url) await call("SetInputSettings", { inputName: src.name, inputSettings: { url: "" } });
      return;
    }
    let sceneItemId;
    if (src.exists) {
      // The input survives elsewhere (removed from this scene by hand): reuse it.
      sceneItemId = (await call("CreateSceneItem", { sceneName, sourceName: src.name, sceneItemEnabled: false })).sceneItemId;
    } else {
      sceneItemId = (await call("CreateInput", {
        sceneName,
        inputName: src.name,
        inputKind: "browser_source",
        inputSettings: { ...CAM_INPUT_SETTINGS, url: tg.url },
        sceneItemEnabled: false,
      })).sceneItemId;
      src.url = tg.url;
    }
    // New items land on top; a cam belongs under the overlay.
    await call("SetSceneItemIndex", { sceneName, sceneItemId, sceneItemIndex: 0 });
    item = { sceneItemId, sceneItemEnabled: false };
  } else if (overlayIndex !== undefined && item.index > overlayIndex) {
    // Dragged above the overlay in OBS: it would cover the art.
    await call("SetSceneItemIndex", { sceneName, sceneItemId: item.sceneItemId, sceneItemIndex: 0 });
  }
  // Same URL is left alone: re-setting it would reload a live camera.
  if (src.url !== tg.url) await call("SetInputSettings", { inputName: src.name, inputSettings: { url: tg.url } });
  if (tg.rect) {
    await call("SetSceneItemTransform", {
      sceneName,
      sceneItemId: item.sceneItemId,
      sceneItemTransform: {
        positionX: tg.rect.x,
        positionY: tg.rect.y,
        alignment: 5, // top-left
        rotation: 0,
        boundsType: "OBS_BOUNDS_SCALE_INNER",
        boundsAlignment: 0,
        boundsWidth: tg.rect.w,
        boundsHeight: tg.rect.h,
      },
    });
  }
  if (item.sceneItemEnabled !== tg.enabled) {
    await call("SetSceneItemEnabled", { sceneName, sceneItemId: item.sceneItemId, sceneItemEnabled: tg.enabled });
  }
}

// Keeps OBS's cam sources in step with the control state.
//   request(force)  a change to the frames (count, which cams have a feed) is
//                   applied at once, so the cams move with the overlay's holes;
//                   anything else (a link being typed) waits for a pause
//   syncNow()       immediate, forced; resolves with the result (scene build)
// Runs never overlap, and a request that lands mid-run runs after it. A run
// whose outcome matches the last one applied writes nothing unless forced
// (OBS reconnects, scene builds, collection switches, sources removed).
function createCasterCamSync({
  call, isConnected, isEnabled = () => true, getControl, sceneName,
  onResult = () => {}, debounceMs = 400, graceMs = RELEASE_GRACE_MS, now = () => Date.now(),
}) {
  let timer = null;
  let graceTimer = null;
  let pendingForce = false;
  let running = null;
  let again = false;
  let lastSig = null;
  let lastOverlay = null;
  let lastFrames = null;
  const owners = new Map(); // feedKey -> name of the caster last seen carrying it
  const cut = new Set(); // feeds a still-named caster stopped carrying: no grace
  const released = new Map(); // feedKey -> when it dropped out of the plan

  function report(r) { onResult(r); return r; }
  const framesOf = (cams) => JSON.stringify(cams.map((c) => [c.rect, c.enabled]));
  const settingsUrl = async (inputName) => {
    try { return (await call("GetInputSettings", { inputName })).inputSettings.url || ""; } catch (e) { return ""; }
  };

  // Every control push passes through here (request() and each run), so a
  // link cleared and a name changed in one debounce window are still told
  // apart from a name being retyped.
  function observe(control) {
    const rows = (Array.isArray(control && control.casters) ? control.casters : [])
      .map((c) => ({ name: String((c && c.name) || "").trim(), key: feedKey(layout.vdoUrl(c && c.stream)) }))
      .filter((r) => r.name);
    const carriedBy = new Map(rows.map((r) => [r.name, new Set()]));
    for (const r of rows) if (r.key) carriedBy.get(r.name).add(r.key);
    for (const [key, name] of owners) {
      if (carriedBy.has(name) && !carriedBy.get(name).has(key)) cut.add(key);
    }
    for (const r of rows) if (r.key) { owners.set(r.key, r.name); cut.delete(r.key); }
  }

  // The producer's own browser sources in the scene, groups and nested scenes
  // included: feedKey -> source name.
  async function theirFeeds(items, kinds, seen = new Set([sceneName])) {
    const out = new Map();
    for (const it of items) {
      let inner = null;
      if (it.isGroup) inner = "GetGroupSceneItemList";
      else if (!kinds.has(it.sourceName) && !seen.has(it.sourceName)) inner = "GetSceneItemList";
      if (inner) {
        seen.add(it.sourceName);
        let sub = [];
        try { sub = (await call(inner, { sceneName: it.sourceName })).sceneItems || []; } catch (e) { /* not a scene */ }
        for (const [k, name] of await theirFeeds(sub, kinds, seen)) if (!out.has(k)) out.set(k, name);
        continue;
      }
      if (isOwnName(it.sourceName) || kinds.get(it.sourceName) !== "browser_source") continue;
      const k = feedKey(await settingsUrl(it.sourceName));
      if (k && !out.has(k)) out.set(k, it.sourceName);
    }
    return out;
  }

  async function run(force) {
    if (!isEnabled()) return report({ ok: false, reason: "obs-off" });
    if (!isConnected()) return report({ ok: false, reason: "obs-offline" });
    let items;
    try { items = (await call("GetSceneItemList", { sceneName })).sceneItems; }
    catch (e) { return report({ ok: false, reason: "no-scene", scene: sceneName }); }
    const kinds = new Map((await call("GetInputList", {})).inputs.map((i) => [i.inputName, i.inputKind]));
    const overlay = await findOverlay(call, items, kinds);
    if (!overlay) return report({ ok: false, reason: "no-overlay", scene: sceneName });
    let placement = null;
    try {
      placement = overlayPlacement((await call("GetSceneItemTransform", { sceneName, sceneItemId: overlay.sceneItemId })).sceneItemTransform, overlay.cover);
    } catch (e) { placement = null; }
    const control = getControl() || {};
    observe(control);
    const plan = planCasterCams(overlay, control);
    lastOverlay = overlay;
    lastFrames = framesOf(plan);

    // The app's cam sources as OBS has them now. A name another kind of
    // source holds is the producer's: left alone, and that cam goes without.
    const clashes = OWN_NAMES.filter((n) => kinds.has(n) && kinds.get(n) !== "browser_source");
    const pool = [];
    for (const name of OWN_NAMES) {
      if (clashes.includes(name)) continue;
      const index = items.findIndex((it) => it.sourceName === name);
      const url = kinds.has(name) ? await settingsUrl(name) : "";
      pool.push({ name, exists: kinds.has(name), item: index < 0 ? null : { ...items[index], index }, url, key: feedKey(url) });
    }

    // Feeds the producer's own sources in this scene already play.
    const theirs = await theirFeeds(items, kinds);

    const slotNames = layout.slots(control, overlay.pinned || layout.camCount(control, overlay.id)).map((x) => x.name);
    const cams = plan.map((c, i) => ({ ...c, frame: c.rect ? i + 1 : 0, who: c.rect ? slotNames[i] : c.heardOnly, src: null }));
    for (const c of cams) {
      const k = feedKey(c.url);
      if (k && theirs.has(k)) { c.dupOf = theirs.get(k); c.url = ""; c.enabled = false; }
      c.key = feedKey(c.url);
    }
    const wanted = cams.filter((c) => c.url);
    const taken = new Map(); // pool source -> cam
    const claim = (src, c) => { taken.set(src, c); c.src = src; };

    // 1. A feed already loaded stays in its source, whatever hole it moved to.
    for (const same of [(src, c) => src.url === c.url, (src, c) => src.key === c.key]) {
      for (const c of wanted) {
        const src = !c.src && pool.find((p) => !taken.has(p) && same(p, c));
        if (src) claim(src, c);
      }
    }
    for (const c of wanted) released.delete(c.key);

    // 2. A feed that dropped out stays loaded for the grace period while its
    //    caster's row is gone (a name being retyped). One a still-named caster
    //    stopped carrying (link cleared or changed) is cut at once, and so is
    //    one the producer's own source now plays.
    const t = now();
    let wake = null;
    const holding = new Set();
    for (const src of pool) {
      if (taken.has(src) || !src.key) continue;
      if (theirs.has(src.key) || cut.has(src.key)) { released.delete(src.key); continue; }
      if (!released.has(src.key)) released.set(src.key, t);
      const until = released.get(src.key) + graceMs;
      if (t < until) { holding.add(src); wake = wake === null ? until : Math.min(wake, until); }
      else released.delete(src.key);
    }

    // 3. New feeds take their own-numbered source if it is free, else an empty
    //    one, else one whose feed is being cut; a held feed gives way last.
    for (const c of wanted) {
      if (c.src) continue;
      const free = (p) => !taken.has(p) && !holding.has(p);
      const src = pool.find((p) => p.name === c.sourceName && free(p)) || pool.find((p) => free(p) && !p.url) ||
        pool.find(free) || pool.find((p) => p.name === c.sourceName && !taken.has(p)) || pool.find((p) => !taken.has(p));
      if (!src) continue;
      holding.delete(src);
      claim(src, c);
    }

    const targets = pool.map((src) => {
      const c = taken.get(src);
      if (c) return { url: c.url, rect: c.rect ? placeRect(placement, c.rect) : null, enabled: !!c.rect };
      // A held feed stays where it is; one held outside this scene is let go.
      return { url: holding.has(src) && src.item ? src.url : "", rect: null, enabled: false };
    });
    const sig = JSON.stringify([overlay.id, overlay.pinned, pool.map((src, i) => [src.name, targets[i]])]);
    const apply = force || sig !== lastSig;
    if (apply) {
      // Cams that go dark are hidden before anything moves or lights up.
      const order = pool.map((src, i) => i).sort((a, b) => targets[a].enabled - targets[b].enabled);
      for (const i of order) await applyCam(call, sceneName, pool[i], targets[i], overlay.index);
      lastSig = sig;
    }
    // Owners worth remembering: casters on the card now, and held feeds'.
    const keep = new Set([...cams.map((c) => c.key), ...[...holding].map((src) => src.key)]);
    for (const k of [...owners.keys()]) if (!keep.has(k) && !released.has(k)) { owners.delete(k); cut.delete(k); }
    clearTimeout(graceTimer);
    graceTimer = wake === null ? null : setTimeout(() => request(true), Math.max(0, wake - t) + 20);

    // What OBS shows: when nothing was written this run, a cam the producer
    // hid with the eye icon is reported as hidden, not live.
    const frames = cams.filter((c) => c.rect);
    const shown = (c) => c.src && (apply || (c.src.item && c.src.item.sceneItemEnabled !== false));
    return report({
      ok: true,
      scene: sceneName,
      overlay: overlay.id,
      followed: !!placement, // false: the overlay's transform can't be followed, cams on the 1080p rects
      frames: frames.length,
      names: frames.map((c) => c.who || ""),
      live: frames.filter(shown).length,
      hidden: frames.filter((c) => c.src && !shown(c)).map((c) => c.frame),
      waiting: frames.filter((c) => !c.url && !c.dupOf && !c.repeatOf && c.who).map((c) => c.frame),
      noCaster: frames.filter((c) => !c.who).map((c) => c.frame),
      heardOnly: cams.filter((c) => !c.rect && c.src).map((c) => c.heardOnly),
      held: [...holding].map((src) => owners.get(src.key) || "").filter(Boolean),
      dupes: cams.filter((c) => c.dupOf).map((c) => ({ cam: c.frame, name: c.who || "", source: c.dupOf })),
      repeats: frames.filter((c) => c.repeatOf).map((c) => ({ cam: c.frame, of: c.repeatOf })),
      badLinks: layout.badLinks(control),
      clashes,
      unplaced: wanted.filter((c) => !c.src).map((c) => c.frame || c.heardOnly),
    });
  }

  async function exec(force) {
    while (running) await running;
    running = run(force).catch((e) => report({ ok: false, reason: "error", error: e && e.message ? e.message : String(e) }));
    try { return await running; } finally {
      running = null;
      if (again) { again = false; setTimeout(flush, 0); }
    }
  }

  function flush() {
    timer = null;
    if (running) { again = true; return; }
    const force = pendingForce;
    pendingForce = false;
    exec(force);
  }

  function request(force) {
    try { observe(getControl() || {}); } catch (e) { /* the run reads it again */ }
    pendingForce = pendingForce || !!force;
    let urgent = !!force;
    if (!urgent && lastOverlay) {
      try { urgent = framesOf(planCasterCams(lastOverlay, getControl() || {})) !== lastFrames; } catch (e) { urgent = true; }
    }
    clearTimeout(timer);
    timer = setTimeout(flush, urgent ? 0 : debounceMs);
  }

  return { request, syncNow: () => exec(true) };
}

module.exports = {
  CAM_SOURCE_PREFIX,
  OWN_NAMES,
  CAM_INPUT_SETTINGS,
  RELEASE_GRACE_MS,
  camSourceName,
  overlayFromUrl,
  feedKey,
  planCasterCams,
  overlayPlacement,
  createCasterCamSync,
};
