"use strict";

const Anthropic = require("@anthropic-ai/sdk").default;

/**
 * Services a key can come from. The user may save a key for any of them and
 * pick separately which one looks at images and which one draws new ones.
 * Default models are the cheapest that do the job ("is there a person" needs
 * no big model); the user may name another model of the same service.
 * OpenRouter, polza.ai and OpenAI speak the OpenAI chat/completions dialect
 * for vision; Anthropic goes through its own SDK and cannot draw.
 */
const PROVIDERS = {
  openrouter: {
    label: "OpenRouter",
    base: "https://openrouter.ai/api/v1",
    visionModel: "google/gemini-2.5-flash-lite",
    drawModel: "google/gemini-3.1-flash-image",
    hint: "openrouter.ai → Keys, начинается с sk-or-",
    scanCost: "100 сайтов ≈ 0,3–1 $",
    drawCost: "≈ 0,07–0,10 $",
  },
  polza: {
    label: "polza.ai",
    base: "https://polza.ai/api/v1",
    visionModel: "google/gemini-2.5-flash-lite",
    drawModel: "google/gemini-3.1-flash-image",
    hint: "polza.ai → API Keys, оплата в рублях",
    scanCost: "100 сайтов ≈ 30–100 ₽",
    drawCost: "≈ 5–10 ₽",
  },
  openai: {
    label: "OpenAI",
    base: "https://api.openai.com/v1",
    visionModel: "gpt-4.1-nano",
    drawModel: "gpt-image-2",
    hint: "platform.openai.com → API keys, начинается с sk-",
    scanCost: "100 сайтов ≈ 0,3–1 $",
    drawCost: "≈ 0,05–0,10 $",
  },
  anthropic: {
    label: "Anthropic",
    visionModel: "claude-haiku-5-5",
    drawModel: null, // Claude does not generate images
    hint: "platform.claude.com → API Keys, начинается с sk-ant-",
    scanCost: "100 сайтов ≈ 0,5–1 $",
    drawCost: null,
  },
};

/** Error that must stop the whole job (bad key, no credit) — retrying other images is pointless. */
class FatalKeyError extends Error {}

function providerOf(id) {
  const p = PROVIDERS[id];
  if (!p) throw new FatalKeyError(`Неизвестный сервис ключа: ${id}`);
  return p;
}

/** HTTP status of an OpenAI-style service → an error the user can act on. */
function httpError(p, status, body) {
  if (status === 401 || status === 403) return new FatalKeyError(`Ключ ${p.label} не принят — проверьте его.`);
  if (status === 402) return new FatalKeyError(`На ключе ${p.label} закончились деньги — пополните баланс.`);
  if (status === 429 && /quota|insufficient|balance/i.test(body)) {
    return new FatalKeyError(`На ключе ${p.label} закончились деньги или лимит — проверьте кабинет.`);
  }
  let detail = body;
  try {
    detail = JSON.parse(body).error?.message ?? body;
  } catch {
    /* plain text */
  }
  return new Error(`${p.label} ответил ${status}: ${String(detail).slice(0, 200)}`);
}

const money = (n, unit) => `${Number(n).toFixed(2)} ${unit}`;

/** "Сохранить и проверить": ok + remaining credit where the service reports it. */
async function checkKey({ provider, apiKey }) {
  const p = PROVIDERS[provider];
  if (!p) return { ok: false, message: "Неизвестный сервис." };
  if (!apiKey) return { ok: false, message: "Ключ пустой." };
  try {
    if (provider === "anthropic") {
      await new Anthropic({ apiKey, maxRetries: 0 }).models.list({ limit: 1 });
      return { ok: true, message: "работает" };
    }
    const url = {
      openrouter: `${p.base}/key`,
      polza: "https://polza.ai/api/v2/balance",
      openai: `${p.base}/models`,
    }[provider];
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 401 || res.status === 403) return { ok: false, message: "не принят — скопируйте ключ из кабинета заново" };
    if (!res.ok) return { ok: false, message: `сервис ответил ${res.status}, попробуйте позже` };
    const data = await res.json();
    if (provider === "openrouter") {
      const d = data.data ?? {};
      const left = d.limit_remaining ?? (d.limit != null ? d.limit - (d.usage ?? 0) : null);
      if (left != null) return { ok: true, message: `работает, остаток ${money(left, "$")}` };
    }
    if (provider === "polza" && data.available != null) {
      return { ok: true, message: `работает, доступно ${money(data.available, "₽")}` };
    }
    return { ok: true, message: "работает" };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      return { ok: false, message: "не принят — скопируйте ключ из кабинета заново" };
    }
    return { ok: false, message: `нет связи: ${e.message}` };
  }
}

/** What the window needs to draw the key form. */
const providerList = () =>
  Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    hint: p.hint,
    scanCost: p.scanCost,
    drawCost: p.drawCost,
    visionModel: p.visionModel,
    drawModel: p.drawModel,
    canDraw: Boolean(p.drawModel),
  }));

module.exports = { PROVIDERS, FatalKeyError, providerOf, httpError, checkKey, providerList };
