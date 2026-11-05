"use strict";

const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const { downloadImage } = require("./scanner");
const { readImage } = require("./decode");
const { describeForRedraw } = require("./classify");
const { drawImage } = require("./draw");
const { toWebJpeg, toWebCutout, cutoutFormat } = require("./web-image");
const { backgroundKind } = require("./cutout");
const { CUTOUT_RULE } = require("./prompts");
const { credsFor, redrawRules, loadState, findImage, updateImage, redrawDir } = require("./store");
const { baseName } = require("./redraw-names");
const { displayUrl } = require("./domains");

const VISION_SIDE = 768;

async function original(host, id, signal) {
  const img = findImage(loadState(), host, id);
  if (!img) throw new Error("кадр не найден — проверьте сайт заново");
  let raw;
  try {
    raw = await downloadImage(img.url, signal ?? new AbortController().signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    // Not the drawing service's fault: the site itself did not give the frame back.
    throw new Error("сайт не отдал исходный кадр — откройте его в браузере: возможно, он сейчас не работает");
  }
  const read = await readImage(raw);
  if (!read) throw new Error("картинка на сайте больше не открывается");
  return { img, buf: read.buf };
}

const MIME = { ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const mimeOf = (file) => MIME[path.extname(file).toLowerCase()] ?? "image/jpeg";

/**
 * The original as a data URL for the viewer (fetched with the page as referer —
 * hotlink guards). A transparent original stays transparent (PNG), so the
 * viewer can show that it has no background.
 */
async function originalPreview(host, id) {
  const { buf } = await original(host, id);
  const img = sharp(buf, { animated: false }).rotate();
  const { hasAlpha } = await img.metadata();
  const fitted = img.resize(1400, 1400, { fit: "inside", withoutEnlargement: true });
  if (hasAlpha) return `data:image/png;base64,${(await fitted.png().toBuffer()).toString("base64")}`;
  const jpeg = await fitted.flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

/** The drawn frame as a data URL, or null when there is none yet. */
function redrawPreview(host, id) {
  const img = findImage(loadState(), host, id);
  if (!img?.redraw) return null;
  try {
    return `data:${mimeOf(img.redraw.file)};base64,${fs.readFileSync(path.join(redrawDir(host), img.redraw.file)).toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Draws a new frame for one image: the recognising service writes a prompt
 * (unless the user gave one), the drawing service draws, sharp turns it into a
 * web-ready file of the original's size. A cut-out original (no background)
 * gets a cut-out back: drawn on white, then made transparent here; one on a
 * plain white field gets a white field. Keeps only the latest variant.
 */
async function redrawImage(host, id, { prompt, signal, onStep = () => {} } = {}) {
  onStep("Скачиваю кадр с сайта…");
  const { img, buf } = await original(host, id, signal);
  const draw = credsFor("draw");
  if (!draw.apiKey) throw new Error("Сначала вставьте ключ и нажмите «Сохранить».");
  const kind = await backgroundKind(buf).catch(() => null);
  const rules = kind ? `${redrawRules()} ${CUTOUT_RULE}` : redrawRules();
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
  onStep("Рисую новый кадр… обычно 20–60 секунд, медленные модели — до 5 минут");
  // The rules ride along with every prompt — also with one the user typed.
  const drawn = await drawImage(draw, `${text}\n\n${rules}`, { width: img.width, height: img.height }, { signal });
  let web;
  let background = kind === "white" ? "white" : undefined;
  let cutoutError;
  if (kind === "transparent") {
    onStep("Убираю фон… обычно 10–60 секунд");
    try {
      web = await toWebCutout(drawn, img, cutoutFormat(img.url));
      background = "transparent";
    } catch (e) {
      // The frame is drawn and paid for: keep it on white rather than lose it.
      cutoutError = `фон не убран (${e.message}) — кадр сохранён на белом фоне`;
      background = "white";
    }
  }
  if (!web) {
    onStep("Сжимаю для сайта…");
    web = { ...(await toWebJpeg(drawn, img)), format: "jpg" };
  }
  const dir = redrawDir(host);
  fs.mkdirSync(dir, { recursive: true });
  const file = `${id}.${web.format}`;
  fs.writeFileSync(path.join(dir, file), web.buffer);
  for (const ext of ["jpg", "png", "webp"]) {
    if (`${id}.${ext}` !== file) fs.rmSync(path.join(dir, `${id}.${ext}`), { force: true });
  }
  const updated = updateImage(host, id, {
    redraw: {
      file,
      prompt: text,
      width: web.width,
      height: web.height,
      bytes: web.bytes,
      at: new Date().toISOString(),
      ...(background ? { background } : {}),
      ...(cutoutError ? { cutoutError } : {}),
    },
  });
  if (!updated) throw new Error("Кадр пропал из результата — сайт перепроверили, пока шла перерисовка.");
  return updated;
}

/**
 * "Вырезать фон" on a frame already drawn: the subject alone, transparent,
 * same size. No drawing again and no money — the model runs on this computer.
 */
async function cutoutRedraw(host, id) {
  const img = findImage(loadState(), host, id);
  if (!img?.redraw) throw new Error("Сначала перерисуйте кадр.");
  if (img.redraw.background === "transparent") throw new Error("Фон у этого кадра уже убран.");
  const dir = redrawDir(host);
  const buf = fs.readFileSync(path.join(dir, img.redraw.file));
  const r = img.redraw;
  const web = await toWebCutout(buf, { width: r.width, height: r.height, bytes: r.bytes }, cutoutFormat(img.url));
  const file = `${id}.${web.format}`;
  fs.writeFileSync(path.join(dir, file), web.buffer);
  if (file !== r.file) fs.rmSync(path.join(dir, r.file), { force: true });
  const { cutoutError: _gone, ...rest } = r;
  const updated = updateImage(host, id, { redraw: { ...rest, file, bytes: web.bytes, background: "transparent" } });
  if (!updated) throw new Error("Кадр пропал из результата — сайт перепроверили.");
  return updated;
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
    const file = `${name}${path.extname(img.redraw.file) || ".jpg"}`;
    fs.copyFileSync(path.join(redrawDir(host), img.redraw.file), path.join(dir, file));
    rows.push([displayUrl(img.page), img.url, file, img.redraw.width, img.redraw.height]);
  }
  const csv = rows.map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\r\n");
  // BOM: Excel on Windows opens a UTF-8 CSV without it as mojibake.
  fs.writeFileSync(path.join(dir, "replacements.csv"), `﻿${csv}\r\n`);
  return { dir, count: done.length };
}

module.exports = { originalPreview, redrawPreview, redrawImage, cutoutRedraw, exportOne, exportSite };
