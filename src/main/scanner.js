"use strict";

const { BrowserWindow, session } = require("electron");
const crypto = require("node:crypto");
const sharp = require("sharp");
const { collectScript } = require("./page-collector");
const { extractFromHtml, extractFromCss, extractFromSitemap } = require("./html-collector");
const { imageKey } = require("./image-urls");
const { sameSite } = require("./domains");
const { classify } = require("./classify");
const { readImage } = require("./decode");
const { FatalKeyError, providerOf } = require("./providers");
const { createLimiter, withTimeout } = require("./limit");
const { createVerdictCache } = require("./verdict-cache");
const { verdictOf } = require("./verdict");

// How a site is read: its pages are downloaded as plain HTML (a fraction of a
// second each, several at once) and image URLs are read from the markup, the
// sitemap and the stylesheets. A real browser opens the site only when the
// HTML shows nothing — a script-drawn site or an anti-bot wall.
//
// Images of all sites go through one pipeline: download → shrink → the
// model, many requests at once. The same file is checked once per run
// and, by its bytes, once ever (verdict cache).

const MAX_PAGES = 300;
const MAX_IMAGES = 600;
const MAX_STYLES = 15;
const MIN_SIDE = 200; // icons, logos, bullets
const MODEL_SIDE = 768;
const THUMB_SIDE = 240;
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_HTML = 5 * 1024 * 1024;
const PAGE_TIMEOUT = 20_000;
const BROWSER_PAGE_TIMEOUT = 30_000;
const BROWSER_PAGES = 8;
const COLLECT_DEADLINE = 90_000; // reading pages of one site
const SITE_DEADLINE = 10 * 60_000; // a site never holds the list longer
const SITES_AT_ONCE = 6;
const PAGES_AT_ONCE = 8; // per site
const BROWSERS_AT_ONCE = 2;
const DOWNLOADS_AT_ONCE = 32;
// One image per request: several in one request lose "hands at work" frames
// (measured: 1–2 of 8 answered "photo"); the bill is the images either way.
const MODEL_CALLS_AT_ONCE = 48;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const NOT_A_PAGE = /\.(?:pdf|jpe?g|png|webp|gif|svg|zip|rar|docx?|xlsx?|pptx?|mp4|mp3|avi|xml|txt|css|js|json)$/i;
// A wall that wants a browser before it shows the site.
const BLOCKED_STATUS = new Set([401, 403, 429, 503]);
const CHALLENGE = /ddos-guard|cf-chl|challenge-platform|Just a moment\.\.\.|Проверка браузера|captcha/i;

const NET_ERRORS = {
  ERR_NAME_NOT_RESOLVED: "домен не найден (не продлён или нет DNS)",
  ERR_NAME_RESOLUTION_FAILED: "домен не найден (не продлён или нет DNS)",
  ERR_CONNECTION_REFUSED: "сервер не принимает соединения",
  ERR_CONNECTION_TIMED_OUT: "сервер не отвечает",
  ERR_CONNECTION_RESET: "сервер оборвал соединение",
  ERR_CONNECTION_CLOSED: "сервер оборвал соединение",
  ERR_TOO_MANY_REDIRECTS: "сайт бесконечно перенаправляет",
  ERR_INTERNET_DISCONNECTED: "нет интернета на этом компьютере",
  ERR_ADDRESS_UNREACHABLE: "сервер недоступен",
  TIMEOUT: "страница не загрузилась за 30 секунд",
};

function friendlyError(e) {
  if (e?.http) return e.message;
  if (e?.name === "TimeoutError") return "сайт не ответил за 20 секунд";
  const code = e?.code || /ERR_[A-Z_]+/.exec(String(e?.message))?.[0] || "";
  return NET_ERRORS[code] || (code ? `ошибка загрузки (${code})` : String(e?.message || e));
}

/** A private, cookie-less session that tolerates broken certificates and skips video/audio. */
function scanSession(id) {
  const ses = session.fromPartition(`scan-${id}`, { cache: false });
  ses.setUserAgent(UA, "ru-RU,ru,en");
  ses.setCertificateVerifyProc((_req, cb) => cb(0));
  ses.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, (details, cb) =>
    cb({ cancel: details.resourceType === "media" }),
  );
  return ses;
}

/**
 * GET through the scan session (Chromium's network: HTTP/2, brotli, broken
 * certificates allowed). Electron leaves `res.url` empty, so `finalUrl` is
 * the requested one. No Referer: Chromium cancels a cross-site one as invalid.
 */
async function get(ses, url, { signal, timeout = PAGE_TIMEOUT, accept = "*/*" } = {}) {
  const res = await ses.fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.5" },
    redirect: "follow",
  });
  res.finalUrl = res.url || url;
  return res;
}

const HTML_ACCEPT = "text/html,application/xhtml+xml,*/*;q=0.8";

/** Body as text when it is HTML (or any text for `anyText`); null otherwise. */
async function readText(res, anyText = false) {
  const type = res.headers.get("content-type") ?? "";
  if (!anyText && type && !/html|xml/i.test(type)) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.subarray(0, MAX_HTML).toString("utf8");
}

async function fetchImage(ses, url, signal) {
  const res = await get(ses, url, { signal, accept: "image/avif,image/webp,image/*,*/*;q=0.8" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES) throw new Error("слишком большой файл");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error("слишком большой файл");
  return buf;
}

/** Decodes any web format; small images and decode failures → null (not a photo to check). */
async function prepareImage(raw) {
  const read = await readImage(raw);
  if (!read) return null;
  const { buf, meta } = read;
  if (Math.max(meta.width, meta.height) < MIN_SIDE) return null;
  const base = () => sharp(buf, { animated: false }).rotate().flatten({ background: "#ffffff" });
  const [forModel, thumb] = await Promise.all([
    base().resize(MODEL_SIDE, MODEL_SIDE, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer(),
    base().resize(THUMB_SIDE, THUMB_SIDE, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer(),
  ]);
  return {
    forModel,
    thumb: `data:image/jpeg;base64,${thumb.toString("base64")}`,
    width: meta.width,
    height: meta.height,
    bytes: raw.length,
    format: meta.format,
  };
}

/** Stable id of an image within the app (file names of redraws, IPC). */
const imageId = (url) => crypto.createHash("sha1").update(url).digest("hex").slice(0, 16);

const pageKey = (url) => url.replace(/\/$/, "");

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

/** Image candidates of one site by identity; a sized cut gives way to the original when both are seen. */
function imageBag() {
  const images = new Map(); // key → { key, download, page, sized }
  return {
    images,
    add(urls, page) {
      for (const raw of urls) {
        const k = imageKey(raw, page);
        if (!k) continue;
        const prev = images.get(k.key);
        if (!prev) {
          if (images.size < MAX_IMAGES) images.set(k.key, { ...k, page });
        } else if (prev.sized && !k.sized) images.set(k.key, { ...k, page: prev.page });
      }
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Home page over https, then http. A failure carries `http` (status) or a network code. */
async function openHome(host, ses, signal) {
  let lastError;
  for (const scheme of ["https", "http"]) {
    try {
      const res = await get(ses, `${scheme}://${host}/`, { signal, accept: HTML_ACCEPT });
      const html = (await readText(res)) ?? "";
      if (res.status >= 400) throw Object.assign(new Error(`сайт ответил ошибкой ${res.status}`), { http: res.status, html });
      return { url: res.finalUrl, html };
    } catch (e) {
      if (signal.aborted) throw signal.reason;
      lastError = e;
      if (e.http) break;
    }
  }
  throw lastError;
}

/** Reads the site as HTML: pages (links + sitemap), then stylesheets. */
async function collectByHttp(host, home, ses, signal, onStep) {
  const bag = imageBag();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(COLLECT_DEADLINE)]);
  const seen = new Set([pageKey(home.url)]);
  // Links first, breadth-first; sitemap pages only when links run dry — on a
  // city × service site the sitemap alone would fill the page limit with cities.
  const queue = [];
  const fromSitemap = [];
  const styles = new Set();
  let pages = 0;
  let taken = 1;
  let partial = false;
  let active = 0;

  const enqueue = (link, list = queue) => {
    const t = crawlTarget(link, host);
    if (!t || seen.has(pageKey(t))) return;
    seen.add(pageKey(t));
    list.push(t);
  };
  const next = () => {
    if (taken >= MAX_PAGES) {
      if (queue.length || fromSitemap.length) partial = true;
      return null;
    }
    const url = queue.shift() ?? fromSitemap.shift();
    if (url) taken++;
    return url;
  };
  const take = (url, html) => {
    pages++;
    const ex = extractFromHtml(html, url);
    bag.add(ex.images, url);
    for (const s of ex.styles) if (styles.size < MAX_STYLES) styles.add(s);
    ex.links.forEach((l) => enqueue(l));
    onStep(`страниц ${pages} · кадров ${bag.images.size}`);
    return ex;
  };

  const homeEx = take(home.url, home.html);

  // The sitemap names pages a script menu hides; a sitemap index — its children.
  // It counts as work in progress, so page workers wait for it before quitting.
  active++;
  const sitemap = (async () => {
    try {
      const origin = new URL(home.url).origin;
      const maps = [`${origin}/sitemap.xml`];
      for (let i = 0; i < maps.length && i < 4; i++) {
        const res = await get(ses, maps[i], { signal: deadline, accept: "application/xml,text/xml,*/*" });
        if (!res.ok) continue;
        const { index, locs } = extractFromSitemap((await readText(res, true)) ?? "");
        if (index) maps.push(...locs.filter((l) => sameSite(l, host)));
        else locs.forEach((l) => enqueue(l, fromSitemap));
      }
    } catch {
      /* no sitemap — links are enough */
    } finally {
      active--;
    }
  })();

  const worker = async () => {
    for (;;) {
      if (deadline.aborted) return;
      const url = next();
      if (!url) {
        if (active === 0 || taken >= MAX_PAGES) return;
        await sleep(30);
        continue;
      }
      active++;
      try {
        const res = await get(ses, url, { signal: deadline, accept: HTML_ACCEPT });
        const html = res.ok ? await readText(res) : null;
        if (html && sameSite(res.finalUrl, host)) take(res.finalUrl, html);
      } catch {
        /* an inner page that fails is skipped, not fatal */
      } finally {
        active--;
      }
    }
  };
  await Promise.all([sitemap, ...Array.from({ length: PAGES_AT_ONCE }, worker)]);
  if (deadline.aborted && !signal.aborted && (queue.length || fromSitemap.length)) partial = true;
  if (signal.aborted) throw signal.reason;

  const styleLimit = createLimiter(PAGES_AT_ONCE);
  await Promise.all(
    [...styles].map((s) =>
      styleLimit(async () => {
        try {
          const res = await get(ses, s, { signal, accept: "text/css,*/*;q=0.1" });
          if (res.ok) bag.add(extractFromCss((await readText(res, true)) ?? "", s), home.url);
        } catch {
          /* a stylesheet that fails only hides its backgrounds */
        }
      }),
    ),
  );

  return { images: bag.images, pages, partial, scriptApp: homeEx.scriptApp };
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

/** Loads a URL in the window; resolves with the HTTP status of the main document. Timeouts are not fatal. */
async function loadPage(win, url) {
  const wc = win.webContents;
  let status = 0;
  const onNav = (_e, _u, code) => {
    status = code;
  };
  wc.on("did-navigate", onNav);
  try {
    await withTimeout(wc.loadURL(url), BROWSER_PAGE_TIMEOUT, "timeout");
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

/** The slow way for script-drawn sites and anti-bot walls: a hidden browser, a few pages. */
async function collectByBrowser(host, ses, signal, onStep) {
  const bag = imageBag();
  const win = openWindow(ses);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(COLLECT_DEADLINE)]);
  try {
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
    if (!home) throw lastError;
    const seen = new Set([pageKey(home)]);
    const queue = [];
    let pages = 0;
    let url = home;
    while (url && !deadline.aborted) {
      if (url !== home) {
        try {
          if ((await loadPage(win, url)) >= 400) url = null;
        } catch {
          url = null;
        }
      }
      if (url) {
        pages++;
        onStep(`браузер: страниц ${pages} · кадров ${bag.images.size}`);
        const found = await withTimeout(win.webContents.executeJavaScript(collectScript), 45_000, "collect").catch(() => null);
        if (found) {
          bag.add(found.images, found.finalUrl);
          for (const link of found.links) {
            const t = crawlTarget(link, host);
            if (t && !seen.has(pageKey(t)) && seen.size < BROWSER_PAGES) {
              seen.add(pageKey(t));
              queue.push(t);
            }
          }
        }
      }
      url = queue.shift();
    }
    if (signal.aborted) throw signal.reason;
    return { images: bag.images, pages, partial: deadline.aborted || seen.size >= BROWSER_PAGES };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * A scan that sites can be added to while it runs. onSite(result) fires as
 * each site finishes, onProgress({ host, step }) while it works. A bad key or
 * an empty balance stops everything: `done` rejects with FatalKeyError.
 * `cacheFile` keeps the model's answers between runs (optional);
 * `classifyImage` replaces the model in the self-test.
 */
function createScan({ creds, signal, onSite, onProgress, cacheFile, classifyImage = classify }) {
  const inner = new AbortController();
  const stop = AbortSignal.any([signal, inner.signal]);
  const ses = scanSession(`${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const cache = cacheFile ? createVerdictCache(cacheFile) : { get: () => null, set() {}, flush() {} };
  const model = creds.model || providerOf(creds.provider).visionModel;
  const downloads = createLimiter(DOWNLOADS_AT_ONCE);
  const browsers = createLimiter(BROWSERS_AT_ONCE);
  let fatal = null;

  const failFatal = (e) => {
    if (e instanceof FatalKeyError) {
      fatal ??= e;
      inner.abort(e);
    }
  };

  const modelCalls = createLimiter(MODEL_CALLS_AT_ONCE);
  const ask = (jpeg) =>
    modelCalls(() => (stop.aborted ? Promise.reject(stop.reason) : classifyImage(creds, jpeg, { signal: stop })));

  // One job per file URL for the whole run: shared by every site that shows it.
  // Holds only what a result needs — the thumbnail stays for people and doubts.
  const jobs = new Map();
  function imageJob(download) {
    if (!jobs.has(download)) {
      jobs.set(
        download,
        (async () => {
          let raw;
          let prepared;
          try {
            raw = await downloads(() => (stop.aborted ? Promise.reject(stop.reason) : fetchImage(ses, download, stop)));
            prepared = await prepareImage(raw);
          } catch {
            return null; // unreachable or broken file — not a visible photo
          }
          if (!prepared) return null;
          const meta = { width: prepared.width, height: prepared.height, bytes: prepared.bytes, format: prepared.format };
          const cacheKey = `${model}:${crypto.createHash("sha1").update(raw).digest("hex")}`;
          let kind = cache.get(cacheKey);
          if (!kind) {
            try {
              kind = await ask(prepared.forModel);
              cache.set(cacheKey, kind);
            } catch (e) {
              failFatal(e);
              return { ...meta, kind: null };
            }
          }
          const keepThumb = kind === "face" || kind === "body" || kind === "unsure";
          return { ...meta, kind, thumb: keepThumb ? prepared.thumb : null };
        })(),
      );
    }
    return jobs.get(download);
  }

  async function collect(host, step) {
    let home;
    try {
      home = await openHome(host, ses, stop);
    } catch (e) {
      if (stop.aborted) throw stop.reason;
      // A wall (403, 503, a challenge page) may let a browser in; a dead domain will not.
      if (!(e.http && BLOCKED_STATUS.has(e.http))) throw e;
      return browsers(() => collectByBrowser(host, ses, stop, step));
    }
    if (CHALLENGE.test(home.html.slice(0, 20_000)) && home.html.length < 50_000) {
      return browsers(() => collectByBrowser(host, ses, stop, step));
    }
    const http = await collectByHttp(host, home, ses, stop, step);
    if (http.images.size === 0 || (http.scriptApp && http.images.size < 5)) {
      try {
        const viaBrowser = await browsers(() => collectByBrowser(host, ses, stop, step));
        for (const [k, v] of viaBrowser.images) if (!http.images.has(k)) http.images.set(k, v);
      } catch (e) {
        if (stop.aborted) throw stop.reason;
        /* the HTML result stands */
      }
    }
    return http;
  }

  async function scanSite(host) {
    const started = Date.now();
    const result = { host, pages: 0, images: 0, people: [], unsure: [], unchecked: 0, error: null, note: null };
    const step = (s) => onProgress({ host, step: s });
    try {
      step("открываю сайт");
      const { images, pages, partial } = await collect(host, step);
      result.pages = pages;
      const list = [...images.values()];
      let done = 0;
      step(`кадры 0 из ${list.length}`);
      const outcomes = list.map((img) =>
        imageJob(img.download).then((out) => {
          step(`кадры ${++done} из ${list.length}`);
          return out;
        }),
      );
      const late = Symbol("late");
      const timer = sleep(Math.max(0, SITE_DEADLINE - (Date.now() - started))).then(() => late);
      const settled = await Promise.all(outcomes.map((p) => Promise.race([p, timer])));
      if (stop.aborted) return; // stopped mid-site — leave it for the next run
      let lateCount = 0;
      settled.forEach((out, i) => {
        if (out === late) {
          lateCount++;
          result.unchecked++;
          return;
        }
        if (!out) return;
        result.images++;
        if (!out.kind) {
          result.unchecked++;
          return;
        }
        const img = list[i];
        const entry = {
          id: imageId(img.download),
          url: img.download,
          page: img.page,
          thumb: out.thumb,
          width: out.width,
          height: out.height,
          bytes: out.bytes,
          format: out.format,
        };
        if (out.kind === "face" || out.kind === "body") result.people.push({ ...entry, kind: out.kind });
        else if (out.kind === "unsure") result.unsure.push(entry);
      });
      const notes = [];
      if (partial) notes.push(`сайт большой — прочитаны ${plural(pages, "страница", "страницы", "страниц")}`);
      if (lateCount) notes.push(`не успели проверить кадров: ${lateCount}`);
      result.note = notes.join("; ") || null;
    } catch (e) {
      if (stop.aborted) return;
      result.error = friendlyError(e);
    }
    result.verdict = verdictOf(result);
    result.checkedAt = new Date().toISOString();
    onSite(result);
  }

  // A queue that grows while it runs: sites added later join the same pipeline.
  const queue = [];
  const inFlight = new Set();
  let finish;
  const done = new Promise((r) => {
    finish = r;
  });
  function pump() {
    while (inFlight.size < SITES_AT_ONCE && queue.length && !stop.aborted) {
      const host = queue.shift();
      inFlight.add(host);
      scanSite(host)
        .catch(() => {})
        .finally(() => {
          inFlight.delete(host);
          pump();
          if (inFlight.size === 0 && (queue.length === 0 || stop.aborted)) {
            cache.flush();
            ses.clearStorageData().catch(() => {});
            finish();
          }
        });
    }
  }

  return {
    /** Adds hosts not already waiting or in work; returns how many were added. */
    add(hosts) {
      if (stop.aborted) return 0;
      let n = 0;
      for (const h of hosts) {
        if (!queue.includes(h) && !inFlight.has(h)) {
          queue.push(h);
          n++;
        }
      }
      pump();
      return n;
    },
    isQueued: (host) => queue.includes(host) || inFlight.has(host),
    done: done.then(() => {
      if (fatal) throw fatal;
    }),
  };
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  const word = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${word}`;
}

/** The whole list at once — for the developer CLI. */
async function scanSites({ hosts, ...opts }) {
  const scan = createScan(opts);
  if (!scan.add(hosts)) return;
  await scan.done;
}

let viewerSession = null;
/** One file for the viewer and redraws — the same network rules as the scan. */
function downloadImage(url, signal) {
  viewerSession ??= scanSession("viewer");
  return fetchImage(viewerSession, url, signal);
}

module.exports = { createScan, scanSites, downloadImage, UA };
