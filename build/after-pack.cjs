// After packing: (1) drop onnxruntime binaries of other platforms and CPUs —
// the package ships all of them (~200 MB) and only one runs here; (2) on macOS
// seal the whole .app with an ad-hoc signature. Without the seal only the
// Electron binary carries Apple's linker signature, the bundle is unsealed, and
// macOS on Apple Silicon reports the app as "damaged" instead of offering
// "Open Anyway" in Privacy & Security.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { Arch } = require("builder-util");

function findDir(root, tail) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (dir.endsWith(tail)) return dir;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && !e.isSymbolicLink()) stack.push(path.join(dir, e.name));
    }
  }
  return null;
}

function pruneOnnxRuntime(context) {
  const bins = findDir(context.appOutDir, path.join("app.asar.unpacked", "node_modules", "onnxruntime-node", "bin", "napi-v6"));
  if (!bins) throw new Error("onnxruntime-node binaries not found in the package");
  const platform = { darwin: "darwin", mas: "darwin", win32: "win32", linux: "linux" }[context.electronPlatformName];
  const arch = Arch[context.arch];
  for (const p of fs.readdirSync(bins)) {
    for (const a of fs.readdirSync(path.join(bins, p))) {
      if (p !== platform || a !== arch) fs.rmSync(path.join(bins, p, a), { recursive: true, force: true });
    }
    if (!fs.readdirSync(path.join(bins, p)).length) fs.rmdirSync(path.join(bins, p));
  }
  if (!fs.existsSync(path.join(bins, platform, arch))) throw new Error(`onnxruntime-node has no build for ${platform}/${arch}`);
}

exports.default = async function afterPack(context) {
  pruneOnnxRuntime(context);
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
};
