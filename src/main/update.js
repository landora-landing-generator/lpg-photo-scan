"use strict";

const pkg = require("../../package.json");

// Unsigned apps cannot update themselves on macOS, so the app only says
// "there is a new version" and links to the download page.

function newer(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

/** → { version, url } when GitHub has a newer release; null otherwise or offline. */
async function checkForUpdate(current) {
  if (!pkg.updateRepo) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${pkg.updateRepo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const version = String((await res.json()).tag_name ?? "").replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+$/.test(version) || !newer(version, current)) return null;
    return { version, url: pkg.downloadPage };
  } catch {
    return null;
  }
}

module.exports = { checkForUpdate, newer };
