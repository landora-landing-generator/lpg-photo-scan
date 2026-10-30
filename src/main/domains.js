"use strict";

const { domainToUnicode } = require("node:url");

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

const NOT_A_TLD = /^[^/]+\.(?:jpe?g|png|gif|webp|svg|pdf|docx?|xlsx?|csv|txt|zip|rar|html?|php|js|css|json|xml|exe|dmg)$/i;

/** "https://www.Site.ru/page?x" → "site.ru"; garbage → null. */
function normalizeHost(raw) {
  let s = String(raw).trim().replace(/^["'«(]+|["'»).]+$/g, "");
  // E-mails and file names in a spreadsheet look like domains but are not sites.
  if (!s || s.includes("@") || NOT_A_TLD.test(s)) return null;
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

/** "xn--e1afmkfd.xn--p1ai" → "пример.рф" for people; the punycode form stays the key. */
const displayHost = (host) => domainToUnicode(host) || host;

module.exports = { parseDomains, normalizeHost, sameSite, displayHost };
