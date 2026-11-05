// Puts the background-removal model into models/ before a build. The file is
// too big for git (114 MB > GitHub's 100 MB limit), so it comes from a pinned
// revision on Hugging Face and is checked by its SHA-256.
// BiRefNet lite (ZhengPeng7/BiRefNet_lite, MIT), ONNX fp16 by onnx-community.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REVISION = "de15b22ba131738a16dff04aab8bdf8dc32e3ac1";
const URL = `https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/${REVISION}/onnx/model_fp16.onnx`;
const SHA256 = "d39b897ceb16ae654c1731f3dba0cf9b368d9cae74b5a57459b455cc8bfec402";
const target = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "models", "birefnet-lite-fp16.onnx");

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

if (fs.existsSync(target) && sha(fs.readFileSync(target)) === SHA256) {
  console.log(`model ok: ${target}`);
} else {
  console.log(`downloading ${URL}`);
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha(buf) !== SHA256) throw new Error(`model checksum mismatch: ${sha(buf)}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buf);
  console.log(`model saved: ${target} (${buf.length} B)`);
}
