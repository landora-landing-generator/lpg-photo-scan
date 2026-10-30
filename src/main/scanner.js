"use strict";

const { BrowserWindow, session } = require("electron");
const sharp = require("sharp");
const { collectScript } = require("./page-collector");
const { imageKey } = require("./image-urls");
const { sameSite } = require("./domains");
const { classify, FatalKeyError } = require("./classify");
const { createLimiter, withTimeout } = require("./limit");
const { verdictOf } = require("./verdict");

const MAX_PAGES = 20;
const MAX_IMAGES = 300;
const MIN_SIDE = 200; // icons, logos, bullets
const MODEL_SIDE = 768;
const THUMB_SIDE = 240;
const MAX_BYTES = 25 * 1024 * 1024;
const PAGE_TIMEOUT = 30_000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const NOT_A_PAGE = /\.(?:pdf|jpe?g|png|webp|gif|svg|zip|rar|docx?|xlsx?|pptx?|mp4|mp3|avi)$/i;

const NET_ERRORS = {
  ERR_NAME_NOT_RESOLVED: "домен не найден (не продлён или нет DNS)",
  ERR_NAME_RESOLUTION_FAILED: "домен не найден (не продлён или нет DNS)",
  ERR_CONNECTION_REFUSED: "сервер не принимает соединения",
  ERR_CONNECTION_TIMED_OUT: "сервер не отвечает",
  ERR_CONNECTION_RESET: "сервер оборвал соединение",
  ERR_TOO_MANY_REDIRECTS: "сайт бесконечно перенаправляет",
  ERR_INTERNET_DISCONNECTED: "нет интернета на этом компьютере",
  TIMEOUT: "страница не загрузилась за 30 секунд",
};

function friendlyError(e) {
  const code = e.code || /ERR_[A-Z_]+/.exec(String(e.message))?.[0] || "";
  return NET_ERRORS[code] || (code ? `ошибка загрузки (${code})` : String(e.message || e));
}

/** A private, cookie-less session that tolerates broken certificates and skips video/audio. */
function scanSession(id) {
  const ses = session.fromPartition(`scan-${id}`, { cache: false });
  ses.setUserAgent(UA);
  ses.setCertificateVerifyProc((_req, cb) => cb(0));
  ses.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, (details, cb) =>
    cb({ cancel: details.resourceType === "media" }),
  );
  return ses;
}

function openWindow(ses) {
  const win = new BrowserWindow({
    show: false,
    width: 1366,
    height: 900,
    webPreferences: { session: ses, offscreen: true, backgroundThrottling: false, sandbox: true },
  });
  win.webContents.setAudioMuted(true);
  win.webContents.setFrameRate(5);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-prevent-unload", (e) => e.preventDefault());
  return win;
}

/** Loads a URL; resolves with the HTTP status of the main document. Timeouts are not fatal. */
async function loadPage(win, url) {
  const wc = win.webContents;
  let status = 0;
  const onNav = (_e, _u, code) => {
    status = code;
  };
  wc.on("did-navigate", onNav);
  try {
    await withTimeout(wc.loadURL(url), PAGE_TIMEOUT, "timeout");
  } catch (e) {
    if (e.code === "TIMEOUT") {
      wc.stop();
      if (!status) throw e;
    } else if (!/ERR_ABORTED/.test(String(e.message)) || !status) {
      throw e;
    }
  } finally {
    wc.off("did-navigate", onNav);
  }
  return status;
}

async function fetchImage(url, referer, signal) {
  const res = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    headers: { "User-Agent": UA, Referer: referer, Accept: "image/avif,image/webp,image/*,*/*" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error("слишком большой файл");
  return buf;
}

/** Decodes any web format; small images and decode failures → null (not a photo to check). */
async function prepareImage(buf) {
  let meta;
  try {
    meta = await sharp(buf, { animated: false }).metadata();
  } catch {
    return null;
  }
  if (meta.format === "svg") return null;
  if (!meta.width || !meta.height || Math.max(meta.width, meta.height) < MIN_SIDE) return null;
  const base = () => sharp(buf, { animated: false }).rotate().flatten({ background: "#ffffff" });
  const [forModel, thumb] = await Promise.all([
    base().resize(MODEL_SIDE, MODEL_SIDE, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer(),
    base().resize(THUMB_SIDE, THUMB_SIDE, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer(),
  ]);
  return { forModel, thumb: `data:image/jpeg;base64,${thumb.toString("base64")}`, width: meta.width, height: meta.height };
}

function crawlTarget(href, host) {
  try {
    const u = new URL(href);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!sameSite(u.href, host) || NOT_A_PAGE.test(u.pathname)) return null;
    u.hash = "";
    u.search = "";
    return u.href;
  } catch {
    return null;
  }
}

/** Opens the site, walks up to MAX_PAGES internal pages, returns image candidates by key. */
async function crawl(host, win, signal, onStep) {
  const images = new Map(); // key → { download, page }
  const queue = [];
  const seen = new Set();
  const enqueue = (url) => {
    const norm = url.replace(/\/$/, "");
    if (!seen.has(norm) && seen.size < MAX_PAGES) {
      seen.add(norm);
      queue.push(url);
    }
  };

  // Home page: https first, then http — its failure is the site's failure.
  let home;
  let lastError;
  for (const scheme of ["https", "http"]) {
    try {
      const status = await loadPage(win, `${scheme}://${host}/`);
      if (status >= 400) throw Object.assign(new Error(`сайт ответил ошибкой ${status}`), { http: status });
      home = win.webContents.getURL();
      break;
    } catch (e) {
      lastError = e;
      if (e.http) break;
    }
  }
  if (!home) throw new Error(lastError.http ? lastError.message : friendlyError(lastError));
  seen.add(home.replace(/\/$/, ""));

  let pages = 0;
  let url = home;
  for (;;) {
    if (signal.aborted) throw signal.reason;
    if (url !== home) {
      try {
        const status = await loadPage(win, url);
        if (status >= 400) url = null;
      } catch {
        url = null; // an inner page that fails is skipped, not fatal
      }
    }
    if (url) {
      pages++;
      onStep(`страница ${pages}`);
      let found;
      try {
        found = await withTimeout(win.webContents.executeJavaScript(collectScript), 45_000, "collect");
      } catch {
        found = null;
      }
      if (found) {
        for (const raw of found.images) {
          const k = imageKey(raw, found.finalUrl);
          if (k && !images.has(k.key) && images.size < MAX_IMAGES) images.set(k.key, { ...k, page: found.finalUrl });
        }
        for (const link of found.links) {
          const t = crawlTarget(link, host);
          if (t) enqueue(t);
        }
      }
    }
    url = queue.shift();
    if (!url) break;
  }
  return { images, pages };
}

/**
 * Scans the given hosts. Calls onSite(result) as each site finishes and
 * onProgress({ host, step }) while working. A bad key or empty balance stops
 * everything and rejects with FatalKeyError.
 */
async function scanSites({ hosts, creds, signal, onSite, onProgress, siteConcurrency = 3 }) {
  const inner = new AbortController();
  const stop = AbortSignal.any([signal, inner.signal]);
  const classifyLimit = createLimiter(6);
  const fetchLimit = createLimiter(8);
  const siteLimit = createLimiter(siteConcurrency);
  let fatal = null;
  let seq = 0;

  async function scanSite(host) {
    const result = { host, pages: 0, images: 0, people: [], unsure: [], unchecked: 0, error: null };
    const ses = scanSession(`${Date.now()}-${seq++}`);
    const win = openWindow(ses);
    try {
      onProgress({ host, step: "открываю сайт" });
      const { images, pages } = await crawl(host, win, stop, (step) => onProgress({ host, step }));
      win.destroy();
      result.pages = pages;
      let done = 0;
      const total = images.size;
      await Promise.all(
        [...images.values()].map(async (img) => {
          let prepared = null;
          try {
            const buf = await fetchLimit(() => fetchImage(img.download, img.page, stop));
            prepared = await prepareImage(buf);
          } catch {
            prepared = null; // unreachable or broken file — not a visible photo
          }
          if (prepared) {
            result.images++;
            try {
              const kind = await classifyLimit(() => {
                if (stop.aborted) throw stop.reason;
                return classify(creds, prepared.forModel, { signal: stop });
              });
              const entry = { url: img.download, page: img.page, thumb: prepared.thumb };
              if (kind === "people") result.people.push(entry);
              else if (kind === "unsure") result.unsure.push(entry);
            } catch (e) {
              if (e instanceof FatalKeyError) {
                fatal ??= e;
                inner.abort(e);
              }
              result.unchecked++;
            }
          }
          onProgress({ host, step: `кадры ${++done} из ${total}` });
        }),
      );
    } catch (e) {
      result.error = friendlyError(e);
    } finally {
      if (!win.isDestroyed()) win.destroy();
      ses.clearStorageData().catch(() => {});
    }
    if (stop.aborted) return; // stopped mid-site — leave it for the next run
    result.verdict = verdictOf(result);
    result.checkedAt = new Date().toISOString();
    onSite(result);
  }

  await Promise.all(hosts.map((host) => siteLimit(() => (stop.aborted ? null : scanSite(host)))));
  if (fatal) throw fatal;
}

module.exports = { scanSites };
