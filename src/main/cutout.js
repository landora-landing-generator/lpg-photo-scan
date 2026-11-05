"use strict";

const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

// Cut-out frames: people on a landing page are often cut out of their photo and
// set into the design with no background (a transparent PNG/WebP), or stand on
// the page's plain white. A redraw must keep that: the image model draws the
// subject on pure white, then a local segmentation model (BiRefNet lite, MIT,
// runs on the CPU — no keys, no money) gives the transparency back.

/** Sides of the sample the background test looks at. */
const PROBE_SIDE = 256;
/** Border ring of the sample, as a share of each side. */
const RING = 0.04;
/** Model input (BiRefNet is trained at 1024²). */
const NET = 1024;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const MODEL_FILE = "birefnet-lite-fp16.onnx";

/**
 * What stands behind the subject of a frame:
 * - "transparent" — the original has real transparency around the subject;
 * - "white" — an opaque frame on a plain white (or near-white) field;
 * - null — an ordinary photo with its own scene.
 */
async function backgroundKind(buf) {
  const img = sharp(buf, { animated: false }).rotate();
  const meta = await img.metadata();
  const { data, info } = await img
    .resize(PROBE_SIDE, PROBE_SIDE, { fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return kindOfPixels(data, info.width, info.height, Boolean(meta.hasAlpha));
}

/** The decision on raw RGBA pixels (pure, for tests). */
function kindOfPixels(rgba, width, height, hasAlpha) {
  const band = Math.max(1, Math.round(Math.min(width, height) * RING));
  let ring = 0;
  let ringClear = 0;
  let ringWhite = 0;
  let clear = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = rgba[i + 3];
      const isClear = a < 32;
      if (isClear) clear++;
      const onRing = x < band || y < band || x >= width - band || y >= height - band;
      if (!onRing) continue;
      ring++;
      if (isClear) ringClear++;
      else {
        const r = rgba[i];
        const g = rgba[i + 1];
        const b = rgba[i + 2];
        const lo = Math.min(r, g, b);
        if (lo >= 232 && Math.max(r, g, b) - lo <= 14) ringWhite++;
      }
    }
  }
  // A rounded-corner photo is clear only in its corners: under a quarter of the
  // ring. A cut-out subject leaves most of the ring clear.
  if (hasAlpha && ringClear / ring >= 0.25 && clear / (width * height) >= 0.05) return "transparent";
  if (ringWhite / ring >= 0.85) return "white";
  return null;
}

/** Where the model lives: next to the app in a build, in the repo while developing. */
function modelPath() {
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, "models", MODEL_FILE),
    path.join(__dirname, "..", "..", "models", MODEL_FILE),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** The model runs in a child process (see cutout-worker.js); killed after this long idle. */
const IDLE_MS = 2 * 60_000;
let worker = null;
let idleTimer = null;
let seq = 0;
const pending = new Map();
let queue = Promise.resolve();

function startWorker() {
  const { fork } = require("node:child_process");
  const child = fork(path.join(__dirname, "cutout-worker.js"), [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    serialization: "advanced",
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let tail = "";
  child.stderr.on("data", (d) => {
    tail = (tail + d).slice(-2000);
  });
  child.on("message", ({ id, logits, error }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve(logits);
  });
  child.on("exit", (code, signal) => {
    if (worker === child) worker = null;
    const why = tail.split("\n").filter((l) => l && !/\[W:onnxruntime/.test(l)).pop();
    for (const p of pending.values()) p.reject(new Error(`вырезка фона упала (${signal ?? code}${why ? `: ${why}` : ""})`));
    pending.clear();
  });
  return child;
}

/** Kills the model process at once (app quit, idle): SIGKILL skips onnxruntime's exit path. */
function stopCutout() {
  clearTimeout(idleTimer);
  if (worker) {
    worker.kill("SIGKILL");
    worker = null;
  }
}

function infer(input) {
  const model = modelPath();
  if (!model) return Promise.reject(new Error(`модель вырезки фона не найдена (${MODEL_FILE})`));
  clearTimeout(idleTimer);
  worker ??= startWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.send({ id, model, input, size: NET });
  }).finally(() => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(stopCutout, IDLE_MS);
    idleTimer.unref?.();
  });
}

/**
 * Alpha mask (one byte per pixel, width × height) of the subject on raw RGB
 * pixels. One run at a time: a run takes ~1–2 GB and all CPU cores already.
 */
function subjectMask(rgb, width, height) {
  const job = queue.then(() => runMask(rgb, width, height));
  queue = job.catch(() => {});
  return job;
}

async function runMask(rgb, width, height) {
  const small = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .resize(NET, NET, { fit: "fill" })
    .raw()
    .toBuffer();
  const plane = NET * NET;
  const x = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) x[c * plane + i] = (small[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  }
  const logits = await infer(x);
  const mask = Buffer.alloc(plane);
  for (let i = 0; i < plane; i++) mask[i] = Math.round(255 / (1 + Math.exp(-logits[i])));
  return sharp(mask, { raw: { width: NET, height: NET, channels: 1 } })
    .resize(width, height, { fit: "fill" })
    .extractChannel(0)
    .raw()
    .toBuffer();
}

/**
 * RGB drawn on white + alpha → RGBA without a white fringe: an edge pixel is
 * a·subject + (1−a)·white, so the subject's own colour is recovered by taking
 * the white back out. Without it hair and edges glow on a dark page.
 */
function unmatteWhite(rgb, alpha) {
  const n = alpha.length;
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const a = alpha[i] / 255;
    for (let c = 0; c < 3; c++) {
      const v = rgb[i * 3 + c];
      out[i * 4 + c] = a > 0.04 && a < 0.98 ? Math.max(0, Math.min(255, Math.round((v - (1 - a) * 255) / a))) : v;
    }
    out[i * 4 + 3] = alpha[i];
  }
  return out;
}

/**
 * RGB frame → RGBA raw buffer of the subject alone. `onWhite`: the frame was
 * drawn on white, so edge pixels get the white taken back out.
 */
async function cutOut(rgb, width, height, { onWhite = true } = {}) {
  const alpha = await subjectMask(rgb, width, height);
  if (onWhite) return unmatteWhite(rgb, alpha);
  const out = Buffer.alloc(alpha.length * 4);
  for (let i = 0; i < alpha.length; i++) {
    out[i * 4] = rgb[i * 3];
    out[i * 4 + 1] = rgb[i * 3 + 1];
    out[i * 4 + 2] = rgb[i * 3 + 2];
    out[i * 4 + 3] = alpha[i];
  }
  return out;
}

/** For the self-test and the app's start: can this machine cut out at all? */
function cutoutAvailable() {
  return Boolean(modelPath());
}

module.exports = { backgroundKind, kindOfPixels, cutOut, unmatteWhite, subjectMask, cutoutAvailable, modelPath, stopCutout };
