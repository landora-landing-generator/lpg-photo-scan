"use strict";

const path = require("node:path");
const { createLimiter } = require("./limit");
const fs = require("node:fs");
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require("electron");
const sharp = require("sharp");
const { createScan } = require("./scanner");
const { parseDomains, displayHost, displayUrl } = require("./domains");
const { checkKey, providerList, FatalKeyError, PROVIDERS, drawModelsFor, findDrawModel, catalogDrawModels } = require("./providers");
const { writeExcel } = require("./excel");
const { loadSettings, saveSettings, updateDrawList, setDrawModel, loadCatalogs, saveCatalog, credsFor, loadState, saveState, findImage } = require("./store");
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
let running = null; // { ctrl, scan } of the scan in progress
let redrawing = null; // AbortController of a batch redraw (checkboxes)
const jobs = { viewer: null, studio: null }; // AbortController of a single drawing per window part

/**
 * A service that never answers must not hang the button forever. Longer than
 * the drawing's own 5-minute deadline (draw.js) plus describing the old frame.
 */
const DRAW_TIMEOUT = 8 * 60_000;
const DRAW_TIMEOUT_TEXT = "Сервис не ответил за 8 минут. Попробуйте ещё раз или выберите другую модель.";

/** Runs one drawing job that the user can cancel; turns abort/timeout into plain words. */
async function cancellable(slot, fn) {
  jobs[slot]?.abort();
  const ctrl = new AbortController();
  jobs[slot] = ctrl;
  const signal = AbortSignal.any([ctrl.signal, AbortSignal.timeout(DRAW_TIMEOUT)]);
  try {
    return await fn(signal);
  } catch (e) {
    if (ctrl.signal.aborted) return { error: "Отменено.", cancelled: true };
    if (signal.aborted) return { error: DRAW_TIMEOUT_TEXT };
    return { error: e.message || String(e) };
  } finally {
    if (jobs[slot] === ctrl) jobs[slot] = null;
  }
}

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
  // The window shows the last list at once; the fresh catalog replaces it when it arrives.
  win.webContents.once("did-finish-load", () => refreshCatalog(loadSettings().provider));
  // Links in the window open in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  // Hidden scan windows must not keep the app alive once the user closed it.
  win.on("closed", () => {
    running?.ctrl.abort(new Error("closed"));
    redrawing?.abort(new Error("closed"));
    jobs.viewer?.abort();
    jobs.studio?.abort();
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

/** Settings plus each service's drawing-model list as the user shaped it. */
function settingsView() {
  const settings = loadSettings();
  const catalogs = loadCatalogs();
  const drawModels = Object.fromEntries(
    Object.keys(PROVIDERS).map((id) => [id, drawModelsFor(id, settings.drawLists[id], catalogs[id]?.models)]),
  );
  return { settings, drawModels };
}

/** Each service's list as the user shaped it, over the catalog in force. */
const listOf = (provider) => drawModelsFor(provider, loadSettings().drawLists[provider], loadCatalogs()[provider]?.models);

/**
 * Downloads the service's drawing models: new ones appear in the list, gone
 * ones leave it. Runs at start and after a key is saved; a failure keeps the
 * last catalog (or the built-in list) and says nothing — drawing still works.
 */
async function refreshCatalog(provider) {
  const apiKey = loadSettings().keys[provider];
  if (!apiKey) return;
  try {
    saveCatalog(provider, await catalogDrawModels({ provider, apiKey }));
    send("draw-models:changed", settingsView());
  } catch {
    /* offline or the service is down — keep what we have */
  }
}

ipcMain.handle("state:get", () => ({
  ...settingsView(),
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
    if (apiKey) refreshCatalog(provider);
    return apiKey ? checkKey({ provider, apiKey }) : { ok: false, message: "Вставьте ключ." };
  }),
);

/** The drawing model picked in the viewer or studio — remembered for next time. */
ipcMain.handle("settings:draw-model", (_e, model) => setDrawModel(model));

/** A model typed by the user joins the list only if the service's catalog says it draws. */
ipcMain.handle(
  "draw-models:add",
  guarded(async (_e, { provider, id }) => {
    const apiKey = loadSettings().keys[provider];
    if (!apiKey) throw new Error("Сначала вставьте ключ этого сервиса и нажмите «Сохранить».");
    const model = await findDrawModel({ provider, apiKey }, id);
    const preset = (loadCatalogs()[provider]?.models ?? PROVIDERS[provider].drawModels).some((m) => m.id === model.id);
    updateDrawList(provider, (l) => ({
      added: preset || l.added.some((m) => m.id === model.id) ? l.added : [...l.added, model],
      removed: l.removed.filter((x) => x !== model.id),
    }));
    return { ...settingsView(), added: model };
  }),
);

ipcMain.handle(
  "draw-models:remove",
  guarded(async (_e, { provider, id }) => {
    const before = listOf(provider);
    if (before.length <= 1) throw new Error("Последнюю модель убрать нельзя — рисовать будет нечем.");
    updateDrawList(provider, (l) => ({
      added: l.added.filter((m) => m.id !== id),
      removed: [...new Set([...l.removed, id])],
    }));
    // The model in use went away: the first one left takes its place.
    const s = loadSettings();
    if (s.provider === provider && (s.models.draw || PROVIDERS[provider].drawModel) === id) {
      setDrawModel(listOf(provider)[0].id);
    }
    return settingsView();
  }),
);

ipcMain.handle(
  "draw-models:reset",
  guarded(async (_e, { provider }) => {
    updateDrawList(provider, null);
    const s = loadSettings();
    const list = listOf(provider);
    if (s.provider === provider && s.models.draw && !list.some((m) => m.id === s.models.draw)) setDrawModel("");
    return settingsView();
  }),
);

ipcMain.handle("url:display", (_e, urls) => urls.map(displayUrl));

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
          { name: "Excel, CSV, текст", extensions: ["xlsx", "xlsm", "xls", "ods", "csv", "tsv", "txt"] },
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

ipcMain.handle("scan:stop", () => running?.ctrl.abort(new Error("stopped")));

/** A site's fresh result replaces the old one; frames already drawn for the same images stay. */
function saveSiteResult(result) {
  const s = loadState();
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
}

/**
 * Scans listed domains without a saved result (all of them with `again`), or
 * exactly `hosts` — one site or the failed ones. Sites asked for while a scan
 * runs join it; nothing already done is scanned again.
 */
ipcMain.handle("scan:start", async (_e, { domainsText, again, hosts: only }) => {
  if (running) {
    if (!only?.length) return { error: "Проверка уже идёт." };
    if (running.ctrl.signal.aborted) return { error: "Проверка останавливается — нажмите ещё раз через пару секунд." };
    const added = running.scan.add(only);
    if (added) send("scan:more", { added, hosts: only });
    return { ok: true, added };
  }
  const creds = credsFor("recognize");
  if (!creds.apiKey) return { error: "Сначала вставьте ключ и нажмите «Сохранить»." };
  const state = loadState();
  let todo;
  if (only?.length) todo = only;
  else {
    state.domainsText = domainsText;
    saveState(state);
    const hosts = parseDomains(domainsText);
    if (!hosts.length) return { error: "В списке нет ни одного домена." };
    todo = again ? hosts : hosts.filter((h) => !state.results[h]);
    if (!todo.length) return { error: "Все сайты из списка уже проверены. Нажмите «Проверить заново», если нужно." };
  }

  const ctrl = new AbortController();
  const scan = createScan({
    creds,
    signal: ctrl.signal,
    cacheFile: path.join(app.getPath("userData"), "verdicts.json"),
    onProgress: (p) => send("scan:progress", p),
    onSite: saveSiteResult,
  });
  running = { ctrl, scan };
  send("scan:begin", { total: todo.length, hosts: todo });
  // Nothing queued would leave `done` unsettled and block every later scan.
  if (!scan.add(todo)) {
    running = null;
    send("scan:end", { stopped: false, fatal: null });
    return { ok: true };
  }
  let fatal = null;
  try {
    await scan.done;
  } catch (e) {
    fatal = e instanceof FatalKeyError ? e.message : null;
  }
  const stopped = ctrl.signal.aborted && !fatal;
  running = null;
  send("scan:end", { stopped, fatal });
  return { ok: true };
});

// ---------- images: view, redraw, save ----------

ipcMain.handle("image:original", guarded((_e, { host, id }) => originalPreview(host, id)));
ipcMain.handle("image:redrawn", (_e, { host, id }) => redrawPreview(host, id));
ipcMain.handle("image:redraw", (_e, { host, id, prompt }) =>
  cancellable("viewer", async (signal) => {
    const img = await redrawImage(host, id, { prompt, signal, onStep: (step) => send("image:step", { id, step }) });
    send("image:updated", { host, image: img });
    return { image: img, preview: redrawPreview(host, id) };
  }),
);
ipcMain.handle("image:redraw-cancel", () => jobs.viewer?.abort());

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
  "sites:save",
  guarded(async (_e, { hosts }) => {
    const results = loadState().results;
    const ready = hosts.filter((h) => imagesOfResult(results[h]).some((img) => img.redraw));
    if (!ready.length) return { error: "У выбранных сайтов ещё нет перерисованных кадров." };
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: ready.length > 1 ? `Куда сохранить новые кадры ${ready.length} сайтов` : "Куда сохранить новые кадры сайта",
      defaultPath: app.getPath("downloads"),
      properties: ["openDirectory", "createDirectory"],
    });
    if (canceled || !filePaths?.[0]) return { saved: false };
    let count = 0;
    for (const host of ready) count += exportSite(host, filePaths[0]).count;
    // One site: its own folder; several: the folder that holds them all.
    shell.openPath(ready.length === 1 ? path.join(filePaths[0], ready[0]) : filePaths[0]);
    return { saved: true, sites: ready.length, count };
  }),
);

ipcMain.handle("redraw:stop", () => redrawing?.abort(new Error("stopped")));

const imagesOfResult = (r) => [...(r?.people ?? []), ...(r?.unsure ?? [])];

/** Drawings of a batch at once: the services draw in parallel, three keeps rate limits calm. */
const BATCH_DRAWS = 3;

/**
 * Redraws a batch of frames picked with checkboxes — on one site or across
 * several. Frames that already have a new version are skipped. A bad key or an
 * empty balance stops the batch; any other failure is counted and the rest go on.
 */
ipcMain.handle(
  "redraw:batch",
  guarded(async (_e, { items }) => {
    if (redrawing) return { error: "Перерисовка уже идёт." };
    const results = loadState().results;
    const todo = (items ?? []).filter(({ host, id }) => {
      const img = findImage({ results }, host, id);
      return img && !img.redraw;
    });
    if (!todo.length) return { error: "Все выбранные кадры уже перерисованы." };
    const ctrl = new AbortController();
    redrawing = ctrl;
    const hosts = [...new Set(todo.map((t) => t.host))];
    let done = 0;
    const errors = [];
    let fatal = null;
    const progress = (finished = false) => send("redraw:progress", { hosts, done, total: todo.length, finished });
    progress();
    const run = createLimiter(BATCH_DRAWS);
    try {
      await Promise.all(
        todo.map(({ host, id }) =>
          run(async () => {
            if (ctrl.signal.aborted) return;
            const cap = AbortSignal.timeout(DRAW_TIMEOUT);
            try {
              const updated = await redrawImage(host, id, { signal: AbortSignal.any([ctrl.signal, cap]) });
              send("image:updated", { host, image: updated });
            } catch (e) {
              if (e instanceof FatalKeyError) {
                fatal = e.message;
                ctrl.abort(e);
              } else if (!ctrl.signal.aborted) errors.push(cap.aborted ? DRAW_TIMEOUT_TEXT : e.message);
            }
            done++;
            progress();
          }),
        ),
      );
    } finally {
      redrawing = null;
      progress(true);
    }
    if (fatal) return { error: fatal };
    return { done: done - errors.length, total: todo.length, errors, stopped: ctrl.signal.aborted };
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
ipcMain.handle("studio:generate", (_e, params) => cancellable("studio", (signal) => generate({ ...params, signal })));
ipcMain.handle("studio:cancel", () => jobs.studio?.abort());
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

const selftestArg = process.argv.find((a) => a.startsWith("--selftest"));

app.whenReady().then(async () => {
  if (selftestArg) {
    // Packaged-app check for CI: prints every check, exit code 1 on any failure.
    const checks = await require("./selftest").run();
    for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}  ${c.detail}`);
    const out = selftestArg.split("=")[1];
    if (out) fs.writeFileSync(out, JSON.stringify(checks, null, 2));
    app.exit(checks.every((c) => c.ok) ? 0 : 1);
    return;
  }
  createWindow();
  checkForUpdate(app.getVersion()).then((u) => u && send("update:available", u));
});
app.on("window-all-closed", () => {
  if (!selftestArg) app.quit();
});
