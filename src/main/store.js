"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, safeStorage } = require("electron");
const { DEFAULT_REDRAW_RULES } = require("./prompts");

// Everything lives in the OS per-user app folder; nothing goes next to the app itself.
const file = (name) => path.join(app.getPath("userData"), name);

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(name, data) {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  const tmp = `${file(name)}.tmp`;
  // Only this user of the computer can read the folder's files: the API key is in settings.json.
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file(name));
}

// Windows encrypts silently (DPAPI). On a Mac the key would sit in the
// keychain, and an ad-hoc signed app changes its signature with every version:
// after each update macOS asks for the user's password. So on a Mac the key is
// kept in the user-only settings file instead.
const useOsEncryption = () => process.platform !== "darwin" && safeStorage.isEncryptionAvailable();
const seal = (key) => (useOsEncryption() ? { enc: safeStorage.encryptString(key).toString("base64") } : { plain: key });
function unseal(v) {
  if (!v) return "";
  // A Mac key sealed by 0.1.x–0.2.0 is read once more from the keychain, then moved to the file.
  if (v.enc && (process.platform === "darwin" || useOsEncryption())) {
    try {
      return safeStorage.decryptString(Buffer.from(v.enc, "base64"));
    } catch {
      return "";
    }
  }
  return v.plain ?? "";
}

/**
 * Settings: the one service the user works with, its key, and optional model
 * names for the two jobs (empty = the service's cheapest default). Keys of
 * other services stay remembered, so switching back does not lose a pasted
 * key. On Windows keys are encrypted by the OS; on a Mac see useOsEncryption.
 */
function loadSettings() {
  const s = readJson("settings.json", {});
  const keys = {};
  let moved = false;
  for (const [id, v] of Object.entries(s.keys ?? {})) {
    keys[id] = unseal(v);
    if (v?.enc && process.platform === "darwin") {
      if (keys[id]) s.keys[id] = { plain: keys[id] };
      else delete s.keys[id];
      moved = true;
    }
  }
  if (moved) writeJson("settings.json", s);
  return {
    // "anthropic" was offered in 0.1.0 and dropped: it cannot draw.
    provider: ["openrouter", "polza", "openai"].includes(s.provider) ? s.provider : "openrouter",
    keys,
    models: { recognize: s.models?.recognize ?? "", draw: s.models?.draw ?? "" },
    redrawRules: s.redrawRules ?? "",
    // Per service: { added: [{ id, label }], removed: [id] } over the built-in drawing models.
    drawLists: s.drawLists ?? {},
  };
}

/** Changes the user's drawing-model list of one service; null resets it to the built-in one. */
function updateDrawList(provider, fn) {
  const s = readJson("settings.json", {});
  s.drawLists ??= {};
  const next = fn ? fn({ added: [], removed: [], ...s.drawLists[provider] }) : null;
  if (next) s.drawLists[provider] = next;
  else delete s.drawLists[provider];
  writeJson("settings.json", s);
}

/** Last downloaded drawing-model catalog per service: { [provider]: { at, models } }. */
const loadCatalogs = () => readJson("draw-catalog.json", {});
function saveCatalog(provider, models) {
  writeJson("draw-catalog.json", { ...loadCatalogs(), [provider]: { at: new Date().toISOString(), models } });
}

/** The drawing model of the saved service; written as is (empty = the service default). */
function setDrawModel(model) {
  const s = readJson("settings.json", {});
  s.models = { recognize: s.models?.recognize ?? "", draw: String(model ?? "").trim() };
  writeJson("settings.json", s);
}

function saveSettings({ provider, key, models, redrawRules }) {
  const s = readJson("settings.json", {});
  s.provider = provider;
  s.keys ??= {};
  if (key) s.keys[provider] = seal(key);
  else delete s.keys[provider];
  s.models = { recognize: String(models?.recognize ?? "").trim(), draw: String(models?.draw ?? "").trim() };
  s.redrawRules = String(redrawRules ?? "").trim();
  writeJson("settings.json", s);
}

/** Redraw rules in force: the user's text, or the built-in default. */
const redrawRules = () => loadSettings().redrawRules || DEFAULT_REDRAW_RULES;

/** Credentials for one job: "recognize" or "draw" — same service, maybe another model. */
function credsFor(role) {
  const s = loadSettings();
  return { provider: s.provider, apiKey: s.keys[s.provider] ?? "", model: s.models[role] };
}

/** Saved results: { domainsText, results: { [host]: result } } — survives a closed app or a stopped scan. */
const loadState = () => readJson("results.json", { domainsText: "", results: {} });
const saveState = (state) => writeJson("results.json", state);

/** Finds an image of a site's result (people or unsure list) by id. */
function findImage(state, host, id) {
  const r = state.results[host];
  return r ? [...r.people, ...r.unsure].find((img) => img.id === id) ?? null : null;
}

/** Read-modify-write of one image entry; returns the updated entry. */
function updateImage(host, id, patch) {
  const state = loadState();
  const img = findImage(state, host, id);
  if (!img) return null;
  Object.assign(img, patch);
  saveState(state);
  return img;
}

/** Folder with drawn frames of one site. */
const redrawDir = (host) => path.join(app.getPath("userData"), "redraws", host);

module.exports = {
  loadSettings,
  saveSettings,
  updateDrawList,
  loadCatalogs,
  saveCatalog,
  setDrawModel,
  credsFor,
  redrawRules,
  loadState,
  saveState,
  findImage,
  updateImage,
  redrawDir,
};
