/* =============================================================================
 * build-icons.js: app icons from the brand's avatar master
 * -----------------------------------------------------------------------------
 *     node tools/build-icons.js
 *
 * Rasterizes assets/brand/avatar-dark.svg with Playwright's Chromium (already a
 * dev dependency) and writes:
 *   build/icon.ico   installer, uninstaller and exe icon: 16 to 256 px, PNG entries
 *                    (the same layout the previous icon.ico used)
 *   assets/tray.png  64 px; main.js scales it to 16 for the tray and uses it as
 *                    the window and notification icon
 *
 * The avatar (symbol on a Coal square) is the brand's stand-in for small sizes:
 * a symbol tuned for 16 px is still an open brand item. Re-run this after the
 * avatar master changes.
 * ===========================================================================*/

"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "assets", "brand", "avatar-dark.svg");
const ICO = path.join(ROOT, "build", "icon.ico");
const TRAY = path.join(ROOT, "assets", "tray.png");
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const TRAY_SIZE = 64;

// ICONDIR + one ICONDIRENTRY per image, then the PNG bytes back to back.
function packIco(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // type 1 = icon
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const o = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, o); // 0 means 256
    head.writeUInt8(size >= 256 ? 0 : size, o + 1);
    head.writeUInt8(0, o + 2); // no palette
    head.writeUInt8(0, o + 3);
    head.writeUInt16LE(1, o + 4); // planes
    head.writeUInt16LE(32, o + 6); // bits per pixel
    head.writeUInt32LE(data.length, o + 8);
    head.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.data)]);
}

async function main() {
  // base64 on the Node side: the master's <title> isn't Latin-1, which btoa() rejects
  const svg64 = fs.readFileSync(SRC).toString("base64");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const render = (size) => page.evaluate(async ({ svg64, size }) => {
      const img = new Image();
      img.src = "data:image/svg+xml;base64," + svg64;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = size;
      c.height = size;
      const x = c.getContext("2d");
      x.imageSmoothingQuality = "high";
      x.drawImage(img, 0, 0, size, size);
      return c.toDataURL("image/png").split(",")[1];
    }, { svg64, size });
    const pngs = [];
    for (const size of ICO_SIZES) pngs.push({ size, data: Buffer.from(await render(size), "base64") });
    fs.writeFileSync(ICO, packIco(pngs));
    fs.writeFileSync(TRAY, Buffer.from(await render(TRAY_SIZE), "base64"));
  } finally {
    await browser.close();
  }
  console.log("[icons] wrote " + path.relative(ROOT, ICO) + " (" + ICO_SIZES.join(", ") + ") and " + path.relative(ROOT, TRAY) + " (" + TRAY_SIZE + ")");
}

main().catch((e) => {
  console.error("[icons] " + (e && e.stack ? e.stack : e));
  process.exit(1);
});
