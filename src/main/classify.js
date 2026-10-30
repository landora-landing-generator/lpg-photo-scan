"use strict";

const Anthropic = require("@anthropic-ai/sdk").default;

const INSTRUCTION = [
  "You see one image taken from a commercial website.",
  "Classify it:",
  '- "people": a PHOTOGRAPH (or photorealistic image) in which a real person or a recognisable part of one',
  "  (face, figure, hands at work) is visible — even small, in the background, or inside a collage or screenshot;",
  '- "photo": any other photograph (equipment, interior, object, landscape) with no person in it;',
  '- "graphic": logo, icon, drawing, cartoon, illustration, map, diagram, pattern, banner made mostly of text;',
  '- "unsure": you cannot tell (too blurry, too dark, ambiguous).',
  'Answer with JSON only: {"kind": "people" | "photo" | "graphic" | "unsure"}.',
].join("\n");

const KINDS = new Set(["people", "photo", "graphic", "unsure"]);

/**
 * Key providers the user can pick. OpenRouter, polza.ai and OpenAI speak the
 * OpenAI chat/completions dialect; Anthropic goes through its own SDK.
 */
const PROVIDERS = {
  openrouter: {
    label: "OpenRouter",
    base: "https://openrouter.ai/api/v1",
    model: "google/gemini-2.5-flash",
    hint: "Ключ — на сайте openrouter.ai → Keys. Начинается с sk-or-.",
    cost: "100 сайтов ≈ 1–3 $",
  },
  polza: {
    label: "polza.ai",
    base: "https://polza.ai/api/v1",
    model: "google/gemini-2.5-flash",
    hint: "Ключ — в кабинете polza.ai → API Keys. Оплата в рублях.",
    cost: "100 сайтов ≈ 100–300 ₽",
  },
  openai: {
    label: "OpenAI",
    base: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    hint: "Ключ — на platform.openai.com → API keys. Начинается с sk-.",
    cost: "100 сайтов ≈ 1–3 $",
  },
  anthropic: {
    label: "Anthropic",
    model: "claude-opus-5-5",
    hint: "Ключ — на platform.claude.com → API Keys. Начинается с sk-ant-.",
    cost: "100 сайтов ≈ 15–30 $",
  },
};

/** Error that must stop the whole scan (bad key, no credit) — retrying other images is pointless. */
class FatalKeyError extends Error {}

function parseKind(text) {
  const s = String(text);
  const json = s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1);
  try {
    const kind = JSON.parse(json).kind;
    if (KINDS.has(kind)) return kind;
  } catch {
    /* fall through */
  }
  return "unsure";
}

const providerOf = (id) => {
  const p = PROVIDERS[id];
  if (!p) throw new FatalKeyError(`Неизвестный поставщик ключа: ${id}`);
  return p;
};

/** One chat/completions call; returns the reply text or throws (FatalKeyError on key/billing). */
async function askOpenAiCompatible(p, apiKey, jpeg, signal) {
  const res = await fetch(`${p.base}/chat/completions`, {
    method: "POST",
    signal,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "lpg-photo-scan" },
    body: JSON.stringify({
      model: p.model,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: INSTRUCTION },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } },
          ],
        },
      ],
      response_format: { type: "json_object" },
    }),
  });
  const body = await res.text();
  if (res.status === 401 || res.status === 403) throw new FatalKeyError(`Ключ ${p.label} не принят — проверьте его.`);
  if (res.status === 402) throw new FatalKeyError(`На ключе ${p.label} закончились деньги — пополните баланс.`);
  if (res.status === 429 && /quota|insufficient/i.test(body)) {
    throw new FatalKeyError(`На ключе ${p.label} закончились деньги или лимит — проверьте кабинет.`);
  }
  if (!res.ok) throw new Error(`${p.label} ответил ${res.status}: ${body.slice(0, 160)}`);
  return JSON.parse(body).choices?.[0]?.message?.content ?? "";
}

async function askAnthropic(p, apiKey, jpeg, signal) {
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  let response;
  try {
    response = await client.beta.messages.create(
      {
        model: p.model,
        max_tokens: 4000,
        output_config: { effort: "low" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } },
              { type: "text", text: INSTRUCTION },
            ],
          },
        ],
      },
      { signal },
    );
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      throw new FatalKeyError("Ключ Anthropic не принят — проверьте его.");
    }
    // Anthropic reports an empty balance as a 400 with no dedicated error type.
    if (e instanceof Anthropic.BadRequestError && /credit balance/i.test(e.message)) {
      throw new FatalKeyError("На ключе Anthropic закончились деньги — пополните баланс.");
    }
    throw e;
  }
  if (response.stop_reason === "refusal") return '{"kind":"unsure"}';
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Classifies one JPEG buffer; transient failures are retried twice. */
async function classify({ provider, apiKey }, jpeg, { signal } = {}) {
  const p = providerOf(provider);
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
    try {
      const text =
        provider === "anthropic"
          ? await askAnthropic(p, apiKey, jpeg, signal)
          : await askOpenAiCompatible(p, apiKey, jpeg, signal);
      return parseKind(text);
    } catch (e) {
      if (e instanceof FatalKeyError || signal?.aborted) throw e;
      lastError = e;
    }
  }
  throw lastError;
}

const money = (n, unit) => `${Number(n).toFixed(2)} ${unit}`;

/** "Проверить ключ": ok + remaining credit where the provider reports it. */
async function checkKey({ provider, apiKey }) {
  const p = PROVIDERS[provider];
  if (!p) return { ok: false, message: "Выберите, чей это ключ." };
  if (!apiKey) return { ok: false, message: "Вставьте ключ." };
  try {
    if (provider === "anthropic") {
      await new Anthropic({ apiKey, maxRetries: 0 }).models.list({ limit: 1 });
      return { ok: true, message: "Ключ работает." };
    }
    const url = {
      openrouter: `${p.base}/key`,
      polza: "https://polza.ai/api/v2/balance",
      openai: `${p.base}/models`,
    }[provider];
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: `Ключ не принят. Скопируйте его из кабинета ${p.label} заново.` };
    }
    if (!res.ok) return { ok: false, message: `${p.label} ответил ${res.status}. Попробуйте позже.` };
    const data = await res.json();
    if (provider === "openrouter") {
      const d = data.data ?? {};
      const left = d.limit_remaining ?? (d.limit != null ? d.limit - (d.usage ?? 0) : null);
      if (left != null) return { ok: true, message: `Ключ работает. Остаток: ${money(left, "$")}.` };
    }
    if (provider === "polza" && data.available != null) {
      return { ok: true, message: `Ключ работает. Доступно: ${money(data.available, "₽")}.` };
    }
    return { ok: true, message: "Ключ работает." };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      return { ok: false, message: "Ключ не принят. Скопируйте его из кабинета Anthropic заново." };
    }
    return { ok: false, message: `Нет связи с ${p.label}: ${e.message}` };
  }
}

/** What the window needs to draw the provider picker. */
const providerList = () =>
  Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, hint: p.hint, cost: p.cost }));

module.exports = { classify, checkKey, parseKind, providerList, FatalKeyError, PROVIDERS };
