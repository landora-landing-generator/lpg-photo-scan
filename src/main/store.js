"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, safeStorage } = require("electron");

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
 * Settings: the chosen provider and one key per provider, so switching back and
 * forth does not lose a pasted key. Keys are encrypted with the OS keychain when available.
 */
function loadSettings() {
  const s = readJson("settings.json", {});
  const keys = {};
  for (const [id, v] of Object.entries(s.keys ?? {})) keys[id] = unseal(v);
  return { provider: s.provider ?? "openrouter", keys };
}

function saveKey(provider, key) {
  const s = readJson("settings.json", {});
  s.provider = provider;
  s.keys ??= {};
  if (key) s.keys[provider] = seal(key);
  else delete s.keys[provider];
  writeJson("settings.json", s);
}

/** The provider and key the next scan will use. */
function activeCreds() {
  const { provider, keys } = loadSettings();
  return { provider, apiKey: keys[provider] ?? "" };
}

/** Saved results: { domainsText, results: { [host]: result } } — survives a closed app or a stopped scan. */
const loadState = () => readJson("results.json", { domainsText: "", results: {} });
const saveState = (state) => writeJson("results.json", state);

module.exports = { loadSettings, saveKey, activeCreds, loadState, saveState };
