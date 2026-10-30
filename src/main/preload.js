"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

const on = (channel) => (fn) => ipcRenderer.on(channel, (_e, payload) => fn(payload));

contextBridge.exposeInMainWorld("api", {
  getState: () => ipcRenderer.invoke("state:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  parseDomains: (text) => ipcRenderer.invoke("domains:parse", text),
  importDomains: () => ipcRenderer.invoke("domains:import", {}),
  // Dropped File objects carry no path in a sandboxed page; webUtils resolves it here.
  importDroppedFiles: (files) =>
    ipcRenderer.invoke("domains:import", { paths: [...files].map((f) => webUtils.getPathForFile(f)).filter(Boolean) }),
  startScan: (domainsText, again) => ipcRenderer.invoke("scan:start", { domainsText, again }),
  stopScan: () => ipcRenderer.invoke("scan:stop"),
  clearResults: () => ipcRenderer.invoke("results:clear"),
  saveExcel: () => ipcRenderer.invoke("excel:save"),
  openExternal: (url) => ipcRenderer.invoke("open:external", url),
  originalImage: (host, id) => ipcRenderer.invoke("image:original", { host, id }),
  redrawnImage: (host, id) => ipcRenderer.invoke("image:redrawn", { host, id }),
  redrawImage: (host, id, prompt) => ipcRenderer.invoke("image:redraw", { host, id, prompt }),
  saveImage: (host, id) => ipcRenderer.invoke("image:save", { host, id }),
  redrawSite: (host) => ipcRenderer.invoke("site:redraw", { host }),
  stopRedrawSite: () => ipcRenderer.invoke("site:redraw-stop"),
  saveSite: (host) => ipcRenderer.invoke("site:save", { host }),
  onBegin: on("scan:begin"),
  onProgress: on("scan:progress"),
  onSite: on("scan:site"),
  onEnd: on("scan:end"),
  onImageUpdated: on("image:updated"),
  onRedrawProgress: on("site:redraw-progress"),
  onUpdate: on("update:available"),
});
