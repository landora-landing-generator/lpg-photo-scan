"use strict";

const path = require("node:path");

/** "tild3835-…__nespresso.png" → "tild3835-…__nespresso": safe on any OS, Latin only (zip and Windows break Cyrillic names). */
function baseName(url) {
  let name;
  try {
    name = decodeURIComponent(path.posix.basename(new URL(url).pathname));
  } catch {
    name = "image";
  }
  name = name.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return (name || "image").slice(0, 80);
}

module.exports = { baseName };
