"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

const on = (channel) => (fn) => ipcRenderer.on(channel, (_e, payload) => fn(payload));

contextBridge.exposeInMainWorld("api", {
  getState: () => ipcRenderer.invoke("state:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  setDrawModel: (model) => ipcRenderer.invoke("settings:draw-model", model),
  addDrawModel: (provider, id) => ipcRenderer.invoke("draw-models:add", { provider, id }),
  removeDrawModel: (provider, id) => ipcRenderer.invoke("draw-models:remove", { provider, id }),
  resetDrawModels: (provider) => ipcRenderer.invoke("draw-models:reset", { provider }),
  displayUrls: (urls) => ipcRenderer.invoke("url:display", urls),
  parseDomains: (text) => ipcRenderer.invoke("domains:parse", text),
  importDomains: () => ipcRenderer.invoke("domains:import", {}),
  // Dropped File objects carry no path in a sandboxed page; webUtils resolves it here.
  importDroppedFiles: (files) =>
    ipcRenderer.invoke("domains:import", { paths: [...files].map((f) => webUtils.getPathForFile(f)).filter(Boolean) }),
  startScan: (domainsText, again) => ipcRenderer.invoke("scan:start", { domainsText, again }),
  scanHosts: (hosts) => ipcRenderer.invoke("scan:start", { hosts }),
  stopScan: () => ipcRenderer.invoke("scan:stop"),
  clearResults: () => ipcRenderer.invoke("results:clear"),
  saveExcel: () => ipcRenderer.invoke("excel:save"),
  openExternal: (url) => ipcRenderer.invoke("open:external", url),
  originalImage: (host, id) => ipcRenderer.invoke("image:original", { host, id }),
  redrawnImage: (host, id) => ipcRenderer.invoke("image:redrawn", { host, id }),
  redrawImage: (host, id, prompt) => ipcRenderer.invoke("image:redraw", { host, id, prompt }),
  cancelRedraw: () => ipcRenderer.invoke("image:redraw-cancel"),
  saveImage: (host, id) => ipcRenderer.invoke("image:save", { host, id }),
  redrawBatch: (items) => ipcRenderer.invoke("redraw:batch", { items }),
  stopRedraw: () => ipcRenderer.invoke("redraw:stop"),
  saveSites: (hosts) => ipcRenderer.invoke("sites:save", { hosts }),
  studioReference: () => ipcRenderer.invoke("studio:reference", {}),
  studioDroppedReference: (file) => ipcRenderer.invoke("studio:reference", { path: webUtils.getPathForFile(file) }),
  studioGenerate: (params) => ipcRenderer.invoke("studio:generate", params),
  studioCancel: () => ipcRenderer.invoke("studio:cancel"),
  studioSave: (file) => ipcRenderer.invoke("studio:save", { file }),
  onBegin: on("scan:begin"),
  onMore: on("scan:more"),
  onDrawModels: on("draw-models:changed"),
  onProgress: on("scan:progress"),
  onSite: on("scan:site"),
  onEnd: on("scan:end"),
  onImageUpdated: on("image:updated"),
  onImageStep: on("image:step"),
  onRedrawProgress: on("redraw:progress"),
  onUpdate: on("update:available"),
});
