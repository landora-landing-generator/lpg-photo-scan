"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { app } = require("electron");
const sharp = require("sharp");
const { readImage } = require("./decode");
const { drawImage } = require("./draw");
const { toWebJpeg } = require("./web-image");
const { credsFor, redrawRules } = require("./store");

// "Нарисовать кадр": a frame from the user's own picture (used as a reference)
// or from a description alone. Results are web-ready JPEGs like redraws.

const REF_SIDE = 1536;
const SIZES = {
  "1:1": [1200, 1200],
  "4:3": [1600, 1200],
  "3:2": [1500, 1000],
  "16:9": [1600, 900],
  "3:4": [1200, 1600],
  "2:3": [1000, 1500],
  "9:16": [900, 1600],
};

const refs = new Map(); // id → { jpeg, width, height }
const studioDir = () => path.join(app.getPath("userData"), "studio");

/** A picture from the computer → reference kept in memory + a preview for the window. */
async function loadReference(file) {
  const read = await readImage(fs.readFileSync(file));
  if (!read) throw new Error("Это не картинка или формат не поддерживается.");
  const base = () => sharp(read.buf, { animated: false }).rotate().flatten({ background: "#ffffff" });
  const jpeg = await base().resize(REF_SIDE, REF_SIDE, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
  const preview = await base().resize(800, 800, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  const id = crypto.randomUUID();
  refs.clear(); // one reference at a time
  refs.set(id, { jpeg, width: read.meta.width, height: read.meta.height });
  return { id, preview: `data:image/jpeg;base64,${preview.toString("base64")}`, width: read.meta.width, height: read.meta.height };
}

/**
 * With a reference: a new frame like it, sized like it, under the redraw rules
 * (the description is optional). Without: the description is the whole prompt.
 */
async function generate({ refId, prompt, aspect }) {
  const text = String(prompt ?? "").trim();
  const ref = refId ? refs.get(refId) : null;
  if (refId && !ref) throw new Error("Картинка-образец потерялась — перетащите её ещё раз.");
  if (!ref && !text) throw new Error("Опишите, что нарисовать, или перетащите картинку-образец.");
  const draw = credsFor("draw");
  if (!draw.apiKey) throw new Error("Сначала вставьте ключ и нажмите «Сохранить».");

  const size = ref ? { width: ref.width, height: ref.height } : { width: SIZES[aspect]?.[0] ?? 1600, height: SIZES[aspect]?.[1] ?? 1200 };
  const full = ref
    ? [`Нарисуй новую фотографию по образцу на приложенной картинке.`, text, redrawRules()].filter(Boolean).join("\n\n")
    : text;
  const drawn = await drawImage(draw, full, size, { reference: ref?.jpeg });
  const web = await toWebJpeg(drawn, { ...size, bytes: 0 });

  fs.mkdirSync(studioDir(), { recursive: true });
  const file = `frame-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.jpg`;
  fs.writeFileSync(path.join(studioDir(), file), web.buffer);
  return {
    file,
    preview: `data:image/jpeg;base64,${web.buffer.toString("base64")}`,
    width: web.width,
    height: web.height,
    bytes: web.bytes,
  };
}

/** Copies a studio result to where the user chose; refuses names outside the studio folder. */
function exportStudio(file, target) {
  const src = path.join(studioDir(), path.basename(file));
  if (!fs.existsSync(src)) throw new Error("Файл не найден — нарисуйте кадр заново.");
  fs.copyFileSync(src, target);
}

module.exports = { loadReference, generate, exportStudio, SIZES };
