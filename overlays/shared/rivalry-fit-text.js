/* =============================================================================
 * RivalryFitText: long names shrink to fit instead of cutting off
 * -----------------------------------------------------------------------------
 * League team and player names run long ("Happy Little Bananas"), and a fixed
 * box that ellipsizes them reads as "HAPPY LITTLE B...". Mark the name with
 * data-fit and its font size steps down until the whole name fits the box:
 *
 *   <span class="nm" data-fit data-field="teamB.name"></span>
 *   <span class="nm" data-fit="0.7" ...>      never below 70% of the CSS size
 *   RivalryFitText(document.querySelector(".scene-root"));
 *
 * The floor defaults to 0.6 of the CSS size; a name still too wide at the
 * floor keeps the box's own ellipsis. The element needs a width it does not
 * get from its own text (a grid or flex track, a max-width) plus
 * white-space:nowrap and overflow:hidden.
 *
 * It refits by itself whenever a marked element's text changes (whoever writes
 * it: RivalryBind or the scene's own script), when the element changes size
 * (a hidden row shown, say), and once the fonts finish loading. Elements added
 * later can be fitted with RivalryFitText.fit(el).
 * ===========================================================================*/

(function (global) {
  "use strict";

  var FLOOR = 0.6;

  function floorOf(el) {
    var v = parseFloat(el.getAttribute("data-fit"));
    return v > 0 && v <= 1 ? v : FLOOR;
  }

  function fit(el) {
    el.style.fontSize = "";
    var w = el.clientWidth;
    // Hidden (no box yet): the resize watch refits it once it is shown.
    if (!w || el.scrollWidth <= w) return;
    var base = parseFloat(global.getComputedStyle(el).fontSize);
    if (!base) return;
    var min = Math.ceil(base * floorOf(el));
    // Text width scales with the font size, so one proportional step lands
    // close; whole-pixel steps then absorb rounding and letter-spacing.
    var size = Math.max(min, Math.floor((base * w) / el.scrollWidth));
    el.style.fontSize = size + "px";
    while (size > min && el.scrollWidth > el.clientWidth) {
      size -= 1;
      el.style.fontSize = size + "px";
    }
  }

  function RivalryFitText(root) {
    var doc = global.document;
    var els = Array.prototype.slice.call((root || doc).querySelectorAll("[data-fit]"));
    var fitAll = function () { els.forEach(fit); };

    // Text changes: refit just the elements whose text changed. Setting the
    // font size is a style change, not a text one, so this never loops.
    if (global.MutationObserver) {
      var mo = new global.MutationObserver(function (recs) {
        var seen = [];
        recs.forEach(function (r) {
          var n = r.target.nodeType === 1 ? r.target : r.target.parentNode;
          while (n && !n.hasAttribute("data-fit")) n = n.parentNode;
          if (n && seen.indexOf(n) < 0) { seen.push(n); fit(n); }
        });
      });
      els.forEach(function (el) { mo.observe(el, { childList: true, characterData: true, subtree: true }); });
    }
    // Box changes (shown after being hidden, a track resized): refit.
    if (global.ResizeObserver) {
      var ro = new global.ResizeObserver(function (entries) {
        entries.forEach(function (e) { fit(e.target); });
      });
      els.forEach(function (el) { ro.observe(el); });
    }
    fitAll();
    if (doc.fonts && doc.fonts.ready && doc.fonts.ready.then) doc.fonts.ready.then(fitAll);
    return { refit: fitAll };
  }

  RivalryFitText.fit = fit;
  global.RivalryFitText = RivalryFitText;
})(typeof window !== "undefined" ? window : this);
