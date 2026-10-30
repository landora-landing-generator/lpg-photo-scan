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
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file(name));
}

const canEncrypt = () => safeStorage.isEncryptionAvailable();
const seal = (key) => (canEncrypt() ? { enc: safeStorage.encryptString(key).toString("base64") } : { plain: key });
function unseal(v) {
  if (!v) return "";
  if (v.enc && canEncrypt()) {
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
 * key. Keys are encrypted with the OS keychain when it is available.
 */
function loadSettings() {
  const s = readJson("settings.json", {});
  const keys = {};
  for (const [id, v] of Object.entries(s.keys ?? {})) keys[id] = unseal(v);
  return {
    // "anthropic" was offered in 0.1.0 and dropped: it cannot draw.
    provider: ["openrouter", "polza", "openai"].includes(s.provider) ? s.provider : "openrouter",
    keys,
    models: { recognize: s.models?.recognize ?? "", draw: s.models?.draw ?? "" },
    redrawRules: s.redrawRules ?? "",
  };
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
  credsFor,
  redrawRules,
  loadState,
  saveState,
  findImage,
  updateImage,
  redrawDir,
};
