"use strict";

// `--selftest`: the packaged app checks its own moving parts on the machine it
// runs on, without network or keys. CI runs it on every installer before a
// release is published (Windows, macOS arm64, macOS x64 under Rosetta).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BrowserWindow, safeStorage } = require("electron");
const sharp = require("sharp");
const { readImage } = require("./decode");
const { toWebJpeg } = require("./web-image");
const { collectScript } = require("./page-collector");
const { writeExcel } = require("./excel");
const { parseDomains, displayUrl } = require("./domains");
const { withTimeout } = require("./limit");

/** A 24-bit BMP sharp cannot read — proves the Chromium fallback decoder. */
function bmp(width, height) {
  const row = Math.ceil((width * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + row * height);
  buf.write("BM", 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(row * height, 34);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) buf.writeUIntLE(0x3366cc, 54 + y * row + x * 3, 3);
  return buf;
}

async function run() {
  const checks = [];
  const check = async (name, fn) => {
    try {
      checks.push({ name, ok: true, detail: (await fn()) ?? "" });
    } catch (e) {
      checks.push({ name, ok: false, detail: e.stack || String(e) });
    }
  };

  const png = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#cc5533" } }).png().toBuffer();

  await check("sharp: png → web jpeg", async () => {
    const web = await toWebJpeg(png, { width: 1200, height: 800, bytes: 0 });
    if (web.width !== 1200 || web.height !== 800) throw new Error(`size ${web.width}x${web.height}`);
    return `${web.bytes} B`;
  });
  await check("sharp: webp/avif/gif/tiff read", async () => {
    for (const fmt of ["webp", "avif", "gif", "tiff"]) {
      const b = await sharp(png)[fmt]().toBuffer();
      const r = await readImage(b);
      if (!r || r.meta.width !== 640) throw new Error(`${fmt} unreadable`);
    }
  });
  await check("chromium: bmp decode", async () => {
    const r = await readImage(bmp(300, 200));
    if (!r || r.meta.width !== 300) throw new Error("bmp unreadable");
  });
  await check("svg skipped", async () => {
    const r = await readImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"/>'));
    if (r) throw new Error("svg was accepted");
  });
  await check("page collector in a hidden window", async () => {
    const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
    const html = `<!doctype html><body style="margin:0">
      <img src="https://cdn.example/a.jpg"><div style="height:3000px"></div>
      <div data-original="https://static.tildacdn.com/tild1234-5678/photo.jpg"></div>
      <div style="width:10px;height:10px;background-image:url('https://cdn.example/bg.webp')"></div>
      <img src="${dataUrl}"><a href="/page2">p</a></body>`;
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, sandbox: true } });
    try {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      const found = await withTimeout(win.webContents.executeJavaScript(collectScript), 30_000, "collect timeout");
      const want = ["a.jpg", "photo.jpg", "bg.webp"];
      const miss = want.filter((w) => !found.images.some((u) => u.endsWith(w)));
      if (miss.length) throw new Error(`missed ${miss.join(", ")} in ${JSON.stringify(found.images)}`);
      return `${found.images.length} images`;
    } finally {
      win.destroy();
    }
  });
  await check("domains: Cyrillic and Excel junk", async () => {
    const hosts = parseDomains("https://www.Пример.РФ/a\ninfo@site.ru\nsite.ru");
    if (hosts.join() !== "xn--e1afmkfd.xn--p1ai,site.ru") throw new Error(hosts.join());
    if (displayUrl("https://xn--e1afmkfd.xn--p1ai/") !== "https://пример.рф/") throw new Error("display");
  });
  await check("excel write", async () => {
    const file = path.join(os.tmpdir(), `lpg-selftest-${process.pid}.xlsx`);
    await writeExcel(file, ["site.ru"], {
      "site.ru": { verdict: "people", people: [{ url: "https://site.ru/a.jpg", page: "https://site.ru/" }], unsure: [], images: 1, pages: 1, unchecked: 0, error: null },
    });
    const size = fs.statSync(file).size;
    fs.unlinkSync(file);
    if (size < 1000) throw new Error(`file ${size} B`);
  });
  await check("key storage", async () => {
    // Without OS encryption the key is kept in plain form — allowed, but say so.
    if (!safeStorage.isEncryptionAvailable()) return "encryption unavailable (plain storage)";
    const back = safeStorage.decryptString(safeStorage.encryptString("sk-test"));
    if (back !== "sk-test") throw new Error("roundtrip");
    return "encrypted";
  });

  return checks;
}

module.exports = { run };
