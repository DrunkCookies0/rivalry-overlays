/* =============================================================================
 * RIVALRY render-verify: the local proof-gate before every push
 * -----------------------------------------------------------------------------
 * `npm run verify:render` boots the REAL app in mock mode, loads every overlay
 * scene headlessly (Playwright chromium), and fails loudly on regressions:
 *
 *   0. Signature preflight: every overlays/rivalry-* folder must verify against
 *      overlays/keys/rivalry-overlay-public.pem (catches forgotten re-signs
 *      before anything else runs).
 *   1. Boot: spawn electron . --mock, poll /status.json until 200 (30s).
 *   2. For every scene in /overlays/registry.json:
 *        - page loads with zero console/page errors (see allowlist)
 *        - the SDK's PREVIEW badge is present on a dev-mode serve
 *        - a per-scene key element (SCENE_CHECKS) is visible under mock data
 *        - with window.__RIVALRY_SIGNED__=true pre-set, the badge is ABSENT
 *        - screenshot saved to .verify/<id>.png (gitignored)
 *   3. Every scene also renders at 1280x720, 2560x1440 and 1920x1200 (16:10):
 *      key element visible, console clean, screenshot per resolution.
 *   4. rivalry-gameplay must play its FULL goal sequence under the app mock
 *      feed (flash -> banner -> replay card -> stinger -> kickoff count) at
 *      1080p; pass --full (or RIVALRY_VERIFY_FULL=1) to prove it at every
 *      resolution. --full is mandatory after any gameplay layout change.
 *   5. control/control.html renders scene rows from the registry, error-free.
 *   6. control/setup.html (if it exists) reaches its feed-is-live state.
 *
 * Exit 0 only if every check passes. No deps beyond playwright + node builtins.
 * ===========================================================================*/

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const { spawn, execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const { verifyOverlay } = require(path.join(REPO_ROOT, "bridge", "overlay-signing"));
const { chromium } = require(path.join(REPO_ROOT, "node_modules", "playwright"));

// ---------------------------------------------------------------------------
// Tunables + per-scene knowledge (keep everything scene-specific HERE)
// ---------------------------------------------------------------------------

const HTTP_PORT = 49080;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const BOOT_TIMEOUT_MS = 30000;
const MOCK_SETTLE_MS = 2500; // let the SDK mock feed populate the scene
const RES_SETTLE_MS = 1500; // shorter settle for the extra-resolution sweep
const SETUP_LIVE_TIMEOUT_MS = 15000;

// Functional checks (badge, key element, console) run once at BASE_VIEWPORT.
// Every scene is ALSO rendered at each EXTRA_RESOLUTIONS entry (key element
// visible + console clean + screenshot) because OBS canvases are not all
// 1080p: 720p and 1440p streams and 16:10 monitors are real setups.
const BASE_VIEWPORT = { width: 1920, height: 1080 };
const EXTRA_RESOLUTIONS = [
  { width: 1280, height: 720 },
  { width: 2560, height: 1440 },
  { width: 1920, height: 1200 }, // 16:10
];

// --full additionally runs the gameplay goal-sequence capture at every
// resolution instead of only 1080p. Slow (one mock goal cycle per resolution);
// mandatory after any gameplay layout change, skippable day to day.
const FULL_MODE = process.argv.includes("--full") || process.env.RIVALRY_VERIFY_FULL === "1";
const VERIFY_DIR = path.join(REPO_ROOT, ".verify");
const PUBLIC_KEY_PATH = path.join(REPO_ROOT, "overlays", "keys", "rivalry-overlay-public.pem");

// The SDK's previewBadge() stamps this element (overlays/sdk/rivalry-overlay-sdk.js).
// Suppressed only when window.__RIVALRY_SIGNED__ === true.
const BADGE_SELECTOR = "#rivalry-preview-badge";

// Console/page errors that are known-acceptable noise. Empty on purpose:
// add a string (substring match) or RegExp ONLY with a comment saying why.
const CONSOLE_ERROR_ALLOWLIST = [];

// One key element per scene that must be VISIBLE once mock data settles.
// Selectors were derived from each overlays/rivalry-*/index.html.
// sdkBadge:false marks a scene that does not load the overlay SDK (raw-socket
// overlay), so the PREVIEW badge assertions do not apply to it.
const SCENE_CHECKS = {
  "rivalry-gameplay": {
    selector: ".scorebar",
    description: "scorebar container",
    sdkBadge: false, // shipped overlay: own socket code, no SDK, no badge
  },
  "rivalry-chrome": { selector: ".ticker", description: "bottom ticker bar" },
  "rivalry-match-preview": { selector: ".mp-name", description: "team name node" },
  "rivalry-starting-soon": { selector: ".ss-name", description: "team name node" },
  "rivalry-up-next": { selector: ".un-list", description: "up-next match list" },
  "rivalry-casters": { selector: ".cs-frame", description: "caster cam frame" },
  "rivalry-postgame": { selector: ".pg-boards", description: "team stat boards" },
  "rivalry-brb": { selector: ".brb-title", description: "BE RIGHT BACK title" },
};

// ---------------------------------------------------------------------------
// Check collector + summary table
// ---------------------------------------------------------------------------

const results = [];

async function runCheck(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || "", ms: Date.now() - t0 });
    return true;
  } catch (e) {
    const detail = e && e.message ? e.message : String(e);
    results.push({ name, ok: false, detail, ms: Date.now() - t0 });
    return false;
  }
}

function recordSkip(name, why) {
  results.push({ name, ok: true, detail: why, ms: 0, skipped: true });
}

function printTable(rows, headers) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i]).length))
  );
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  console.log(line(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(r));
}

function printSummary() {
  console.log("\n=== render-verify summary ===============================================");
  printTable(
    results.map((r) => [
      r.skipped ? "SKIP" : r.ok ? "PASS" : "FAIL",
      r.name,
      String(r.detail).replace(/\s+/g, " ").slice(0, 90),
      r.ms + "ms",
    ]),
    ["STATUS", "CHECK", "DETAIL", "TIME"]
  );
  const fails = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length} checks, ${results.filter((r) => r.ok).length} passed, ${fails.length} failed`
  );
  if (fails.length) {
    console.log("\nFailures in full:");
    for (const f of fails) console.log(`  [FAIL] ${f.name}\n         ${f.detail}`);
  }
}

// ---------------------------------------------------------------------------
// 0. Signature preflight (before the app even boots)
// ---------------------------------------------------------------------------

function preflightSignatures() {
  const overlaysDir = path.join(REPO_ROOT, "overlays");
  const pem = fs.readFileSync(PUBLIC_KEY_PATH, "utf8");
  const rows = [];
  for (const d of fs.readdirSync(overlaysDir, { withFileTypes: true })) {
    if (!d.isDirectory() || !d.name.startsWith("rivalry-")) continue;
    const dir = path.join(overlaysDir, d.name);
    if (!fs.existsSync(path.join(dir, "manifest.json"))) continue;
    let v;
    try {
      v = verifyOverlay(dir, pem);
    } catch (e) {
      v = { approved: false, reason: "verify error: " + e.message };
    }
    rows.push({ folder: d.name, approved: v.approved, reason: v.reason, keyId: v.keyId || "" });
  }

  console.log("Signature preflight (public key: overlays/keys/rivalry-overlay-public.pem)\n");
  printTable(
    rows.map((r) => [r.approved ? "APPROVED" : "UNAPPROVED", r.folder, r.reason, r.keyId]),
    ["STATE", "OVERLAY", "REASON", "KEY"]
  );
  console.log("");

  const bad = rows.filter((r) => !r.approved);
  if (bad.length) {
    throw new Error(
      "unapproved overlays (re-sign before pushing): " +
        bad.map((r) => `${r.folder} (${r.reason})`).join("; ")
    );
  }
  if (rows.length === 0) throw new Error("no overlays/rivalry-* folders with a manifest.json found");
  return `${rows.length}/${rows.length} approved`;
}

// ---------------------------------------------------------------------------
// App lifecycle: spawn electron --mock, wait for /status.json, tree-kill
// ---------------------------------------------------------------------------

// Throwaway Electron profile for this run, so results never depend on state
// left behind by a previous session (see spawnApp).
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rivalry-verify-"));

function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    sock.setTimeout(1500);
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => resolve(false));
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
  });
}

// Prefer the real dist binary (node_modules/electron resolves to the exe path
// when required from plain node). The .bin shim is a .cmd on Windows and needs
// shell:true on modern Node; npx.cmd is the last resort.
function resolveElectron() {
  try {
    const p = require(path.join(REPO_ROOT, "node_modules", "electron"));
    if (typeof p === "string" && fs.existsSync(p)) return { cmd: p, args: [], shell: false };
  } catch (e) { /* fall through */ }
  const bin = path.join(
    REPO_ROOT, "node_modules", ".bin",
    process.platform === "win32" ? "electron.cmd" : "electron"
  );
  if (fs.existsSync(bin)) return { cmd: bin, args: [], shell: process.platform === "win32" };
  return {
    cmd: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["electron"],
    shell: process.platform === "win32",
  };
}

const appOutput = []; // rolling tail of app stdout/stderr for boot diagnostics
function outputTail() {
  return appOutput.slice(-25).join("\n");
}

function spawnApp() {
  // Machine gotcha: ELECTRON_RUN_AS_NODE=1 in the shell env makes the electron
  // binary boot as plain node and the app never starts. Strip it for the child.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const e = resolveElectron();
  // Hermetic profile. Without this the harness inherits whatever is in the
  // developer's real userData — a retained control payload from an earlier
  // session can point a team logo at /league/logo for a match this run has no
  // key for, and the scene fails a "console clean" check for reasons that have
  // nothing to do with the code under test. (That exact false failure is why
  // this is here.)
  const child = spawn(e.cmd, [...e.args, ".", "--mock", `--user-data-dir=${userDataDir}`], {
    env,
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    shell: e.shell,
  });
  const collect = (buf) => {
    for (const line of buf.toString().split(/\r?\n/)) {
      if (line.trim()) appOutput.push(line);
    }
    if (appOutput.length > 200) appOutput.splice(0, appOutput.length - 200);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  return child;
}

function killApp(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      // taskkill /T takes the whole electron process tree down
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  } catch (e) { /* already gone */ }
}

function httpGet(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("http timeout")));
    req.on("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForBoot(child) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(
        `electron exited early (code ${child.exitCode})\n--- app output tail ---\n${outputTail()}`
      );
    }
    try {
      const r = await httpGet(`${BASE}/status.json`, 2000);
      if (r.status === 200) return;
    } catch (e) { /* not up yet */ }
    if (Date.now() > deadline) {
      throw new Error(
        `/status.json never returned 200 within ${BOOT_TIMEOUT_MS}ms\n--- app output tail ---\n${outputTail()}`
      );
    }
    await sleep(500);
  }
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function openPage(browser, url, { initScript, viewport } = {}) {
  const context = await browser.newContext({ viewport: viewport || BASE_VIEWPORT });
  if (initScript) await context.addInitScript(initScript);
  const page = await context.newPage();
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) =>
    errors.push("pageerror: " + (err && err.message ? err.message : String(err)))
  );
  await page.goto(url, { waitUntil: "load", timeout: 15000 });
  // FontFaceSet is not serializable; map to a boolean before returning.
  await page.evaluate(() => document.fonts.ready.then(() => true));
  return { context, page, errors };
}

function unexpectedErrors(errors) {
  return errors.filter(
    (e) =>
      !CONSOLE_ERROR_ALLOWLIST.some((rule) =>
        rule instanceof RegExp ? rule.test(e) : e.includes(rule)
      )
  );
}

function assertNoErrors(errors, where) {
  const bad = unexpectedErrors(errors);
  if (bad.length) {
    throw new Error(`${bad.length} console/page error(s) on ${where}: ${bad.join(" | ")}`);
  }
}

// ---------------------------------------------------------------------------
// 2. Per-scene checks
// ---------------------------------------------------------------------------

async function checkScene(browser, entry) {
  const cfg = SCENE_CHECKS[entry.id];
  const url = `${BASE}${entry.url}?mock=1`;

  let opened = null;
  const loaded = await runCheck(`${entry.id} | load, mock settle, console clean`, async () => {
    opened = await openPage(browser, url);
    await opened.page.waitForTimeout(MOCK_SETTLE_MS);
    await opened.page.screenshot({ path: path.join(VERIFY_DIR, `${entry.id}.png`) });
    assertNoErrors(opened.errors, entry.url);
    return `screenshot .verify/${entry.id}.png`;
  });
  if (!loaded || !opened) {
    if (opened) await opened.context.close().catch(() => {});
    return; // dependent checks are meaningless on a dead page
  }

  await runCheck(`${entry.id} | key element visible`, async () => {
    const loc = opened.page.locator(cfg.selector).first();
    await loc.waitFor({ state: "visible", timeout: 5000 });
    return `${cfg.selector} (${cfg.description})`;
  });

  if (cfg.sdkBadge === false) {
    recordSkip(
      `${entry.id} | PREVIEW badge present`,
      "n/a: scene does not use the SDK (raw sockets, no badge)"
    );
    recordSkip(`${entry.id} | badge suppressed when signed`, "n/a: no SDK badge on this scene");
    await opened.context.close();
    return;
  }

  await runCheck(`${entry.id} | PREVIEW badge present (unsigned serve)`, async () => {
    const badge = opened.page.locator(BADGE_SELECTOR);
    await badge.waitFor({ state: "visible", timeout: 5000 });
    const text = (await badge.textContent()) || "";
    if (!text.includes("PREVIEW") || !text.includes("NOT APPROVED")) {
      throw new Error(`badge text unexpected: "${text}"`);
    }
    return `"${text.trim()}"`;
  });
  await opened.context.close();

  await runCheck(`${entry.id} | badge suppressed when signed`, async () => {
    const signed = await openPage(browser, url, {
      // Mirrors the production loader: main.js injects this flag into the
      // response bytes of an approved entry. The SDK must then NOT stamp.
      initScript: () => { window.__RIVALRY_SIGNED__ = true; },
    });
    try {
      await signed.page.waitForTimeout(1500); // badge stamps on DOMContentLoaded
      const n = await signed.page.locator(BADGE_SELECTOR).count();
      if (n !== 0) throw new Error("PREVIEW badge still present with __RIVALRY_SIGNED__=true");
      return "badge absent";
    } finally {
      await signed.context.close();
    }
  });
}

// ---------------------------------------------------------------------------
// 2b. Extra-resolution sweep (every scene) + goal-sequence capture (gameplay)
// ---------------------------------------------------------------------------

async function checkSceneAtResolution(browser, entry, viewport) {
  const cfg = SCENE_CHECKS[entry.id];
  const tag = `${viewport.width}x${viewport.height}`;
  await runCheck(`${entry.id} | renders at ${tag}`, async () => {
    const opened = await openPage(browser, `${BASE}${entry.url}?mock=1`, { viewport });
    try {
      await opened.page.waitForTimeout(RES_SETTLE_MS);
      const loc = opened.page.locator(cfg.selector).first();
      await loc.waitFor({ state: "visible", timeout: 5000 });
      await opened.page.screenshot({ path: path.join(VERIFY_DIR, `${entry.id}@${tag}.png`) });
      assertNoErrors(opened.errors, `${entry.url} @ ${tag}`);
      return `screenshot .verify/${entry.id}@${tag}.png`;
    } finally {
      await opened.context.close();
    }
  });
}

// The app-level mock feed (--mock) replays the canonical goal sequence on a
// ~20s cycle with live-capture timings, so the full sequence is observable:
// goal flash -> goal banner -> replay card -> stinger wipe -> kickoff count.
// A 100ms in-page sampler records first-seen times (some states, like the
// stinger, are too brief to catch reliably from the driver side) and the
// driver loop screenshots whichever states are currently on screen.
const GOAL_SEQ_STATES = [
  { key: "flash", selector: ".goal-flash.show", label: "goal flash" },
  { key: "banner", selector: ".goal-banner.show", label: "goal banner" },
  { key: "card", selector: ".replay-card.show", label: "replay card" },
  { key: "stinger", selector: ".stinger.run", label: "stinger wipe" },
  { key: "kickoff", selector: ".kickoff-count.show", label: "kickoff countdown" },
];
const GOAL_SEQ_TIMEOUT_MS = 70000; // two mock goal cycles + slack

async function checkGoalSequence(browser, entry, viewport) {
  const tag = `${viewport.width}x${viewport.height}`;
  await runCheck(`${entry.id} | full goal sequence @ ${tag}`, async () => {
    const opened = await openPage(browser, `${BASE}${entry.url}?mock=1`, {
      viewport,
      initScript: `(() => {
        const SEL = ${JSON.stringify(GOAL_SEQ_STATES.map(({ key, selector }) => ({ key, selector })))};
        window.__rvSeq = {};
        setInterval(() => {
          for (const s of SEL) {
            if (!(s.key in window.__rvSeq) && document.querySelector(s.selector)) {
              window.__rvSeq[s.key] = Math.round(performance.now());
            }
          }
        }, 100);
      })()`,
    });
    try {
      const shot = new Set();
      const deadline = Date.now() + GOAL_SEQ_TIMEOUT_MS;
      for (;;) {
        const now = await opened.page.evaluate((states) => {
          const active = [];
          for (const s of states) if (document.querySelector(s.selector)) active.push(s.key);
          return { seen: window.__rvSeq || {}, active };
        }, GOAL_SEQ_STATES.map(({ key, selector }) => ({ key, selector })));
        for (const key of now.active) {
          if (!shot.has(key)) {
            shot.add(key);
            await opened.page.screenshot({
              path: path.join(VERIFY_DIR, `goalseq-${key}@${tag}.png`),
            });
          }
        }
        const missing = GOAL_SEQ_STATES.filter((s) => !(s.key in now.seen));
        if (missing.length === 0) break;
        if (Date.now() > deadline) {
          throw new Error(
            `goal-sequence states never appeared within ${GOAL_SEQ_TIMEOUT_MS}ms: ` +
              missing.map((s) => `${s.label} (${s.selector})`).join(", ")
          );
        }
        await sleep(200);
      }
      assertNoErrors(opened.errors, `${entry.url} goal sequence @ ${tag}`);
      const seen = await opened.page.evaluate(() => window.__rvSeq);
      const order = Object.entries(seen).sort((a, b) => a[1] - b[1]).map(([k]) => k);
      return `all 5 states observed (${order.join(" -> ")}), ${shot.size} screenshots`;
    } finally {
      await opened.context.close();
    }
  });
}

// ---------------------------------------------------------------------------
// 3./4. Control panel + setup wizard
// ---------------------------------------------------------------------------

async function checkControlPanel(browser, registryCount) {
  await runCheck("control.html | scenes card renders registry rows", async () => {
    const opened = await openPage(browser, `${BASE}/control/control.html`);
    try {
      // renderScenes() fills #sceneList with .scene-row elements from
      // /overlays/registry.json (see control/control.html).
      await opened.page
        .locator("#sceneList .scene-row")
        .first()
        .waitFor({ state: "visible", timeout: 8000 });
      const rows = await opened.page.locator("#sceneList .scene-row").count();
      if (rows < registryCount) {
        throw new Error(`scenes card shows ${rows} rows, registry has ${registryCount}`);
      }
      await opened.page.screenshot({ path: path.join(VERIFY_DIR, "control.png") });
      assertNoErrors(opened.errors, "/control/control.html");
      return `${rows} scene rows`;
    } finally {
      await opened.context.close();
    }
  });
}

async function checkSetupPage(browser) {
  const setupPath = path.join(REPO_ROOT, "control", "setup.html");
  if (!fs.existsSync(setupPath)) {
    recordSkip("setup.html | feed-live state", "SKIPPED: control/setup.html does not exist yet");
    return;
  }
  await runCheck("setup.html | reaches feed-live state under mock", async () => {
    const opened = await openPage(browser, `${BASE}/control/setup.html`);
    try {
      // Being built in parallel, so detect the green state loosely: prefer a
      // data-state marker, fall back to visible "feed is live"-ish text.
      // Tighten to the real markers once setup.html stabilizes.
      const deadline = Date.now() + SETUP_LIVE_TIMEOUT_MS;
      for (;;) {
        const live = await opened.page.evaluate(() => {
          if (document.querySelector('[data-state="live"], [data-state="ok"], [data-state="connected"]')) return true;
          const txt = document.body ? document.body.innerText : "";
          return /rocket league feed is live|feed is live/i.test(txt);
        });
        if (live) break;
        if (Date.now() > deadline) {
          throw new Error(`no feed-live state within ${SETUP_LIVE_TIMEOUT_MS}ms under mock`);
        }
        await opened.page.waitForTimeout(500);
      }
      await opened.page.screenshot({ path: path.join(VERIFY_DIR, "setup.png") });
      assertNoErrors(opened.errors, "/control/setup.html");
      return "feed reported live";
    } finally {
      await opened.context.close();
    }
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`RIVALRY render-verify | ${new Date().toISOString()}\n`);

  // 0. Signatures first: cheapest check, and nothing else matters if a scene
  //    was edited after signing.
  const sigOk = await runCheck("signature preflight (all rivalry-* approved)", preflightSignatures);
  if (!sigOk) {
    printSummary();
    process.exit(1);
  }

  // Guard: a stale instance holding 49080 would make every check lie.
  if (await portInUse(HTTP_PORT)) {
    console.error(
      `\nport ${HTTP_PORT} is already in use: another instance is running, close it first`
    );
    process.exit(1);
  }

  fs.mkdirSync(VERIFY_DIR, { recursive: true });

  let child = null;
  let browser = null;
  try {
    child = spawnApp();
    // Safety net: never leave a stray electron behind, even on hard crashes.
    process.once("exit", () => killApp(child));

    const booted = await runCheck("app boots (--mock) and serves /status.json", async () => {
      await waitForBoot(child);
      return `pid ${child.pid}`;
    });
    if (!booted) {
      printSummary();
      process.exit(1);
    }

    const reg = JSON.parse((await httpGet(`${BASE}/overlays/registry.json`)).body);
    const overlays = Array.isArray(reg.overlays) ? reg.overlays : [];

    // Keep SCENE_CHECKS and the registry honest against each other: a scene
    // without a check is an untested scene; a check without a scene is a
    // renamed/removed scene this script no longer covers.
    await runCheck("registry <-> SCENE_CHECKS coverage", async () => {
      const regIds = overlays.map((o) => o.id);
      const missing = regIds.filter((id) => !SCENE_CHECKS[id]);
      const stale = Object.keys(SCENE_CHECKS).filter((id) => !regIds.includes(id));
      if (missing.length) throw new Error(`no SCENE_CHECKS entry for: ${missing.join(", ")}`);
      if (stale.length) throw new Error(`SCENE_CHECKS has unknown scene(s): ${stale.join(", ")}`);
      if (regIds.length === 0) throw new Error("registry returned zero overlays");
      return `${regIds.length} scenes`;
    });

    browser = await chromium.launch();
    for (const o of overlays) {
      if (!SCENE_CHECKS[o.id]) continue; // already failed the coverage check
      await checkScene(browser, o);
      for (const res of EXTRA_RESOLUTIONS) {
        await checkSceneAtResolution(browser, o, res);
      }
    }

    // Goal-sequence proof: 1080p always; every resolution under --full
    // (mandatory after any gameplay layout change).
    const gameplay = overlays.find((o) => o.id === "rivalry-gameplay");
    if (gameplay) {
      const seqResolutions = FULL_MODE
        ? [BASE_VIEWPORT, ...EXTRA_RESOLUTIONS]
        : [BASE_VIEWPORT];
      for (const res of seqResolutions) {
        await checkGoalSequence(browser, gameplay, res);
      }
      if (!FULL_MODE) {
        recordSkip(
          "rivalry-gameplay | goal sequence at extra resolutions",
          "run with --full after gameplay layout changes"
        );
      }
    }

    await checkControlPanel(browser, overlays.length);
    await checkSetupPage(browser);
  } catch (e) {
    results.push({
      name: "render-verify run",
      ok: false,
      detail: e && e.stack ? e.stack : String(e),
      ms: 0,
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
    killApp(child);
  }

  printSummary();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main();
