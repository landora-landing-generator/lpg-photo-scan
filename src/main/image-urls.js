"use strict";

// Raster formats only: photos live in these. SVG and ICO are icons and logos —
// checking them would only spend the model.
const IMAGE_EXT = /\.(?:jpe?g|jfif|pjpeg|png|apng|webp|avif|gif|bmp|tiff?|heic|heif|jxl)(?:$|[?#])/i;
const SKIP_EXT = /\.(?:svgz?|ico|cur)(?:$|[?#])/i;

// Tilda serves one upload under several CDN hosts and transform paths:
//   static.tildacdn.com/tild3335-…/photo.jpg            (original)
//   thumb.tildacdn.com/tild3335-…/-/resize/20x/photo.jpg (lazy-load placeholder)
//   optim.tildacdn.com/tild3335-…/-/format/webp/photo.jpg
const TILDA = /^https?:\/\/[a-z]+\.tildacdn\.[a-z]+\/(tild[0-9a-f-]+)\/(?:-\/[^/]+\/[^/]+\/)*([^/?#]+)/i;

/**
 * Identity of an image across its size/format variants, plus the URL worth
 * downloading (the largest original we can name). null → not an image to check.
 */
function imageKey(rawUrl, baseUrl) {
  let url;
  try {
    url = new URL(rawUrl, baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  const href = url.href;
  if (SKIP_EXT.test(url.pathname)) return null;
  const t = TILDA.exec(href);
  if (t) {
    const [, id, file] = t;
    return { key: `tilda:${id}/${file}`, download: `https://static.tildacdn.com/${id}/${file}` };
  }
  return { key: href, download: href };
}

/** A URL found in a data-* attribute only counts when it looks like an image file. */
function looksLikeImage(rawUrl) {
  return IMAGE_EXT.test(String(rawUrl)) || TILDA.test(String(rawUrl));
}

/** Pulls every url(...) out of a CSS background-image value. */
function cssUrls(value) {
  const out = [];
  const re = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
  let m;
  while ((m = re.exec(String(value)))) if (m[2] && !m[2].startsWith("data:")) out.push(m[2]);
  return out;
}

module.exports = { imageKey, looksLikeImage, cssUrls };
