"use strict";

const Anthropic = require("@anthropic-ai/sdk").default;
const { FatalKeyError, providerOf, httpError } = require("./providers");

const CLASSIFY = [
  "You see one image taken from a commercial website.",
  "Classify it:",
  '- "people": a PHOTOGRAPH (or photorealistic image) in which a real person or a recognisable part of one',
  "  (face, figure, hands at work) is visible — even small, in the background, or inside a collage or screenshot;",
  '- "photo": any other photograph (equipment, interior, object, landscape) with no person in it;',
  '- "graphic": logo, icon, drawing, cartoon, illustration, map, diagram, pattern, banner made mostly of text;',
  '- "unsure": you cannot tell (too blurry, too dark, ambiguous).',
  'Answer with JSON only: {"kind": "people" | "photo" | "graphic" | "unsure"}.',
].join("\n");

// The scene of the old frame in words; the redraw rules (editable by the user)
// decide what the new frame must and must not be.
const describeInstruction = (rules) =>
  [
    "You see one photograph taken from a commercial website.",
    "Write an English prompt (40–90 words) for an image model that draws a replacement photograph.",
    `Follow these rules (written in Russian by the user): ${rules}`,
    "Describe the subject, setting, framing, camera angle and mood. Describe people generically.",
    'Answer with JSON only: {"prompt": string}.',
  ].join("\n");

const KINDS = new Set(["people", "photo", "graphic", "unsure"]);

const jsonOf = (text) => {
  const s = String(text);
  return JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1));
};

function parseKind(text) {
  try {
    const kind = jsonOf(text).kind;
    if (KINDS.has(kind)) return kind;
  } catch {
    /* fall through */
  }
  return "unsure";
}

async function askOpenAiCompatible(p, model, apiKey, jpeg, instruction, signal) {
  const res = await fetch(`${p.base}/chat/completions`, {
    method: "POST",
    signal,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "lpg-photo-scan" },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: instruction },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } },
          ],
        },
      ],
      response_format: { type: "json_object" },
    }),
  });
  const body = await res.text();
  if (!res.ok) throw httpError(p, res.status, body);
  return JSON.parse(body).choices?.[0]?.message?.content ?? "";
}

async function askAnthropic(p, model, apiKey, jpeg, instruction, signal) {
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  let response;
  try {
    response = await client.beta.messages.create(
      {
        model,
        max_tokens: 4000,
        output_config: { effort: "low" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } },
              { type: "text", text: instruction },
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
  if (response.stop_reason === "refusal") return "";
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** One vision question about a JPEG; transient failures are retried twice. */
async function askVision({ provider, apiKey, model }, jpeg, instruction, signal) {
  const p = providerOf(provider);
  const m = model || p.visionModel;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
    try {
      return provider === "anthropic"
        ? await askAnthropic(p, m, apiKey, jpeg, instruction, signal)
        : await askOpenAiCompatible(p, m, apiKey, jpeg, instruction, signal);
    } catch (e) {
      if (e instanceof FatalKeyError || signal?.aborted) throw e;
      lastError = e;
    }
  }
  throw lastError;
}

/** people / photo / graphic / unsure for one image. */
async function classify(creds, jpeg, { signal } = {}) {
  return parseKind(await askVision(creds, jpeg, CLASSIFY, signal));
}

/** An image-model prompt for a new photo that replaces this one. */
async function describeForRedraw(creds, jpeg, rules, { signal } = {}) {
  const text = await askVision(creds, jpeg, describeInstruction(rules), signal);
  let prompt = "";
  try {
    prompt = String(jsonOf(text).prompt ?? "").trim();
  } catch {
    prompt = "";
  }
  if (!prompt) throw new Error("нейросеть не смогла описать кадр — напишите описание сами");
  return prompt;
}

module.exports = { classify, describeForRedraw, parseKind };
