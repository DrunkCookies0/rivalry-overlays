/* =============================================================================
 * RIVALRY app metadata.
 * -----------------------------------------------------------------------------
 * Single source of truth for "what version am I" so the tray menu, control
 * panel header, and any /version HTTP endpoint all show the same string.
 *
 * The build SHA is baked in at CI build time via electron-builder's
 *   -c.extraMetadata.buildSha=<sha>
 * CLI override (see .github/workflows/pr-build.yml). Local dev runs (npm start
 * / npm run mock) fall back to "dev" so we can tell installed builds apart
 * from source-running.
 * ===========================================================================*/

"use strict";

const path = require("path");
const pkg = require(path.join(__dirname, "..", "package.json"));

function shortSha(sha) {
  if (!sha || sha === "dev") return "dev";
  return sha.length > 7 ? sha.substring(0, 7) : sha;
}

function getMeta(isBeta) {
  const sha = pkg.buildSha || process.env.BUILD_SHA || "dev";
  const shaShort = shortSha(sha);
  const channel = isBeta ? "beta" : "stable";
  // Only suffix "-beta" when the version doesn't already carry a prerelease
  // tag. CI bakes versions like "0.2.0-beta.21" via extraMetadata, so adding
  // another "-beta" yielded "v0.2.0-beta.21-beta" in tray + control panel.
  const needsBetaSuffix = isBeta && !/-/.test(pkg.version);
  return {
    version: pkg.version,
    sha,
    shaShort,
    channel,
    label: `v${pkg.version}${needsBetaSuffix ? "-beta" : ""} (${shaShort})`,
  };
}

module.exports = { getMeta };
