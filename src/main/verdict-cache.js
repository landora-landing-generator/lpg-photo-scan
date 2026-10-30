"use strict";

const fs = require("node:fs");
const path = require("node:path");

// What the model said about a file, by the file's bytes: the same photo on
// fifty sites of one template, or on the next run, is never paid for twice.
// The model name is part of the key — another model may see it differently.

const MAX_ENTRIES = 200_000;

function createVerdictCache(file) {
  let map = new Map();
  try {
    map = new Map(Object.entries(JSON.parse(fs.readFileSync(file, "utf8"))));
  } catch {
    /* first run or a broken file — start empty */
  }
  let dirty = false;
  let timer = null;

  function flush() {
    clearTimeout(timer);
    timer = null;
    if (!dirty) return;
    dirty = false;
    try {
      // Oldest first in a Map: drop from the front when it grows too big.
      while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(Object.fromEntries(map)));
      fs.renameSync(`${file}.tmp`, file);
    } catch {
      /* the cache only saves money — never fails a scan */
    }
  }

  return {
    get: (key) => map.get(key) ?? null,
    set(key, kind) {
      map.set(key, kind);
      dirty = true;
      timer ??= setTimeout(flush, 3000);
    },
    flush,
  };
}

module.exports = { createVerdictCache };
