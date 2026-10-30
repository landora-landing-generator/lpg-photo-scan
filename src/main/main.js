"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const { scanSites } = require("./scanner");
const { parseDomains } = require("./domains");
const { checkKey, providerList, FatalKeyError } = require("./classify");
const { writeExcel } = require("./excel");
const { loadSettings, saveKey, activeCreds, loadState, saveState } = require("./store");
const { checkForUpdate } = require("./update");

let win = null;
let running = null; // AbortController of the scan in progress

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
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
    app.quit();
  });

  const shot = process.argv.find((a) => a.startsWith("--shot="));
  if (shot) {
    win.webContents.once("did-finish-load", () =>
      setTimeout(async () => {
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

ipcMain.handle("state:get", () => ({
  ...loadSettings(),
  providers: providerList(),
  version: app.getVersion(),
  ...loadState(),
}));
ipcMain.handle("key:save", (_e, { provider, key }) => saveKey(provider, String(key).trim()));
ipcMain.handle("key:check", (_e, { provider, key }) => checkKey({ provider, apiKey: String(key).trim() }));
ipcMain.handle("domains:parse", (_e, text) => parseDomains(text));
ipcMain.handle("open:external", (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

ipcMain.handle("results:clear", () => {
  const state = loadState();
  saveState({ domainsText: state.domainsText, results: {} });
});

ipcMain.handle("scan:stop", () => running?.abort(new Error("stopped")));

/** Scans every listed domain that has no saved result yet (or all of them with `again`). */
ipcMain.handle("scan:start", async (_e, { domainsText, again }) => {
  if (running) return { error: "Проверка уже идёт." };
  const creds = activeCreds();
  if (!creds.apiKey) return { error: "Сначала вставьте ключ и нажмите «Сохранить и проверить»." };
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

ipcMain.handle("excel:save", async () => {
  const state = loadState();
  const hosts = parseDomains(state.domainsText);
  const stamp = new Date().toISOString().slice(0, 10);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: "Сохранить в Excel",
    defaultPath: path.join(app.getPath("documents"), `люди-на-сайтах-${stamp}.xlsx`),
    filters: [{ name: "Excel", extensions: ["xlsx"] }],
  });
  if (canceled || !filePath) return { saved: false };
  await writeExcel(filePath, hosts, state.results);
  shell.showItemInFolder(filePath);
  return { saved: true, filePath };
});

app.whenReady().then(() => {
  createWindow();
  checkForUpdate(app.getVersion()).then((u) => u && send("update:available", u));
});
app.on("window-all-closed", () => app.quit());
