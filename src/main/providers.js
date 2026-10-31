"use strict";

/**
 * Services a key can come from. The user may save a key for any of them and
 * pick separately which one looks at images and which one draws new ones.
 * Default models are the cheapest that do the job ("is there a person" needs
 * no big model); the user may name another model of the same service.
 * All three speak the OpenAI chat/completions dialect for vision and can draw.
 * `drawModels` is the fallback until the service's live catalog is downloaded
 * (catalogDrawModels) — the same filter, taken from the catalogs 2026-10-31.
 */
const PROVIDERS = {
  openrouter: {
    label: "OpenRouter",
    base: "https://openrouter.ai/api/v1",
    visionModel: "google/gemini-2.5-flash-lite",
    drawModel: "google/gemini-3.1-flash-image",
    drawModels: [
      { id: "google/gemini-3.1-flash-image", label: "Nano Banana 2 · ≈ 0,10 $" },
      { id: "google/gemini-nano-banana-2.1", label: "Nano Banana 2.1 · ≈ 0,05 $" },
      { id: "google/gemini-3.1-flash-lite-image", label: "Nano Banana 2 Lite · ≈ 0,03 $" },
      { id: "google/gemini-3-pro-image", label: "Nano Banana Pro · ≈ 0,14 $" },
      { id: "google/gemini-3.1-flash-image-preview", label: "Nano Banana 2 Preview" },
      { id: "google/gemini-3-pro-image-preview", label: "Nano Banana Pro Preview" },
      { id: "google/gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image" },
      { id: "bytedance-seed/seedream-5-0-lite", label: "Seedream 5.0 Lite · ≈ 0,04 $" },
      { id: "bytedance-seed/seedream-5-0-flash", label: "Seedream 5.0 Flash" },
      { id: "bytedance-seed/seedream-5-0-pro", label: "Seedream 5.0 Pro" },
      { id: "bytedance-seed/seedream-4.5", label: "Seedream 4.5" },
      { id: "qwen/qwen-image-3", label: "Qwen Image 3" },
      { id: "qwen/qwen-image-3-pro", label: "Qwen Image 3 Pro" },
      { id: "qwen/qwen-image-2.1-turbo", label: "Qwen Image 2.1 Turbo" },
      { id: "qwen/qwen-image-2.1-pro", label: "Qwen Image 2.1 Pro" },
      { id: "tencent/hy-image-v3.5-preview", label: "Hunyuan Image 3.5 Preview" },
      { id: "x-ai/grok-imagine-image-2.0", label: "Grok Imagine Image 2.0" },
      { id: "x-ai/grok-imagine-image-quality", label: "Grok Imagine Image Quality" },
      { id: "black-forest-labs/flux-3-image", label: "FLUX 3 Image" },
      { id: "black-forest-labs/flux-3-image-klein", label: "FLUX 3 Image Klein" },
      { id: "black-forest-labs/flux.2-pro", label: "FLUX.2 Pro" },
      { id: "black-forest-labs/flux.2-max", label: "FLUX.2 Max" },
      { id: "black-forest-labs/flux.2-flex", label: "FLUX.2 Flex" },
      { id: "black-forest-labs/flux.2-klein-4b", label: "FLUX.2 Klein 4B" },
      { id: "openai/gpt-image-2", label: "GPT Image 2" },
      { id: "openai/gpt-image-1", label: "GPT Image 1" },
      { id: "openai/gpt-image-1-mini", label: "GPT Image 1 Mini" },
      { id: "openai/gpt-image-2.5-flare", label: "GPT Image 2.5 Flare" },
      { id: "openai/gpt-image-2.5-sunburst", label: "GPT Image 2.5 Sunburst" },
      { id: "openai/gpt-5.4-image-2", label: "GPT-5.4 Image 2" },
      { id: "openai/gpt-5-image", label: "GPT-5 Image" },
      { id: "openai/gpt-5-image-mini", label: "GPT-5 Image Mini" },
      { id: "microsoft/mai-image-2.6", label: "MAI-Image 2.6" },
      { id: "microsoft/mai-image-2.6-flash", label: "MAI-Image 2.6 Flash" },
      { id: "microsoft/mai-image-2.5", label: "MAI-Image 2.5" },
      { id: "microsoft/mai-image-2.5-pro", label: "MAI-Image 2.5 Pro" },
      { id: "meta/muse-image", label: "Meta Muse Image" },
      { id: "krea/krea-2-large", label: "Krea 2 Large" },
      { id: "krea/krea-2-medium", label: "Krea 2 Medium" },
      { id: "krea/krea-2-medium-turbo", label: "Krea 2 Medium Turbo" },
      { id: "recraft/recraft-v4.1", label: "Recraft V4.1" },
      { id: "recraft/recraft-v4.1-pro", label: "Recraft V4.1 Pro" },
      { id: "recraft/recraft-v4.1-flash", label: "Recraft V4.1 Flash" },
      { id: "recraft/recraft-v4", label: "Recraft V4" },
      { id: "recraft/recraft-v4-pro", label: "Recraft V4 Pro" },
      { id: "recraft/recraft-v3", label: "Recraft V3" },
      { id: "sourceful/riverflow-v2.6-pro", label: "Riverflow V2.6 Pro" },
      { id: "sourceful/riverflow-v2.5-pro", label: "Riverflow V2.5 Pro" },
      { id: "sourceful/riverflow-v2.5-fast", label: "Riverflow V2.5 Fast" },
    ],
    hint: "openrouter.ai → Keys, начинается с sk-or-",
    scanCost: "100 сайтов ≈ 0,3–1 $",
    drawCost: "≈ 0,07–0,10 $",
  },
  polza: {
    label: "polza.ai",
    base: "https://polza.ai/api/v1",
    visionModel: "google/gemini-2.5-flash-lite",
    drawModel: "google/gemini-3.1-flash-image",
    drawModels: [
      { id: "google/gemini-3.1-flash-image", label: "Nano Banana 2" },
      { id: "google/gemini-3.1-flash-lite-image", label: "Nano Banana 2 Lite · от 2,9 ₽" },
      { id: "google/gemini-nano-banana-2.1", label: "Nano Banana 2.1 · от 6,75 ₽" },
      { id: "google/gemini-3.1-flash-image-preview", label: "Nano Banana 2 Preview · от 4,8 ₽" },
      { id: "google/gemini-3-pro-image-preview", label: "Nano Banana Pro · от 13,5 ₽" },
      { id: "google/gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image · 2,9 ₽" },
      { id: "tongyi-mai/z-image", label: "Z-Image · 1,4 ₽" },
      { id: "x-ai/grok-imagine-image", label: "Grok Image · 2,5 ₽" },
      { id: "grok-imagine-image-2-0/text-to-image", label: "Grok Image 2.0 · 3 ₽" },
      { id: "yandex/yandex-art", label: "YandexArt · от 2,9 ₽" },
      { id: "bytedance/seedream-4", label: "Seedream 4.0 · 3 ₽" },
      { id: "bytedance/seedream-4.5", label: "Seedream 4.5 · 5 ₽" },
      { id: "bytedance/seedream-5-lite", label: "Seedream 5.0 Lite · 4 ₽" },
      { id: "seedream/5-pro-text-to-image", label: "Seedream 5.0 Pro · от 5 ₽" },
      { id: "qwen/image", label: "Qwen Image · от 3 ₽" },
      { id: "qwen/image-2", label: "Qwen Image 2 · 4 ₽" },
      { id: "qwen/image-2.1", label: "Qwen Image 2.1 · от 6 ₽" },
      { id: "black-forest-labs/flux.2-pro", label: "FLUX.2 Pro · от 5 ₽" },
      { id: "black-forest-labs/flux.2-flex", label: "FLUX.2 Flex · от 14 ₽" },
      { id: "openai/gpt-image-1.5", label: "GPT Image 1.5 · от 3 ₽" },
      { id: "openai/gpt-5-image-mini", label: "GPT-5 Image Mini" },
      { id: "openai/gpt-5-image", label: "GPT-5 Image · 4,5 ₽" },
      { id: "openai/gpt-5.4-image-2", label: "GPT-5.4 Image 2 · от 4 ₽" },
      { id: "openai/gpt-image-2.5-flare", label: "GPT Image 2.5 Flare · от 11 ₽" },
      { id: "openai/gpt-image-2.5-sunburst", label: "GPT Image 2.5 Sunburst · от 11 ₽" },
    ],
    hint: "polza.ai → API Keys, оплата в рублях",
    scanCost: "100 сайтов ≈ 30–100 ₽",
    drawCost: "≈ 5–10 ₽",
  },
  openai: {
    label: "OpenAI",
    base: "https://api.openai.com/v1",
    visionModel: "gpt-4.1-nano",
    drawModel: "gpt-image-2",
    drawModels: [
      { id: "gpt-image-2", label: "GPT Image 2 · ≈ 0,06 $" },
      { id: "gpt-image-1.5", label: "GPT Image 1.5" },
      { id: "gpt-image-1", label: "GPT Image 1" },
      { id: "gpt-image-1-mini", label: "GPT Image 1 Mini · дешевле" },
    ],
    hint: "platform.openai.com → API keys, начинается с sk-",
    scanCost: "100 сайтов ≈ 0,3–1 $",
    drawCost: "≈ 0,05–0,10 $",
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
    return { ok: false, message: `нет связи: ${e.message}` };
  }
}

/**
 * Does a catalog entry draw pictures? Text models, upscalers (need a picture
 * in), vector and edit-only models, style presets and auto-routers are out.
 */
function catalogDraws(provider, m) {
  const id = String(m?.id ?? "");
  if (provider === "openai") return /^(?:gpt-image|chatgpt-image)/.test(id);
  if (/upscale|vector|-edit$|styles|^openrouter\//i.test(id)) return false;
  if (provider === "polza") return m.type === "image";
  return (m.architecture?.output_modalities ?? []).includes("image");
}

/** "Google: Nano Banana 2 (Gemini 3.1 Flash Image)" → "Nano Banana 2". */
const shortName = (name, id) => String(name || id).replace(/^[\w .-]+: /, "").replace(/ \(.*\)$/, "");

/** polza prices its models in roubles: the base tier, "от" when bigger frames cost more. */
function polzaPrice(m) {
  const pr = m.top_provider?.pricing ?? m.pricing ?? {};
  const fmt = (n) => String(Number(n)).replace(".", ",");
  if (pr.per_request) return ` · ${fmt(pr.per_request)} ₽`;
  if (pr.tiers?.[0]?.cost_rub) return ` · ${pr.tiers.length > 1 ? "от " : ""}${fmt(pr.tiers[0].cost_rub)} ₽`;
  return "";
}

/** The service's model catalog, as raw entries. Throws an error the user can read. */
async function fetchCatalog({ provider, apiKey }) {
  const p = providerOf(provider);
  const url = provider === "openrouter" ? `${p.base}/models?output_modalities=image,text` : `${p.base}/models`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw httpError(p, res.status, await res.text());
    const data = await res.json();
    return data.data ?? data;
  } catch (e) {
    throw new Error(`Не удалось открыть каталог ${p.label}: ${e.message}`);
  }
}

/** Every drawing model the service offers now: { id, label }, the default first. */
async function catalogDrawModels(creds) {
  const p = providerOf(creds.provider);
  const known = new Map(p.drawModels.map((m) => [m.id, m.label]));
  const list = (await fetchCatalog(creds))
    .filter((m) => catalogDraws(creds.provider, m))
    .map((m) => ({
      id: m.id,
      label: creds.provider === "polza" ? shortName(m.name, m.id) + polzaPrice(m) : (known.get(m.id) ?? shortName(m.name, m.id)),
    }))
    .sort((a, b) => (a.id === p.drawModel ? -1 : b.id === p.drawModel ? 1 : a.label.localeCompare(b.label)));
  if (!list.length) throw new Error(`Каталог ${p.label} не вернул ни одной рисующей модели`);
  return list;
}

/**
 * The user's drawing models of a service: the live catalog (or, before the
 * first download, the built-in list) minus removed ones, plus models the user
 * added by hand — those too disappear once the catalog no longer has them.
 */
function drawModelsFor(provider, custom = {}, catalog = null) {
  const p = PROVIDERS[provider];
  if (!p) return [];
  const base = catalog?.length ? catalog : p.drawModels;
  const removed = new Set(custom.removed ?? []);
  const list = base.filter((m) => !removed.has(m.id));
  for (const m of custom.added ?? []) if (!list.some((x) => x.id === m.id)) list.push(m);
  return list;
}

/**
 * A model the user types in joins the list only when the service's own catalog
 * lists it at all and says it outputs pictures. Returns { id, label }.
 */
async function findDrawModel(creds, rawId) {
  const p = providerOf(creds.provider);
  const id = String(rawId ?? "").trim();
  if (!id) throw new Error("Впишите название модели.");
  const m = (await fetchCatalog(creds)).find((x) => x.id === id);
  if (!m) throw new Error(`У ${p.label} нет модели ${id} — проверьте название в каталоге сервиса.`);
  const draws =
    creds.provider === "polza"
      ? m.type === "image"
      : creds.provider === "openai"
        ? catalogDraws("openai", m)
        : (m.architecture?.output_modalities ?? []).includes("image");
  if (!draws) throw new Error(`Модель ${id} не рисует картинки — для перерисовки она не подойдёт.`);
  return { id, label: shortName(m.name, id) };
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
    drawModels: p.drawModels,
  }));

module.exports = { PROVIDERS, FatalKeyError, providerOf, httpError, checkKey, providerList, drawModelsFor, findDrawModel, catalogDrawModels };
