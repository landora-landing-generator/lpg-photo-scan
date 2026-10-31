"use strict";

const { BrowserWindow } = require("electron");
const sharp = require("sharp");
const { withTimeout } = require("./limit");

// sharp reads JPEG, PNG, WebP, AVIF, GIF and TIFF. Other raster formats a
// browser shows (BMP, …) are decoded by Chromium itself in a hidden window and
// handed back as PNG. Vector and icon files (SVG, ICO) are not photos and are
// dropped by content, whatever the URL said.

let decoderWin = null;

function decoder() {
  if (decoderWin && !decoderWin.isDestroyed()) return decoderWin;
  decoderWin = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { offscreen: true, sandbox: true } });
  decoderWin.webContents.setFrameRate(1);
  decoderWin.loadURL("data:text/html,<meta charset=utf-8>");
  return decoderWin;
}

const DECODE_IN_PAGE = `(async (src) => {
  const img = new Image();
  img.src = src;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext("2d").drawImage(img, 0, 0);
  return c.toDataURL("image/png");
})`;

async function chromiumToPng(buf) {
  const win = decoder();
  // A crashed decoder page never fires did-finish-load: wait a bounded time.
  if (win.webContents.isLoading()) {
    await withTimeout(new Promise((r) => win.webContents.once("did-finish-load", r)), 15_000, "decoder did not load");
  }
  const src = `data:application/octet-stream;base64,${buf.toString("base64")}`;
  const dataUrl = await withTimeout(
    win.webContents.executeJavaScript(`${DECODE_IN_PAGE}(${JSON.stringify(src)})`),
    20_000,
    "decode timeout",
  );
  return Buffer.from(String(dataUrl).split(",")[1] ?? "", "base64");
}

/** ICO/CUR header or SVG text — icons, not photos. */
function isVectorOrIcon(buf) {
  if (buf.length >= 4 && buf[0] === 0 && buf[1] === 0 && (buf[2] === 1 || buf[2] === 2) && buf[3] === 0) return true;
  const head = buf.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"));
}

/**
 * Any image file → { buf, meta } that sharp can process (the original bytes
 * when sharp reads them, a PNG re-encode otherwise). null → not an image.
 */
async function readImage(buf) {
  try {
    const meta = await sharp(buf, { animated: false }).metadata();
    if (meta.format === "svg") return null;
    if (meta.width && meta.height) return { buf, meta };
  } catch {
    /* not for sharp — try the browser */
  }
  if (isVectorOrIcon(buf)) return null;
  try {
    const png = await chromiumToPng(buf);
    const meta = await sharp(png).metadata();
    return meta.width && meta.height ? { buf: png, meta } : null;
  } catch {
    return null;
  }
}

module.exports = { readImage };
