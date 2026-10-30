"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require("electron");
const sharp = require("sharp");
const { scanSites } = require("./scanner");
const { parseDomains, displayHost } = require("./domains");
const { checkKey, providerList, FatalKeyError } = require("./providers");
const { writeExcel } = require("./excel");
const { loadSettings, saveSettings, credsFor, loadState, saveState, findImage } = require("./store");
const { originalPreview, redrawPreview, redrawImage, exportOne, exportSite } = require("./redraw");
const { baseName } = require("./redraw-names");
const { domainsFromFile } = require("./import");
const { checkForUpdate } = require("./update");
const { DEFAULT_REDRAW_RULES } = require("./prompts");
const { loadReference, generate, exportStudio } = require("./studio");

// Developer aids: a separate data folder and a forced theme for screenshots.
if (process.env.LPG_USER_DATA) app.setPath("userData", process.env.LPG_USER_DATA);

// One image at a time through libvips: the scan should not load the computer.
sharp.concurrency(1);

let win = null;
let running = null; // AbortController of the scan in progress
let redrawing = null; // AbortController of a site-wide redraw

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 760,
    minHeight: 560,
    title: "Поиск людей на сайтах",
    backgroundColor: "#f6f7f9",
    webPreferences: { preload: path.join(__dirname, "preload.js"), sandbox: true },
  });
  win.removeMenu?.();
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  // Links in the window open in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  // Hidden scan windows must not keep the app alive once the user closed it.
  win.on("closed", () => {
    running?.abort(new Error("closed"));
    redrawing?.abort(new Error("closed"));
    app.quit();
  });

  // Developer aid: LPG_DEBUG=1 prints the window's console to the terminal.
  if (process.env.LPG_DEBUG) {
    win.webContents.on("console-message", (e) => console.log(`[window] ${e.level}: ${e.message}`));
    win.webContents.on("preload-error", (_e, p, err) => console.log(`[preload] ${p}: ${err}`));
  }

  const shot = process.argv.find((a) => a.startsWith("--shot="));
  if (shot) {
    if (process.env.LPG_THEME) nativeTheme.themeSource = process.env.LPG_THEME;
    if (process.env.LPG_SIZE) win.setContentSize(...process.env.LPG_SIZE.split("x").map(Number));
    win.webContents.once("did-finish-load", () =>
      setTimeout(async () => {
        if (process.env.LPG_SHOT_JS) {
          await win.webContents.executeJavaScript(process.env.LPG_SHOT_JS);
          await new Promise((r) => setTimeout(r, 1200));
        }
        const img = await win.webContents.capturePage();
        fs.writeFileSync(shot.slice(7), img.toPNG());
        app.quit();
      }, 1500),
    );
  }
}

const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

/** Errors cross IPC as { error } — the renderer shows the text as is. */
const guarded =
  (fn) =>
  async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      return { error: e.message || String(e) };
    }
  };

// ---------- state, keys ----------

ipcMain.handle("state:get", () => ({
  settings: loadSettings(),
  providers: providerList(),
  defaultRedrawRules: DEFAULT_REDRAW_RULES,
  version: app.getVersion(),
  ...loadState(),
}));

/** Saves the service, its key and models, then checks the key. */
ipcMain.handle(
  "settings:save",
  guarded(async (_e, { provider, key, models, redrawRules }) => {
    const apiKey = String(key ?? "").trim();
    saveSettings({ provider, key: apiKey, models, redrawRules });
    return apiKey ? checkKey({ provider, apiKey }) : { ok: false, message: "Вставьте ключ." };
  }),
);

ipcMain.handle("domains:parse", (_e, text) => parseDomains(text).map((host) => ({ host, label: displayHost(host) })));

/** Domains from files: picked in a dialog (no paths) or dropped onto the list (paths). */
ipcMain.handle(
  "domains:import",
  guarded(async (_e, { paths } = {}) => {
    let files = paths;
    if (!files?.length) {
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: "Файл со списком сайтов",
        properties: ["openFile", "multiSelections"],
        filters: [
          { name: "Excel, CSV, текст", extensions: ["xlsx", "xlsm", "csv", "tsv", "txt"] },
          { name: "Все файлы", extensions: ["*"] },
        ],
      });
      if (canceled) return { domains: [] };
      files = filePaths;
    }
    const domains = [];
    for (const file of files) domains.push(...(await domainsFromFile(file)));
    if (!domains.length) return { error: "В файле не нашлось ни одного домена." };
    return { domains: domains.map(displayHost) };
  }),
);
ipcMain.handle("open:external", (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

// ---------- scan ----------

ipcMain.handle("results:clear", () => {
  const state = loadState();
  saveState({ domainsText: state.domainsText, results: {} });
});

ipcMain.handle("scan:stop", () => running?.abort(new Error("stopped")));

/** Scans, one site at a time, every listed domain without a saved result (or all of them with `again`). */
ipcMain.handle("scan:start", async (_e, { domainsText, again }) => {
  if (running) return { error: "Проверка уже идёт." };
  const creds = credsFor("recognize");
  if (!creds.apiKey) return { error: "Сначала вставьте ключ и нажмите «Сохранить»." };
  const state = loadState();
  state.domainsText = domainsText;
  const hosts = parseDomains(domainsText);
  if (!hosts.length) return { error: "В списке нет ни одного домена." };
  const todo = again ? hosts : hosts.filter((h) => !state.results[h]);
  saveState(state);
  if (!todo.length) return { error: "Все сайты из списка уже проверены. Нажмите «Проверить заново», если нужно." };

  running = new AbortController();
  send("scan:begin", { total: todo.length });
  let fatal = null;
  try {
    await scanSites({
      hosts: todo,
      creds,
      signal: running.signal,
      onProgress: (p) => send("scan:progress", p),
      onSite: (result) => {
        const s = loadState();
        // A re-scan keeps frames already drawn for the same images.
        const old = s.results[result.host];
        if (old) {
          for (const img of [...result.people, ...result.unsure]) {
            const prev = [...old.people, ...old.unsure].find((o) => o.id === img.id);
            if (prev?.redraw) img.redraw = prev.redraw;
          }
        }
        s.results[result.host] = result;
        saveState(s);
        send("scan:site", result);
      },
    });
  } catch (e) {
    fatal = e instanceof FatalKeyError ? e.message : null;
  }
  const stopped = running.signal.aborted && !fatal;
  running = null;
  send("scan:end", { stopped, fatal });
  return { ok: true };
});

// ---------- images: view, redraw, save ----------

ipcMain.handle("image:original", guarded((_e, { host, id }) => originalPreview(host, id)));
ipcMain.handle("image:redrawn", (_e, { host, id }) => redrawPreview(host, id));
ipcMain.handle(
  "image:redraw",
  guarded(async (_e, { host, id, prompt }) => {
    const img = await redrawImage(host, id, { prompt });
    send("image:updated", { host, image: img });
    return { image: img, preview: redrawPreview(host, id) };
  }),
);

ipcMain.handle(
  "image:save",
  guarded(async (_e, { host, id }) => {
    const img = findImage(loadState(), host, id);
    if (!img?.redraw) return { error: "Сначала перерисуйте кадр." };
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: "Сохранить новый кадр",
      defaultPath: path.join(app.getPath("downloads"), `${baseName(img.url)}.jpg`),
      filters: [{ name: "JPEG", extensions: ["jpg"] }],
    });
    if (canceled || !filePath) return { saved: false };
    exportOne(host, id, filePath);
    shell.showItemInFolder(filePath);
    return { saved: true, filePath };
  }),
);

ipcMain.handle(
  "site:save",
  guarded(async (_e, { host }) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: "Куда сохранить новые кадры сайта",
      defaultPath: app.getPath("downloads"),
      properties: ["openDirectory", "createDirectory"],
    });
    if (canceled || !filePaths?.[0]) return { saved: false };
    const { dir, count } = exportSite(host, filePaths[0]);
    shell.openPath(dir);
    return { saved: true, dir, count };
  }),
);

ipcMain.handle("site:redraw-stop", () => redrawing?.abort(new Error("stopped")));

/** Redraws, one by one, every image with people on a site that has no new version yet. */
ipcMain.handle(
  "site:redraw",
  guarded(async (_e, { host }) => {
    if (redrawing) return { error: "Перерисовка уже идёт." };
    const r = loadState().results[host];
    const todo = (r?.people ?? []).filter((img) => !img.redraw);
    if (!todo.length) return { error: "Все кадры с людьми на этом сайте уже перерисованы." };
    redrawing = new AbortController();
    let done = 0;
    const errors = [];
    try {
      for (const img of todo) {
        if (redrawing.signal.aborted) break;
        send("site:redraw-progress", { host, done, total: todo.length });
        try {
          const updated = await redrawImage(host, img.id, { signal: redrawing.signal });
          send("image:updated", { host, image: updated });
        } catch (e) {
          if (e instanceof FatalKeyError) throw e;
          if (!redrawing.signal.aborted) errors.push(e.message);
        }
        done++;
      }
    } finally {
      redrawing = null;
      send("site:redraw-progress", { host, done, total: todo.length, finished: true });
    }
    return { done, total: todo.length, errors };
  }),
);

// ---------- studio: a frame from the user's picture or from words ----------

/** Reference picture: a dropped file (path) or one picked in a dialog. */
ipcMain.handle(
  "studio:reference",
  guarded(async (_e, { path: dropped } = {}) => {
    let file = dropped;
    if (!file) {
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: "Картинка-образец",
        properties: ["openFile"],
        filters: [{ name: "Картинки", extensions: ["jpg", "jpeg", "png", "webp", "avif", "gif", "bmp", "tif", "tiff", "heic"] }],
      });
      if (canceled || !filePaths?.[0]) return { canceled: true };
      file = filePaths[0];
    }
    return loadReference(file);
  }),
);
ipcMain.handle("studio:generate", guarded((_e, params) => generate(params)));
ipcMain.handle(
  "studio:save",
  guarded(async (_e, { file }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: "Сохранить кадр",
      defaultPath: path.join(app.getPath("downloads"), file),
      filters: [{ name: "JPEG", extensions: ["jpg"] }],
    });
    if (canceled || !filePath) return { saved: false };
    exportStudio(file, filePath);
    shell.showItemInFolder(filePath);
    return { saved: true, filePath };
  }),
);

ipcMain.handle(
  "excel:save",
  guarded(async () => {
    const state = loadState();
    const hosts = parseDomains(state.domainsText);
    const stamp = new Date().toISOString().slice(0, 10);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: "Сохранить в Excel",
      defaultPath: path.join(app.getPath("documents"), `people-on-sites-${stamp}.xlsx`),
      filters: [{ name: "Excel", extensions: ["xlsx"] }],
    });
    if (canceled || !filePath) return { saved: false };
    await writeExcel(filePath, hosts, state.results);
    shell.showItemInFolder(filePath);
    return { saved: true, filePath };
  }),
);

app.setAboutPanelOptions({
  applicationName: "Поиск людей на сайтах",
  copyright: "© 2026 Андрей Цибин",
  authors: ["Андрей Цибин"],
});

app.whenReady().then(() => {
  createWindow();
  checkForUpdate(app.getVersion()).then((u) => u && send("update:available", u));
});
app.on("window-all-closed", () => app.quit());
