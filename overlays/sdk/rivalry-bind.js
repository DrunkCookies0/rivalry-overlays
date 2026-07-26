/* =============================================================================
 * RIVALRY Bind  v1  —  declarative control-data binding for overlay scenes
 * -----------------------------------------------------------------------------
 * A tiny companion to the SDK. Mark up your scene with data-* hooks and call
 * RivalryBind(root, rl) once; it keeps the DOM in sync with the control bus
 * (and, on file://, the SDK's built-in mock) with zero per-field wiring.
 *
 *   <span data-field="teamA.name">GUARDIANS</span>      <!-- textContent -->
 *   <div  data-bg="teamA.logo"><span data-mono="teamA.name">G</span></div>
 *   <div  data-slot="upNext.2">...</div>                <!-- hidden if empty -->
 *
 * Paths resolve against the control payload (see ../CONTRACT.md). Keep sensible
 * default text in the markup so the scene looks complete before data arrives.
 *
 *   const rl = RivalryOverlay.connect({ game: false });   // control-only scene
 *   RivalryBind(document.querySelector('.scene-root'), rl);
 * ===========================================================================*/

(function (global) {
  "use strict";

  function resolve(obj, path) {
    return path.split(".").reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj);
  }

  // True when the control payload actually carries the group this field belongs
  // to — i.e. the producer owns it and has left it blank, as opposed to the
  // scene binding something the control feed never sends.
  //
  // This is the difference between two very different situations:
  //   teamA.tag         -> payload.teamA exists, tag is blank  -> render blank
  //   brand.leagueName  -> payload has no brand at all         -> keep "RIVALRY"
  //
  // Without the distinction, a blank field broadcasts the designer's mock text:
  // a 3v3 Europe match went out with "NA" on both teams because the producer
  // had left the region tag empty. Clearing everything instead wiped the league
  // wordmark off the scene. Only the owned-and-blank case gets cleared.
  function ownedByPayload(data, path) {
    var parts = path.split(".");
    if (parts.length === 1) return data != null && typeof data === "object";
    var parent = resolve(data, parts.slice(0, -1).join("."));
    return parent != null && typeof parent === "object";
  }

  function apply(root, data, live) {
    root.querySelectorAll("[data-field]").forEach(function (el) {
      var path = el.getAttribute("data-field");
      var v = resolve(data, path);
      if (v != null && v !== "") {
        el.textContent = String(v);
        if (el.dataset.rvCleared) { el.style.display = el.dataset.rvDisplay || ""; delete el.dataset.rvCleared; }
      } else if (live && ownedByPayload(data, path)) {
        // Hidden as well as emptied: a chip or pill with padding still paints a
        // visible sliver when its text is removed.
        if (!el.dataset.rvCleared) {
          el.dataset.rvDisplay = el.style.display || "";
          el.dataset.rvCleared = "1";
        }
        el.textContent = "";
        el.style.display = "none";
      }
    });
    root.querySelectorAll("[data-mono]").forEach(function (el) {
      var v = resolve(data, el.getAttribute("data-mono"));
      if (v) el.textContent = String(v).trim().charAt(0).toUpperCase();
    });
    root.querySelectorAll("[data-bg]").forEach(function (el) {
      var v = resolve(data, el.getAttribute("data-bg"));
      var monos = el.querySelectorAll("[data-mono]");
      if (v) {
        el.style.backgroundImage = 'url("' + v + '")';
        el.style.backgroundSize = "contain";
        el.style.backgroundPosition = "center";
        el.style.backgroundRepeat = "no-repeat";
        monos.forEach(function (m) { m.style.display = "none"; });
      } else {
        el.style.backgroundImage = "";
        monos.forEach(function (m) { m.style.display = ""; });
      }
    });
    root.querySelectorAll("[data-slot]").forEach(function (el) {
      var v = resolve(data, el.getAttribute("data-slot"));
      var empty = v == null || v === "" || (typeof v === "object" && Object.keys(v).every(function (k) { return !v[k]; }));
      el.style.display = empty ? "none" : "";
    });
  }

  // RivalryBind(root, rl): bind to a connected SDK instance's control feed.
  // RivalryBind(root, null, payload): one-shot bind to a plain object (testing).
  global.RivalryBind = function (root, rl, oneShot) {
    if (!root) return;
    if (rl && typeof rl.onControl === "function") {
      rl.onControl(function (payload) { apply(root, payload || {}, true); });
    } else if (oneShot) {
      apply(root, oneShot, true);
    }
    return { apply: function (d) { apply(root, d, true); } };
  };
})(typeof window !== "undefined" ? window : this);
