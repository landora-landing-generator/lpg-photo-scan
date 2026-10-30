"use strict";

const { FatalKeyError, providerOf, httpError } = require("./providers");

// Plain-text answers with a hard length cap. JSON mode without a cap made
// gemini-2.5-flash-lite ramble until its output limit — minutes of silence.

const CLASSIFY = [
  "You see one image taken from a commercial website. Classify it with ONE word:",
  "people — a PHOTOGRAPH (or photorealistic image) where a real person or a recognisable part of one",
  "(face, figure, hands at work) is visible, even small, in the background, or inside a collage or screenshot;",
  "photo — any other photograph (equipment, interior, object, landscape) with no person in it;",
  "graphic — logo, icon, drawing, cartoon, illustration, map, diagram, pattern, banner made mostly of text;",
  "unsure — you cannot tell.",
  "Answer with the one word only.",
].join("\n");

// The scene of the old frame in words; the redraw rules (editable by the user)
// decide what the new frame must and must not be.
const describeInstruction = (rules) =>
  [
    "You see one photograph taken from a commercial website.",
    "Write an English prompt of 40–90 words for an image model that draws a replacement photograph.",
    `Follow these rules (written in Russian by the user): ${rules}`,
    "Describe the subject, setting, framing, camera angle and mood. Describe people generically.",
    "Answer with the prompt text only — no quotes, no headings, no explanations.",
  ].join("\n");

const KINDS = ["people", "photo", "graphic", "unsure"];

/** First known word in the answer wins; anything else is "unsure". */
function parseKind(text) {
  const words = String(text).toLowerCase().match(/[a-z]+/g) ?? [];
  return words.find((w) => KINDS.includes(w)) ?? "unsure";
}

/** A described prompt, cleaned of quotes or a "Prompt:" label some models add. */
function cleanPrompt(text) {
  return String(text)
    .trim()
    .replace(/^```[a-z]*\s*|\s*```$/g, "")
    .replace(/^(?:prompt|промпт)\s*:\s*/i, "")
    .replace(/^["«“]+|["»”]+$/g, "")
    .trim();
}

const REQUEST_TIMEOUT = 60_000;

async function askOpenAiCompatible(p, model, apiKey, jpeg, instruction, maxTokens, signal) {
  const res = await fetch(`${p.base}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT), ...(signal ? [signal] : [])]),
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "lpg-photo-scan" },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: instruction },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } },
          ],
        },
      ],
    }),
  });
  const body = await res.text();
  if (!res.ok) throw httpError(p, res.status, body);
  return JSON.parse(body).choices?.[0]?.message?.content ?? "";
}

/** One vision question about a JPEG; transient failures are retried twice. */
async function askVision({ provider, apiKey, model }, jpeg, instruction, maxTokens, signal) {
  const p = providerOf(provider);
  const m = model || p.visionModel;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
    try {
      return await askOpenAiCompatible(p, m, apiKey, jpeg, instruction, maxTokens, signal);
    } catch (e) {
      if (e instanceof FatalKeyError || signal?.aborted) throw e;
      if (e.name === "TimeoutError") throw new Error(`${p.label} не ответил за минуту`);
      lastError = e;
    }
  }
  throw lastError;
}

/** people / photo / graphic / unsure for one image. */
async function classify(creds, jpeg, { signal } = {}) {
  return parseKind(await askVision(creds, jpeg, CLASSIFY, 16, signal));
}

/** An image-model prompt for a new photo that replaces this one. */
async function describeForRedraw(creds, jpeg, rules, { signal } = {}) {
  const prompt = cleanPrompt(await askVision(creds, jpeg, describeInstruction(rules), 400, signal));
  if (prompt.length < 20) throw new Error("нейросеть не смогла описать кадр — напишите описание сами");
  return prompt;
}

module.exports = { classify, describeForRedraw, parseKind, cleanPrompt };
