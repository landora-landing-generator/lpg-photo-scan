"use strict";

const { providerOf, httpError } = require("./providers");

const RATIOS = [
  ["1:1", 1],
  ["4:3", 4 / 3],
  ["3:4", 3 / 4],
  ["3:2", 3 / 2],
  ["2:3", 2 / 3],
  ["16:9", 16 / 9],
  ["9:16", 9 / 16],
];

/** Nearest ratio the image models accept; the exact pixels are cut afterwards. */
function aspectRatioFor(width, height) {
  const target = width / height;
  return RATIOS.reduce((best, r) => (Math.abs(r[1] - target) < Math.abs(best[1] - target) ? r : best))[0];
}

/** Gemini tiers: 1K is ~1024 on the long side; bigger originals ask for 2K. Other models take no tier. */
const tierFor = (model, width, height) =>
  /gemini|nano-banana/.test(model) ? (Math.max(width, height) > 1100 ? "2K" : "1K") : undefined;

/**
 * gpt-image-2 takes any WIDTHxHEIGHT on a 16px grid between 1:3 and 3:1. The
 * original's size, rounded up and kept within 512–2560 × 512–1440, so sharp
 * only crops afterwards.
 */
function openAiSize(width, height) {
  const up = (n) => Math.ceil(n / 16) * 16;
  let w = Math.max(512, up(width));
  let h = Math.max(512, up(height));
  const shrink = Math.min(1, 2560 / w, 1440 / h);
  w = up(w * shrink);
  h = up(h * shrink);
  return `${w}x${h}`;
}

async function fetchBytes(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`не скачался готовый кадр (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** OpenRouter: /images (image models have no chat endpoint). */
const dataUrl = (jpeg) => `data:image/jpeg;base64,${jpeg.toString("base64")}`;

async function drawOpenRouter(p, model, apiKey, prompt, size, signal, reference) {
  const res = await fetch(`${p.base}/images`, {
    method: "POST",
    signal,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      aspect_ratio: aspectRatioFor(size.width, size.height),
      resolution: tierFor(model, size.width, size.height),
      ...(reference ? { input_references: [{ type: "image_url", image_url: { url: dataUrl(reference) } }] } : {}),
    }),
  });
  const body = await res.text();
  if (!res.ok) throw httpError(p, res.status, body);
  const b64 = JSON.parse(body).data?.find((d) => typeof d.b64_json === "string")?.b64_json;
  if (!b64) throw new Error("OpenRouter не прислал картинку");
  return Buffer.from(b64, "base64");
}

/** OpenAI: Images API (edits with a reference), base64 answer. */
async function drawOpenAi(p, model, apiKey, prompt, size, signal, reference) {
  let res;
  if (reference) {
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", prompt);
    form.append("size", openAiSize(size.width, size.height));
    form.append("quality", "medium");
    form.append("image[]", new Blob([reference], { type: "image/jpeg" }), "reference.jpg");
    res = await fetch(`${p.base}/images/edits`, {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } else {
    res = await fetch(`${p.base}/images/generations`, {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, n: 1, size: openAiSize(size.width, size.height), quality: "medium" }),
    });
  }
  const body = await res.text();
  if (!res.ok) throw httpError(p, res.status, body);
  const b64 = JSON.parse(body).data?.find((d) => typeof d.b64_json === "string")?.b64_json;
  if (!b64) throw new Error("OpenAI не прислал картинку");
  return Buffer.from(b64, "base64");
}

/** polza.ai: Media API is asynchronous — create, then poll until completed. */
async function drawPolza(p, model, apiKey, prompt, size, signal, reference) {
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  const res = await fetch(`${p.base}/media`, {
    method: "POST",
    signal,
    headers,
    body: JSON.stringify({
      model,
      input: {
        prompt,
        aspect_ratio: aspectRatioFor(size.width, size.height),
        image_resolution: tierFor(model, size.width, size.height),
        output_format: "jpeg",
        ...(reference ? { images: [{ type: "base64", data: dataUrl(reference) }] } : {}),
      },
    }),
  });
  let body = await res.text();
  if (!res.ok) throw httpError(p, res.status, body);
  let job = JSON.parse(body);
  const started = Date.now();
  while (job.status !== "completed") {
    if (job.status === "failed" || job.status === "cancelled") {
      const why = job.error?.message ?? job.error ?? "без объяснения";
      throw new Error(`polza.ai не нарисовал кадр: ${typeof why === "string" ? why : JSON.stringify(why)}`);
    }
    if (Date.now() - started > 300_000) throw new Error("polza.ai рисует дольше 5 минут — попробуйте позже");
    await new Promise((r) => setTimeout(r, 3000));
    signal?.throwIfAborted();
    const poll = await fetch(`${p.base}/media/${encodeURIComponent(job.id)}`, { headers, signal });
    body = await poll.text();
    if (!poll.ok) throw httpError(p, poll.status, body);
    job = JSON.parse(body);
  }
  const data = Array.isArray(job.data) ? job.data[0] : job.data;
  if (data?.url) return fetchBytes(data.url, signal);
  if (data?.b64_json) return Buffer.from(data.b64_json, "base64");
  throw new Error("polza.ai не прислал картинку");
}

/**
 * Draws a frame for `prompt` sized for `size` pixels. With `reference` (a JPEG)
 * the model works from that picture instead of from words alone.
 */
async function drawImage({ provider, apiKey, model }, prompt, size, { signal, reference } = {}) {
  const p = providerOf(provider);
  const m = model || p.drawModel;
  if (provider === "openrouter") return drawOpenRouter(p, m, apiKey, prompt, size, signal, reference);
  if (provider === "openai") return drawOpenAi(p, m, apiKey, prompt, size, signal, reference);
  return drawPolza(p, m, apiKey, prompt, size, signal, reference);
}

module.exports = { drawImage, aspectRatioFor, openAiSize };
