/* =============================================================================
 * Caster cam layout tests (overlays/shared/rivalry-caster-cams.js)
 * -----------------------------------------------------------------------------
 * The casters scenes and the app's OBS cam placement both read this module,
 * so these rules are what keeps a camera lined up with its hole on air.
 * ===========================================================================*/

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const cams = require("../overlays/shared/rivalry-caster-cams");

const C = (name, extra = {}) => ({ name, role: "", handle: "", stream: "", avatar: "", ...extra });

test("the browser build exposes the same module as the Node build", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "overlays", "shared", "rivalry-caster-cams.js"), "utf8");
  const sandbox = { self: {}, URL };
  vm.runInNewContext(src, sandbox);
  const browser = sandbox.self.RivalryCasterCams;
  assert.ok(browser, "window.RivalryCasterCams must exist in a page");
  assert.deepEqual(JSON.parse(JSON.stringify(browser.RECTS)), JSON.parse(JSON.stringify(cams.RECTS)));
  assert.equal(browser.camCount({ casters: [C("A")] }), 1);
});

test("auto: one cam per named caster, the designed two before anyone is named", () => {
  assert.equal(cams.camCount({ casters: [C("A")] }), 1);
  assert.equal(cams.camCount({ casters: [C("A"), C("B")] }), 2);
  assert.equal(cams.camCount({ casters: [C("A"), C("B"), C("C")] }), 3);
  assert.equal(cams.camCount({ casters: [] }), 2);
  assert.equal(cams.camCount({}), 2);
  assert.equal(cams.camCount(null), 2);
  assert.equal(cams.camCount({ casters: [C(""), C("B")] }), 1, "a blank row never takes a cam");
});

test("a picked cam count wins over the caster count", () => {
  const three = { casters: [C("A"), C("B"), C("C")] };
  assert.equal(cams.camCount({ ...three, casterCams: 1 }), 1);
  assert.equal(cams.camCount({ ...three, casterCams: 2 }), 2);
  assert.equal(cams.camCount({ casters: [C("A")], casterCams: 3 }), 3);
  for (const bad of [0, 4, -1, 1.5, "x", null, undefined]) {
    assert.equal(cams.camCount({ ...three, casterCams: bad }), 3, `casterCams ${bad} reads as auto`);
  }
  assert.equal(cams.camCount({ ...three, casterCams: "2" }), 2, "a numeric string from older payloads still works");
});

test("one shared cam carries every caster's name and the first feed", () => {
  const c = { casterCams: 1, casters: [C("ALEX", { role: "PBP", stream: "" }), C("SAM", { role: "COLOR", stream: "deskcam" })] };
  const s = cams.slots(c);
  assert.equal(s.length, 1);
  assert.equal(s[0].name, "ALEX & SAM");
  assert.equal(s[0].role, "PBP / COLOR");
  assert.equal(s[0].stream, "deskcam", "the first caster with a feed lights the shared cam");
});

test("fewer cams than casters: the last cam takes everyone left over", () => {
  const s = cams.slots({ casterCams: 2, casters: [C("A", { stream: "a" }), C("B", { stream: "b" }), C("C", { stream: "c" })] });
  assert.deepEqual(s.map((x) => x.name), ["A", "B & C"]);
  assert.deepEqual(s.map((x) => x.stream), ["a", "b"]);
});

test("more cams than casters leaves the extra cams empty", () => {
  const s = cams.slots({ casterCams: 3, casters: [C("A", { stream: "a" })] });
  assert.deepEqual(s.map((x) => x.name), ["A", "", ""]);
  assert.deepEqual(s.map((x) => x.stream), ["a", "", ""]);
});

test("an explicit count argument overrides the payload (the ?layout= pin)", () => {
  assert.equal(cams.slots({ casters: [C("A"), C("B")] }, 1).length, 1);
});

test("every overlay has rects for 1, 2 and 3 cams, inside the canvas", () => {
  for (const [id, byCount] of Object.entries(cams.RECTS)) {
    for (const n of [1, 2, 3]) {
      const rects = byCount[n];
      assert.equal(rects.length, n, `${id} n=${n}`);
      for (const r of rects) {
        assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 1920 && r.y + r.h <= 1080, `${id} n=${n} ${JSON.stringify(r)}`);
        assert.ok(Math.abs(r.w / r.h - 16 / 9) < 0.01, `${id} n=${n}: a 16:9 feed must fill the hole`);
      }
    }
  }
});

test("vdoUrl takes VDO.Ninja links and bare stream IDs, nothing else", () => {
  assert.equal(cams.vdoUrl("abc_1-2"), "https://vdo.ninja/?view=abc_1-2&cleanoutput&autostart");
  assert.equal(cams.vdoUrl("https://vdo.ninja/?room=r&view=x&cleanoutput&autostart"), "https://vdo.ninja/?room=r&view=x&cleanoutput&autostart");
  assert.equal(cams.vdoUrl("vdo.ninja/?view=x"), "https://vdo.ninja/?view=x", "the panel's placeholder form, no scheme");
  assert.equal(cams.vdoUrl("http://vdo.ninja/?view=x"), "https://vdo.ninja/?view=x");
  assert.equal(cams.vdoUrl("https://beta.vdo.ninja/?view=x"), "https://beta.vdo.ninja/?view=x");
  for (const bad of ["", "  ", null, undefined, "https://evil.example/?view=x", "https://vdo.ninja.evil.example/",
    "javascript:alert(1)", "file:///C:/x.html", "not a url with spaces"]) {
    assert.equal(cams.vdoUrl(bad), "", String(bad));
  }
});

test("auto never drops the classic look below its two frames; SC26 goes to one", () => {
  const one = { casters: [C("A")] };
  assert.equal(cams.camCount(one, "rivalry-casters"), 2, "cams placed on the duo holes before cam counts existed stay lined up");
  assert.equal(cams.camCount(one, "rivalry-sc26-casters"), 1);
  assert.equal(cams.camCount({ ...one, casterCams: 1 }, "rivalry-casters"), 1, "a single big frame is the explicit pick");
  assert.equal(cams.camCount(one, "toString"), 1, "no prototype keys");
});

test("casters sharing a cam keep their own feeds loaded (heard, not shown), deduped", () => {
  const c = { casterCams: 1, casters: [C("A", { stream: "a" }), C("B", { stream: "b" }), C("C", { stream: "a" })] };
  assert.deepEqual(cams.extraFeeds(c, 1), [{ url: "https://vdo.ninja/?view=b&cleanoutput&autostart", name: "B" }]);
  assert.deepEqual(cams.extraFeeds({ casters: [C("A", { stream: "a" }), C("B", { stream: "b" })] }, 2), [], "everyone on a cam: no extras");
});

test("obs.ninja (VDO.Ninja's old domain) links are moved to vdo.ninja", () => {
  assert.equal(cams.vdoUrl("obs.ninja/?view=x"), "https://vdo.ninja/?view=x");
  assert.equal(cams.vdoUrl("https://beta.obs.ninja/?view=y"), "https://beta.vdo.ninja/?view=y");
  assert.equal(cams.vdoUrl("https://obs.ninja.evil.example/?view=y"), "");
});

test("feedKey: one feed whatever form its link takes", () => {
  const k = cams.feedKey(cams.vdoUrl("deskcam"));
  for (const form of ["vdo.ninja/?view=DeskCam", "https://vdo.ninja/?room=r&view=deskcam&cleanoutput", "obs.ninja/?view=deskcam"]) {
    assert.equal(cams.feedKey(cams.vdoUrl(form)), k, form);
  }
  assert.equal(cams.feedKey("https://evil.example/?view=deskcam"), "");
  assert.equal(cams.feedKey(""), "");
});

test("a shared cam shows the first caster whose link loads; bad links are named", () => {
  const c = { casterCams: 1, casters: [C("A", { stream: "https://youtube.com/x" }), C("B", { stream: "b" })] };
  assert.equal(cams.slots(c)[0].stream, "b");
  assert.deepEqual(cams.badLinks({ casters: [C("A", { stream: "https://youtube.com/x" }), C("", { stream: "zz zz" }), C("B", { stream: "b" }), C("D")] }), ["A"]);
  const same = { casterCams: 1, casters: [C("A", { stream: "deskcam" }), C("B", { stream: "vdo.ninja/?view=deskcam&cleanoutput" })] };
  assert.deepEqual(cams.extraFeeds(same, 1), [], "the same desk feed in another form is not loaded again");
});
