/* The sc26 scene set forks five house scenes (per-folder signing makes a
 * shared module impractical), with the standing rule that ONLY the CSS may
 * differ: every script block, binding attribute and element id must stay
 * byte-identical between a house scene and its sc26 fork. Nothing enforced
 * that rule until now, and it is exactly how a logic fix lands in one copy
 * and silently misses the other. These tests freeze the property: the
 * <script>-onward tail of each fork pair must hash equal.
 *
 * If a pair ever diverges ON PURPOSE, don't loosen the test: fix both copies
 * or record the divergence here with a comment explaining why. */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const OVERLAYS = path.join(__dirname, "..", "overlays");

// house scene id -> sc26 fork id. brb / starting-soon / casters are genuine
// Moldybanana ports with their own code, so they are deliberately absent.
const FORK_PAIRS = {
  "rivalry-gameplay": "rivalry-sc26-gameplay",
  "rivalry-postgame": "rivalry-sc26-postgame",
  "rivalry-chrome": "rivalry-sc26-chrome",
  "rivalry-up-next": "rivalry-sc26-up-next",
  "rivalry-match-preview": "rivalry-sc26-match-preview",
};

function scriptTail(sceneId) {
  const file = path.join(OVERLAYS, sceneId, "index.html");
  const html = fs.readFileSync(file, "utf8");
  const at = html.indexOf("<script");
  assert.ok(at >= 0, `${sceneId}/index.html has no <script> block`);
  return html.slice(at);
}

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

for (const [house, fork] of Object.entries(FORK_PAIRS)) {
  test(`${fork} script tail is byte-identical to ${house}`, () => {
    const a = scriptTail(house);
    const b = scriptTail(fork);
    if (sha256(a) !== sha256(b)) {
      // Find the first differing line so the failure is actionable without
      // hand-diffing two 100KB files.
      const la = a.split("\n"), lb = b.split("\n");
      let i = 0;
      while (i < la.length && i < lb.length && la[i] === lb[i]) i++;
      assert.fail(
        `script sections drifted at line ${i + 1} of the tail:\n` +
        `  ${house}: ${JSON.stringify((la[i] || "<end>").slice(0, 120))}\n` +
        `  ${fork}: ${JSON.stringify((lb[i] || "<end>").slice(0, 120))}\n` +
        `A logic fix must land in BOTH copies (and both re-signed).`
      );
    }
  });
}
