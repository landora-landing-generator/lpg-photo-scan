"use strict";

// Child process that runs the background-removal model. It lives apart from
// the app on purpose: onnxruntime aborts while a process exits (its thread
// pool outlives the runtime's static objects) — in the app itself that would
// be a "quit unexpectedly" report on every close. The parent kills this
// process with SIGKILL, so its exit path never runs. It also keeps the 1–2 GB
// the model takes out of the app and gives them back after idle.
//
// Protocol (advanced serialization): { id, model, input: Float32Array, size }
// → { id, logits: Float32Array } | { id, error }.

let session = null;

async function load(model) {
  if (session) return session;
  const ort = require("onnxruntime-node");
  // No CPU memory arena: its big aligned blocks crash Electron's allocator.
  session = await ort.InferenceSession.create(model, {
    graphOptimizationLevel: "all",
    enableCpuMemArena: false,
    enableMemPattern: false,
  });
  return session;
}

process.on("message", async ({ id, model, input, size }) => {
  try {
    const ort = require("onnxruntime-node");
    const s = await load(model);
    const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, size, size]) });
    const logits = Float32Array.from(out[s.outputNames[s.outputNames.length - 1]].data);
    process.send({ id, logits });
  } catch (e) {
    process.send({ id, error: e.message || String(e) });
  }
});

// The app is gone: leave at once, without the exit path that aborts.
process.on("disconnect", () => process.kill(process.pid, "SIGKILL"));
