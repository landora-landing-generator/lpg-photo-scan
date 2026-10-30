"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const on = (channel) => (fn) => ipcRenderer.on(channel, (_e, payload) => fn(payload));

contextBridge.exposeInMainWorld("api", {
  getState: () => ipcRenderer.invoke("state:get"),
  saveKey: (provider, key) => ipcRenderer.invoke("key:save", { provider, key }),
  checkKey: (provider, key) => ipcRenderer.invoke("key:check", { provider, key }),
  parseDomains: (text) => ipcRenderer.invoke("domains:parse", text),
  startScan: (domainsText, again) => ipcRenderer.invoke("scan:start", { domainsText, again }),
  stopScan: () => ipcRenderer.invoke("scan:stop"),
  clearResults: () => ipcRenderer.invoke("results:clear"),
  saveExcel: () => ipcRenderer.invoke("excel:save"),
  openExternal: (url) => ipcRenderer.invoke("open:external", url),
  onBegin: on("scan:begin"),
  onProgress: on("scan:progress"),
  onSite: on("scan:site"),
  onEnd: on("scan:end"),
  onUpdate: on("update:available"),
});
