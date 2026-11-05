"use strict";

const sharp = require("sharp");
const { cutOut, backgroundKind } = require("./cutout");

/** Longest side a landing page ever needs; bigger originals are scaled down. */
const MAX_SIDE = 2000;
/** Quality steps: the first that fits the byte budget wins. */
const QUALITY_STEPS = [80, 74, 68, 62, 56];

/**
 * A drawn frame → a web-ready JPEG that drops into the original's slot: the
 * original's pixel size (capped at MAX_SIDE), cropped around the subject,
 * progressive mozjpeg, no metadata, and no heavier than the original when
 * that is reachable at a decent quality.
 */
function slotSize(original) {
  const scale = Math.min(1, MAX_SIDE / Math.max(original.width, original.height));
  return { width: Math.round(original.width * scale), height: Math.round(original.height * scale) };
}

function fitted(drawn, width, height) {
  return sharp(drawn)
    .rotate()
    .resize(width, height, { fit: "cover", position: "attention" })
    .flatten({ background: "#ffffff" });
}

async function toWebJpeg(drawn, original) {
  const { width, height } = slotSize(original);
  const base = fitted(drawn, width, height);
  // Budget: the original's weight, but never below ~0.1 byte/pixel (a tiny PNG
  // icon-like original must not starve a photo into mush).
  const budget = Math.max(original.bytes ?? 0, width * height * 0.1);
  let out;
  for (const quality of QUALITY_STEPS) {
    out = await base.clone().jpeg({ quality, mozjpeg: true, progressive: true }).toBuffer();
    if (out.length <= budget) break;
  }
  return { buffer: out, width, height, bytes: out.length };
}

/**
 * A frame drawn on white → the subject alone with real transparency, for a slot
 * whose original was a cut-out. WebP when the site served WebP/AVIF, otherwise
 * PNG (a palette PNG when the full one is far heavier than the original).
 */
async function toWebCutout(drawn, original, format = "png") {
  const { width, height } = slotSize(original);
  const rgb = await fitted(drawn, width, height).removeAlpha().raw().toBuffer();
  // Any frame can be cut out by hand; only one on white gets its edges unmatted.
  const onWhite = (await backgroundKind(drawn).catch(() => null)) === "white";
  const rgba = await cutOut(rgb, width, height, { onWhite });
  const base = sharp(rgba, { raw: { width, height, channels: 4 } });
  const budget = Math.max(original.bytes ?? 0, width * height * 0.25);
  let out;
  if (format === "webp") {
    for (const quality of QUALITY_STEPS) {
      out = await base.clone().webp({ quality: quality + 4, alphaQuality: 90, effort: 5 }).toBuffer();
      if (out.length <= budget) break;
    }
  } else {
    out = await base.clone().png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
    if (out.length > budget * 1.5) out = await base.clone().png({ palette: true, quality: 92, effort: 8, compressionLevel: 9 }).toBuffer();
  }
  return { buffer: out, width, height, bytes: out.length, format };
}

/** The file type a cut-out keeps: WebP for WebP/AVIF originals, PNG otherwise. */
function cutoutFormat(url) {
  return /\.(?:webp|avif)(?:$|[?#])/i.test(String(url ?? "")) || /\/format\/webp\//i.test(String(url ?? "")) ? "webp" : "png";
}

module.exports = { toWebJpeg, toWebCutout, cutoutFormat };
