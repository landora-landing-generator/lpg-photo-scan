// Seals the whole .app with an ad-hoc signature after packing. Without it only
// the Electron binary carries Apple's linker signature, the bundle is unsealed,
// and macOS on Apple Silicon reports the app as "damaged" instead of offering
// "Open Anyway" in Privacy & Security.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
};
