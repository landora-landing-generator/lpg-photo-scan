"use strict";

const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const { fetchImage } = require("./scanner");
const { readImage } = require("./decode");
const { describeForRedraw } = require("./classify");
const { drawImage } = require("./draw");
const { toWebJpeg } = require("./web-image");
const { credsFor, redrawRules, loadState, findImage, updateImage, redrawDir } = require("./store");
const { baseName } = require("./redraw-names");
const { displayUrl } = require("./domains");

const VISION_SIDE = 768;

async function original(host, id, signal) {
  const img = findImage(loadState(), host, id);
  if (!img) throw new Error("кадр не найден — проверьте сайт заново");
  const raw = await fetchImage(img.url, img.page, signal ?? new AbortController().signal);
  const read = await readImage(raw);
  if (!read) throw new Error("картинка на сайте больше не открывается");
  return { img, buf: read.buf };
}

/** The original as a data URL for the viewer (fetched with the page as referer — hotlink guards). */
async function originalPreview(host, id) {
  const { buf } = await original(host, id);
  const jpeg = await sharp(buf, { animated: false })
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize(1400, 1400, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

/** The drawn frame as a data URL, or null when there is none yet. */
function redrawPreview(host, id) {
  const img = findImage(loadState(), host, id);
  if (!img?.redraw) return null;
  try {
    return `data:image/jpeg;base64,${fs.readFileSync(path.join(redrawDir(host), img.redraw.file)).toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Draws a new frame for one image: the recognising service writes a prompt
 * (unless the user gave one), the drawing service draws, sharp turns it into a
 * web-ready JPEG of the original's size. Keeps only the latest variant.
 */
async function redrawImage(host, id, { prompt, signal, onStep = () => {} } = {}) {
  onStep("Скачиваю кадр с сайта…");
  const { img, buf } = await original(host, id, signal);
  const draw = credsFor("draw");
  if (!draw.apiKey) throw new Error("Сначала вставьте ключ и нажмите «Сохранить».");
  const rules = redrawRules();
  let text = String(prompt ?? "").trim();
  if (!text) {
    const recognize = credsFor("recognize");
    if (!recognize.apiKey) throw new Error("Сначала вставьте ключ и нажмите «Сохранить».");
    const small = await sharp(buf, { animated: false })
      .rotate()
      .flatten({ background: "#ffffff" })
      .resize(VISION_SIDE, VISION_SIDE, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    onStep("Описываю кадр…");
    text = await describeForRedraw(recognize, small, rules, { signal });
  }
  onStep("Рисую новый кадр… обычно 20–60 секунд");
  // The rules ride along with every prompt — also with one the user typed.
  const drawn = await drawImage(draw, `${text}\n\n${rules}`, { width: img.width, height: img.height }, { signal });
  onStep("Сжимаю для сайта…");
  const web = await toWebJpeg(drawn, img);
  fs.mkdirSync(redrawDir(host), { recursive: true });
  const file = `${id}.jpg`;
  fs.writeFileSync(path.join(redrawDir(host), file), web.buffer);
  return updateImage(host, id, {
    redraw: { file, prompt: text, width: web.width, height: web.height, bytes: web.bytes, at: new Date().toISOString() },
  });
}

/** Copies one drawn frame to a path the user picked. */
function exportOne(host, id, target) {
  const img = findImage(loadState(), host, id);
  if (!img?.redraw) throw new Error("для этого кадра ещё нет новой версии");
  fs.copyFileSync(path.join(redrawDir(host), img.redraw.file), target);
}

/**
 * All drawn frames of a site into <folder>/<host>/ plus replacements.csv —
 * which page, which old image, which new file — the to-do list for whoever
 * swaps them on the site by hand.
 */
function exportSite(host, folder) {
  const r = loadState().results[host];
  const done = [...(r?.people ?? []), ...(r?.unsure ?? [])].filter((img) => img.redraw);
  if (!done.length) throw new Error("на этом сайте ещё нет перерисованных кадров");
  const dir = path.join(folder, host);
  fs.mkdirSync(dir, { recursive: true });
  const used = new Set();
  const rows = [["page", "old_image", "new_file", "width", "height"]];
  for (const img of done) {
    let name = baseName(img.url);
    for (let n = 2; used.has(name); n++) name = `${baseName(img.url)}-${n}`;
    used.add(name);
    const file = `${name}.jpg`;
    fs.copyFileSync(path.join(redrawDir(host), img.redraw.file), path.join(dir, file));
    rows.push([displayUrl(img.page), img.url, file, img.redraw.width, img.redraw.height]);
  }
  const csv = rows.map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\r\n");
  // BOM: Excel on Windows opens a UTF-8 CSV without it as mojibake.
  fs.writeFileSync(path.join(dir, "replacements.csv"), `﻿${csv}\r\n`);
  return { dir, count: done.length };
}

module.exports = { originalPreview, redrawPreview, redrawImage, exportOne, exportSite };
