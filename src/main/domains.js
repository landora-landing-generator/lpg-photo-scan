"use strict";

/**
 * Turns whatever the user pasted (an Excel column, URLs, text with commas)
 * into a clean, de-duplicated list of hostnames in input order.
 */
function parseDomains(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text).split(/[\s,;]+/)) {
    const host = normalizeHost(raw);
    if (host && !seen.has(host)) {
      seen.add(host);
      out.push(host);
    }
  }
  return out;
}

/** "https://www.Site.ru/page?x" → "site.ru"; garbage → null. */
function normalizeHost(raw) {
  let s = String(raw).trim().replace(/^["'«(]+|["'»).]+$/g, "");
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = `http://${s}`;
  let host;
  try {
    host = new URL(s).hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  // Needs a dot and a letter TLD (Cyrillic TLDs arrive as punycode "xn--…").
  if (!/^[a-z0-9.-]+\.(?:[a-z]{2,}|xn--[a-z0-9-]+)$/.test(host)) return null;
  return host;
}

/** Same site for crawling: "www." and the bare host are one site. */
function sameSite(url, host) {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return h === host;
  } catch {
    return false;
  }
}

module.exports = { parseDomains, normalizeHost, sameSite };
