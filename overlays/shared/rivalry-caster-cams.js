/* =============================================================================
 * RivalryCasterCams: the caster camera layout, shared by scenes and the app
 * -----------------------------------------------------------------------------
 * The casters scenes punch transparent holes in their art; each caster's
 * camera is an OBS source BEHIND the overlay, sized to its hole. The app
 * places those sources itself (bridge/caster-cams.js), so the scene and the
 * app must agree exactly on how many cams there are and where each one sits.
 * Both read it from this one file: a <script> in the scenes, a CommonJS module
 * in the main process.
 *
 *   camCount(control, id) how many cam frames: control.casterCams (1-3) when
 *                         the producer picked one, else one per named caster
 *                         (none named yet: the designed two-frame look), never
 *                         fewer than the overlay's AUTO_MIN
 *   slots(control, n)     one entry per cam: who is in it and its feed. With
 *                         fewer cams than casters, the extra casters share the
 *                         last cam (two casters on one desk camera)
 *   RECTS[overlayId][n]   the n-cam hole rects on the 1920x1080 stage
 *   vdoUrl(stream)        a VDO.Ninja view link or bare stream ID -> the URL
 *                         the OBS source loads; "" for anything else
 *   extraFeeds(control, n) [{ url, name }] of casters who share a cam but are
 *                         not the feed it shows: still loaded (hidden) so they
 *                         are heard
 *   feedKey(url)          which VDO.Ninja feed a URL plays, whatever its extra
 *                         parameters, so one feed is never loaded twice
 *   badLinks(control)     named casters whose link is not a VDO.Ninja one
 *
 * rivalry-sc26-casters lays its frames out with flexbox and measures them for
 * its mask, so its rects here are those measurements; render-verify fails if
 * the scene's frames ever move off them.
 * ===========================================================================*/

(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RivalryCasterCams = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var MAX_CAMS = 3;

  var RECTS = {
    "rivalry-casters": {
      1: [{ x: 360, y: 250, w: 1200, h: 675 }],
      2: [{ x: 90, y: 300, w: 853, h: 480 }, { x: 977, y: 300, w: 853, h: 480 }],
      3: [{ x: 90, y: 383, w: 560, h: 315 }, { x: 680, y: 383, w: 560, h: 315 }, { x: 1270, y: 383, w: 560, h: 315 }],
    },
    "rivalry-sc26-casters": {
      1: [{ x: 620, y: 267, w: 680, h: 382 }],
      2: [{ x: 255, y: 267, w: 680, h: 382 }, { x: 985, y: 267, w: 680, h: 382 }],
      3: [{ x: 81, y: 302, w: 553, h: 311 }, { x: 684, y: 302, w: 553, h: 311 }, { x: 1287, y: 302, w: 553, h: 311 }],
    },
  };

  // Auto never goes below this many frames. rivalry-casters keeps one named
  // caster on the two-frame layout, as it always has: cams and webcams placed
  // on its duo holes before cam counts existed stay lined up. A single big
  // frame is the "1 cam" pick.
  var AUTO_MIN = { "rivalry-casters": 2 };

  // Named casters only, in order: a blank panel row never takes a cam.
  function named(control) {
    var cs = control && Array.isArray(control.casters) ? control.casters : [];
    return cs.filter(function (c) { return c && c.name; }).slice(0, MAX_CAMS);
  }

  function camCount(control, overlayId) {
    var picked = Number(control && control.casterCams);
    if (picked >= 1 && picked <= MAX_CAMS && Math.floor(picked) === picked) return picked;
    var min = Object.prototype.hasOwnProperty.call(AUTO_MIN, overlayId) ? AUTO_MIN[overlayId] : 1;
    return Math.max(named(control).length || 2, min);
  }

  function join(who, key, sep) {
    return who.map(function (c) { return String(c[key] || "").trim(); }).filter(Boolean).join(sep);
  }

  function slots(control, count) {
    var n = count || camCount(control);
    var cs = named(control);
    var out = [];
    for (var i = 0; i < n; i++) {
      // The last cam takes every caster left over.
      var who = i < n - 1 ? cs.slice(i, i + 1) : cs.slice(i);
      // The first caster whose link loads (a rejected link never blanks a
      // shared cam another caster could fill).
      var feed = who.filter(function (c) { return vdoUrl(c.stream); })[0];
      out.push({
        casters: who,
        name: join(who, "name", " & "),
        role: join(who, "role", " / "),
        handle: join(who, "handle", " / "),
        stream: feed ? String(feed.stream).trim() : "",
      });
    }
    return out;
  }

  // Feeds of casters who share a cam without being the one it shows, in
  // order, deduped against every feed already on a cam. With n cams they ride
  // the spare cam sources hidden: still loaded, so the caster is still heard.
  function extraFeeds(control, count) {
    var n = count || camCount(control);
    var taken = slots(control, n).map(function (s) { return feedKey(vdoUrl(s.stream)); });
    var out = [];
    named(control).forEach(function (c) {
      var u = vdoUrl(c.stream), k = feedKey(u);
      if (k && taken.indexOf(k) < 0) { taken.push(k); out.push({ url: u, name: String(c.name).trim() }); }
    });
    return out;
  }

  // A stream ID and the view link for it, or the same link with its
  // parameters in another order, are one feed: keyed on the view ID.
  function feedKey(url) {
    var u;
    try { u = new URL(String(url)); } catch (e) { return ""; }
    if (!/(^|\.)(vdo|obs)\.ninja$/i.test(u.hostname)) return "";
    var view = u.searchParams.get("view");
    return view ? "view:" + view.toLowerCase() : "url:" + u.hostname.replace(/(^|\.)obs\.ninja$/i, "$1vdo.ninja").toLowerCase() + u.pathname + u.search;
  }

  function badLinks(control) {
    return named(control)
      .filter(function (c) { return String(c.stream || "").trim() && !vdoUrl(c.stream); })
      .map(function (c) { return String(c.name).trim(); });
  }

  // Only VDO.Ninja ever loads into the cam sources: the stream field comes off
  // the control bus, and an arbitrary URL would run any page inside OBS. The
  // panel's placeholder shows links without a scheme, so those are accepted,
  // and obs.ninja (VDO.Ninja's old domain, still live) is moved to vdo.ninja.
  function vdoUrl(stream) {
    var s = String(stream == null ? "" : stream).trim();
    if (!s) return "";
    if (/^[A-Za-z0-9_-]+$/.test(s)) return "https://vdo.ninja/?view=" + encodeURIComponent(s) + "&cleanoutput&autostart";
    var u;
    try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : "https://" + s); } catch (e) { return ""; }
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    if (/^(.*\.)?obs\.ninja$/i.test(u.hostname)) u.hostname = u.hostname.replace(/obs\.ninja$/i, "vdo.ninja");
    if (!/(^|\.)vdo\.ninja$/i.test(u.hostname)) return "";
    u.protocol = "https:";
    return u.href;
  }

  return {
    MAX_CAMS: MAX_CAMS, RECTS: RECTS, AUTO_MIN: AUTO_MIN, camCount: camCount, slots: slots,
    extraFeeds: extraFeeds, vdoUrl: vdoUrl, feedKey: feedKey, badLinks: badLinks,
  };
});
