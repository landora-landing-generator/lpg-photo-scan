"use strict";

const sharp = require("sharp");

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
async function toWebJpeg(drawn, original) {
  const scale = Math.min(1, MAX_SIDE / Math.max(original.width, original.height));
  const width = Math.round(original.width * scale);
  const height = Math.round(original.height * scale);
  const base = sharp(drawn)
    .rotate()
    .resize(width, height, { fit: "cover", position: "attention" })
    .flatten({ background: "#ffffff" });
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

module.exports = { toWebJpeg };
