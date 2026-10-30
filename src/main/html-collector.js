"use strict";

const { looksLikeImage, cssUrls } = require("./image-urls");

// Reads image and link URLs straight from page HTML, without a browser.
// Builders put the real file in the markup even when a script shows it later:
// Tilda in data-original, WordPress lazy loaders in data-src / data-srcset,
// galleries in <a href="big.jpg">, sliders in JSON inside <script>.

const TAG = /<([a-z][\w:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
// Absolute image URLs anywhere in the text, JSON-escaped slashes included.
const LOOSE_URL = /https?:\/\/[^\s"'<>()\\]+?\.(?:jpe?g|jfif|png|webp|avif|gif|bmp|tiff?|heic|heif|jxl)(?:\?[^\s"'<>()\\]*)?(?=[\s"'<>()\\,]|$)/gi;

const ENTITIES = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function attrsOf(raw) {
  const out = {};
  let m;
  ATTR.lastIndex = 0;
  while ((m = ATTR.exec(raw))) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}

const srcsetUrls = (v) =>
  String(v)
    .split(/,\s+|,(?=https?:|\/)/)
    .map((p) => p.trim().split(/\s+/)[0])
    .filter(Boolean);

// Markup of apps that draw themselves with a script: the HTML alone says little.
const SCRIPT_APP = /id=["'](?:root|app|__next|__nuxt)["']|__NUXT__|__NEXT_DATA__|data-reactroot|wixstatic|static\.parastorage/i;

/**
 * Everything worth looking at on one page: image candidates, links to other
 * pages and stylesheets (their backgrounds are photos too). URLs come back
 * absolute, against <base href> when the page sets one.
 */
function extractFromHtml(html, pageUrl) {
  const images = [];
  const links = [];
  const styles = [];
  let base = pageUrl;

  const abs = (u) => {
    const s = String(u ?? "").trim();
    if (!s || s.startsWith("data:") || s.startsWith("#") || /^(?:javascript|mailto|tel):/i.test(s)) return null;
    try {
      return new URL(s, base).href;
    } catch {
      return null;
    }
  };
  const image = (u) => {
    const a = abs(u);
    if (a) images.push(a);
  };
  const imageIfLooks = (u) => {
    if (looksLikeImage(u)) image(u);
  };

  let m;
  TAG.lastIndex = 0;
  while ((m = TAG.exec(html))) {
    const tag = m[1].toLowerCase();
    const a = attrsOf(m[2]);
    if (tag === "base" && a.href) base = abs(a.href) ?? base;

    if (tag === "img" || tag === "source" || tag === "input" || tag === "image") {
      if (tag === "img" || tag === "image" || (tag === "input" && /image/i.test(a.type ?? ""))) image(a.src);
      if (a.srcset) srcsetUrls(a.srcset).forEach(image);
      if (tag === "image") image(a.href ?? a["xlink:href"]);
    }
    if (tag === "video" && a.poster) image(a.poster);
    if (tag === "a" && a.href) {
      if (looksLikeImage(a.href)) image(a.href);
      else {
        const l = abs(a.href);
        if (l) links.push(l);
      }
    }
    if (tag === "link" && a.href) {
      const rel = (a.rel ?? "").toLowerCase();
      if (rel.includes("stylesheet")) {
        const s = abs(a.href);
        if (s) styles.push(s);
      } else if ((rel.includes("preload") && a.as === "image") || rel === "image_src") image(a.href);
      if (a.imagesrcset) srcsetUrls(a.imagesrcset).forEach(image);
    }
    if (tag === "meta" && /^(?:og:image|twitter:image)/i.test(a.property ?? a.name ?? "")) imageIfLooks(a.content);

    for (const [name, value] of Object.entries(a)) {
      if (name === "style") cssUrls(value).forEach(image);
      else if (name.startsWith("data-")) {
        if (/srcset/.test(name)) srcsetUrls(value).filter(looksLikeImage).forEach(image);
        else if (!/\s/.test(value.trim())) imageIfLooks(value);
        else cssUrls(value).forEach(imageIfLooks);
      }
    }
  }

  STYLE_BLOCK.lastIndex = 0;
  while ((m = STYLE_BLOCK.exec(html))) cssUrls(m[1]).filter(looksLikeImage).forEach(image);

  const loose = html.replace(/\\\//g, "/");
  LOOSE_URL.lastIndex = 0;
  while ((m = LOOSE_URL.exec(loose))) image(decodeEntities(m[0]));

  return {
    images: [...new Set(images)],
    links: [...new Set(links)],
    styles: [...new Set(styles)],
    scriptApp: SCRIPT_APP.test(html),
  };
}

/** Raster backgrounds of a stylesheet, absolute against the stylesheet's own URL. */
function extractFromCss(css, cssUrl) {
  const out = [];
  for (const u of cssUrls(css)) {
    if (!looksLikeImage(u)) continue;
    try {
      out.push(new URL(u, cssUrl).href);
    } catch {
      /* broken url() */
    }
  }
  return [...new Set(out)];
}

/** Page URLs listed in a sitemap (or the child sitemaps of a sitemap index). */
function extractFromSitemap(xml) {
  const locs = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) locs.push(decodeEntities(m[1]));
  return { index: /<sitemapindex\b/i.test(xml), locs };
}

module.exports = { extractFromHtml, extractFromCss, extractFromSitemap };
