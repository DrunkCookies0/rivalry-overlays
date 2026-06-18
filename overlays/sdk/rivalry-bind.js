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

  function apply(root, data) {
    root.querySelectorAll("[data-field]").forEach(function (el) {
      var v = resolve(data, el.getAttribute("data-field"));
      if (v != null && v !== "") el.textContent = String(v);
      // leave the markup's default text in place when a field is absent/empty
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
      rl.onControl(function (payload) { apply(root, payload || {}); });
    } else if (oneShot) {
      apply(root, oneShot);
    }
    return { apply: function (d) { apply(root, d); } };
  };
})(typeof window !== "undefined" ? window : this);
