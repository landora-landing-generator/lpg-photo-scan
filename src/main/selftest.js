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
const { toWebJpeg, toWebCutout } = require("./web-image");
const { backgroundKind } = require("./cutout");
const http = require("node:http");
const { collectScript } = require("./page-collector");
const { createScan } = require("./scanner");
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
  await check("cut-out: background test", async () => {
    const svg = (bg) =>
      Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500">${bg}<ellipse cx="200" cy="260" rx="110" ry="190" fill="#2b4c8c"/></svg>`);
    const clear = await sharp(svg("")).png().toBuffer();
    const white = await sharp(svg('<rect width="400" height="500" fill="#fff"/>')).jpeg().toBuffer();
    const kinds = [await backgroundKind(clear), await backgroundKind(white), await backgroundKind(png)];
    if (kinds.join() !== "transparent,white,") throw new Error(`kinds ${kinds.join()}`);
  });
  await check("cut-out: background removal (onnxruntime + model)", async () => {
    const t = Date.now();
    const drawn = await sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#fff"/>' +
          '<circle cx="300" cy="200" r="90" fill="#d9a07a"/><rect x="190" y="300" width="220" height="420" rx="60" fill="#2b4c8c"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    const web = await toWebCutout(drawn, { width: 600, height: 800, bytes: 0 }, "png");
    const { data, info } = await sharp(web.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alpha = (x, y) => data[(y * info.width + x) * 4 + 3];
    if (alpha(10, 10) > 40 || alpha(590, 790) > 40) throw new Error(`background kept: ${alpha(10, 10)}, ${alpha(590, 790)}`);
    if (alpha(300, 500) < 200) throw new Error(`subject cut away: ${alpha(300, 500)}`);
    return `${web.bytes} B, ${Date.now() - t} ms`;
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
  await check("scan over HTTP: pages, sitemap, images, cache", async () => {
    // A local two-page site: the photo sits on the inner page, found via the sitemap.
    const photo = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#3366cc" } }).jpeg().toBuffer();
    const routes = {
      "/": '<html><body><a href="/about/">about</a></body></html>',
      "/sitemap.xml": "<urlset><url><loc>http://localhost:PORT/works/</loc></url></urlset>",
      "/about/": "<html><body>no photos</body></html>",
      "/works/": '<html><body><img src="/img/p-300x200.jpg"><img src="/img/p.jpg"></body></html>',
    };
    const server = http.createServer((req, res) => {
      if (req.url.startsWith("/img/")) return res.writeHead(200, { "Content-Type": "image/jpeg" }).end(photo);
      const body = routes[req.url];
      if (!body) return res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": req.url.endsWith(".xml") ? "application/xml" : "text/html" });
      res.end(body.replace("PORT", server.address().port));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const host = `localhost:${server.address().port}`;
      // A fake model: every image is a face, and the call count proves the cache.
      let calls = 0;
      const cacheFile = path.join(os.tmpdir(), `lpg-selftest-cache-${process.pid}.json`);
      const runOnce = () =>
        new Promise((resolve, reject) => {
          let got = null;
          const scan = createScan({
            creds: { provider: "openrouter", apiKey: "x", model: "selftest" },
            classifyImage: async () => (calls++, "face"),
            signal: new AbortController().signal,
            cacheFile,
            onProgress: () => {},
            onSite: (r) => (got = r),
          });
          scan.add([host]);
          scan.done.then(() => resolve(got), reject);
        });
      try {
        const r = await withTimeout(runOnce(), 60_000, "scan timeout");
        if (r.error) throw new Error(r.error);
        if (r.pages !== 3 || r.people.length !== 1) throw new Error(`pages ${r.pages}, people ${r.people.length}`);
        await withTimeout(runOnce(), 60_000, "scan timeout");
        if (calls !== 1) throw new Error(`model asked ${calls} times, cache missed`);
        return `${r.pages} pages, 1 photo, 1 model call for 2 runs`;
      } finally {
        fs.rmSync(cacheFile, { force: true });
      }
    } finally {
      server.close();
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
    // A Mac keeps the key in the user-only settings file: the keychain would ask for a password after each update.
    if (process.platform === "darwin") return "user-only file";
    // Without OS encryption the key is kept in plain form — allowed, but say so.
    if (!safeStorage.isEncryptionAvailable()) return "encryption unavailable (plain storage)";
    const back = safeStorage.decryptString(safeStorage.encryptString("sk-test"));
    if (back !== "sk-test") throw new Error("roundtrip");
    return "encrypted";
  });

  return checks;
}

module.exports = { run };
