/* =============================================================================
 * RIVALRY Fit  v1  —  resolution-independent scale-to-fit for overlay scenes
 * -----------------------------------------------------------------------------
 * Broadcast overlays are designed once at a fixed 1920x1080 reference, then
 * scaled UNIFORMLY to fill whatever size the OBS Browser Source / window gives
 * them. This keeps the design pixel-perfect at 720p / 1080p / 1440p and centers
 * it (with transparent letterbox) on the rare non-16:9 canvas — instead of
 * reflowing, which would break broadcast layouts and motion.
 *
 *   <script src="../sdk/rivalry-fit.js"></script>
 *   RivalryFit('.rv-stage');            // scales the 1920x1080 stage to fit
 *
 * Modes (preserve aspect either way):
 *   "contain" (default) — fit inside the viewport; non-16:9 gets letterbox bars. Never crops.
 *   "cover"             — fill the viewport; non-16:9 crops the design edges. No bars.
 * Pick per source with a URL query: append ?fit=cover to the Browser Source URL.
 * On a true 16:9 viewport contain == cover == an exact, gap-free fill.
 * ===========================================================================*/

(function (global) {
  "use strict";

  function RivalryFit(target, opts) {
    opts = opts || {};
    var W = opts.width || 1920;
    var H = opts.height || 1080;

    var doc = global.document;
    var stage = typeof target === "string" ? doc.querySelector(target) : target;
    if (!stage) return null;

    // Resolve fit mode: explicit opt > ?fit= query param > default "contain".
    var mode = opts.mode;
    if (!mode) {
      try { mode = new URLSearchParams(global.location.search).get("fit"); } catch (e) { /* file:// */ }
    }
    if (mode !== "cover") mode = "contain";

    // The page must fill the Browser Source viewport (not sit in a fixed 1920px
    // box), so the stage has room to scale into.
    var de = doc.documentElement;
    de.style.margin = "0"; de.style.height = "100%";
    doc.body.style.margin = "0"; doc.body.style.width = "100%";
    doc.body.style.height = "100%"; doc.body.style.overflow = "hidden";

    // Center the stage and scale from its center.
    stage.style.position = "absolute";
    stage.style.left = "50%";
    stage.style.top = "50%";
    stage.style.transformOrigin = "center center";

    function apply() {
      var vw = global.innerWidth || W;
      var vh = global.innerHeight || H;
      var s = mode === "cover" ? Math.max(vw / W, vh / H) : Math.min(vw / W, vh / H);
      stage.style.transform = "translate(-50%, -50%) scale(" + s + ")";
    }

    apply();
    global.addEventListener("resize", apply);
    // Re-fit once fonts finish loading (text metrics can shift the layout).
    if (doc.fonts && doc.fonts.ready && doc.fonts.ready.then) doc.fonts.ready.then(apply);

    return { apply: apply, mode: mode };
  }

  global.RivalryFit = RivalryFit;
})(typeof window !== "undefined" ? window : this);
