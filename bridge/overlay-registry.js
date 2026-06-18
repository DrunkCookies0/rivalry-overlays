/* =============================================================================
 * RIVALRY Overlay Registry + serve-time gate
 * -----------------------------------------------------------------------------
 * Scans the overlays/ tree once, verifies each overlay's signature against the
 * public key (caching the result), and decides how the HTTP server should treat
 * a /overlays/... request. This is the runtime half of the curated/signed gate
 * (the authoring half is bridge/overlay-signing.js + the CLIs).
 *
 * Used by main.js. Kept dependency-light + pure so it can be unit-tested without
 * Electron.
 *
 * Gate semantics:
 *   - PRODUCTION (packaged app): a scene folder is served ONLY if its signature
 *     verifies (approved). When serving an approved scene's ENTRY html we inject
 *     `window.__RIVALRY_SIGNED__=true` into the RESPONSE BYTES (the file on disk
 *     is untouched, so the signature stays valid) — that's what suppresses the
 *     SDK's "PREVIEW — NOT APPROVED" badge.
 *   - DEV (unpacked / RIVALRY_DEV): everything serves, nothing is injected, so
 *     unsigned work-in-progress shows the PREVIEW badge. Designers get a full
 *     loop; nothing unapproved can reach a production broadcast.
 *   - The shared runtime (overlays/sdk, overlays/shared) always serves; the
 *     signing keys (overlays/keys) are never served over HTTP.
 * ===========================================================================*/

"use strict";

const fs = require("fs");
const path = require("path");
const { verifyOverlay } = require("./overlay-signing");

// Folders under overlays/ that are NOT scenes (skip when scanning).
const NON_SCENE_DIRS = new Set(["sdk", "shared", "keys"]);

// Scan <overlaysDir> for scene folders (each has a manifest.json), verify each
// once, and return a cached registry. publicKeyPem may be null (no key yet) ->
// everything is "unapproved" with a clear reason (safe default in prod).
function scanOverlays(overlaysDir, publicKeyPem) {
  const list = [];
  let dirents = [];
  try {
    dirents = fs.readdirSync(overlaysDir, { withFileTypes: true });
  } catch (e) {
    return { list, byFolder: {}, scannedAt: null, hasKey: !!publicKeyPem };
  }

  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    if (d.name.startsWith("_")) continue; // _template, _prototype, etc.
    if (NON_SCENE_DIRS.has(d.name)) continue;

    const dir = path.join(overlaysDir, d.name);
    const manifestPath = path.join(dir, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (e) {
      // one malformed manifest must not break the whole registry
      list.push({ folder: d.name, id: d.name, name: d.name, scene: "", needs: [], version: "",
        entry: "index.html", approved: false, reason: "manifest.json not valid JSON", keyId: null,
        url: null });
      continue;
    }

    let approved = false, reason = "no signing key loaded", keyId = null;
    if (publicKeyPem) {
      try {
        const v = verifyOverlay(dir, publicKeyPem);
        approved = v.approved; reason = v.reason; keyId = v.keyId || null;
      } catch (e) {
        approved = false; reason = "verify error: " + e.message;
      }
    }

    const entry = manifest.entry || "index.html";
    list.push({
      folder: d.name,
      id: manifest.id || d.name,
      name: manifest.name || manifest.id || d.name,
      scene: manifest.scene || "",
      needs: Array.isArray(manifest.needs) ? manifest.needs : [],
      version: manifest.version || "",
      entry,
      approved,
      reason,
      keyId,
      url: `/overlays/${d.name}/${entry}`,
    });
  }

  list.sort((a, b) => a.scene.localeCompare(b.scene) || a.name.localeCompare(b.name));
  const byFolder = {};
  for (const e of list) byFolder[e.folder] = e;
  return { list, byFolder, scannedAt: new Date().toISOString(), hasKey: !!publicKeyPem };
}

// Classify a /overlays/... request against the registry. Returns one of:
//   { kind: 'passthrough' }            not an /overlays/ path — handle normally
//   { kind: 'shared' }                 overlays/sdk|shared/* — always serve
//   { kind: 'deny', reason }           keys, unknown folder, or unapproved-in-prod
//   { kind: 'scene', folder, isEntry } serve this scene file (inject flag if isEntry+prod)
function classifyOverlayRequest(urlPath, registry, isProd) {
  const PREFIX = "/overlays/";
  if (!urlPath.startsWith(PREFIX)) return { kind: "passthrough" };

  const rest = urlPath.slice(PREFIX.length);
  const seg = rest.split("/")[0];
  if (!seg) return { kind: "passthrough" };

  if (seg === "keys") return { kind: "deny", reason: "keys are not web-served" };
  if (seg === "sdk" || seg === "shared") return { kind: "shared" };

  const e = registry.byFolder[seg];
  if (!e) return { kind: "deny", reason: "no such overlay" };
  if (isProd && !e.approved) return { kind: "deny", reason: "unapproved: " + e.reason };

  const fileRel = rest.slice(seg.length + 1); // path within the folder ('' => entry)
  const isEntry = fileRel === "" || fileRel === e.entry;
  return { kind: "scene", folder: seg, approved: e.approved, isEntry };
}

// Inject the signed flag into the response bytes of an approved entry HTML.
// Disk file is never modified, so the signature (computed over disk bytes) holds.
function injectSignedFlag(html) {
  const tag = "<script>window.__RIVALRY_SIGNED__=true;</script>";
  const head = html.match(/<head[^>]*>/i);
  if (head) {
    const at = html.indexOf(head[0]) + head[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  const htmlTag = html.match(/<html[^>]*>/i);
  if (htmlTag) {
    const at = html.indexOf(htmlTag[0]) + htmlTag[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  return tag + html;
}

module.exports = { scanOverlays, classifyOverlayRequest, injectSignedFlag, NON_SCENE_DIRS };
