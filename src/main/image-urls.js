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
  if (SKIP_EXT.test(url.pathname) || TRACKER.test(url.hostname)) return null;
  const t = TILDA.exec(href);
  if (t) {
    const [, id, file] = t;
    return { key: `tilda:${id}/${file}`, download: `https://static.tildacdn.com/${id}/${file}` };
  }
  // Image CDNs wrap the original: shortpixel.ai/client/w_320/https://site.ru/a.jpg.
  const inner = /^\/.*?\/(https?:\/\/?.+)$/.exec(url.pathname);
  if (inner) {
    const k = imageKey(inner[1].replace(/^(https?:)\/(?!\/)/, "$1//") + url.search, baseUrl);
    if (k) return { key: k.key, download: href };
  }
  // WordPress and friends cut sizes as name-300x200.jpg; all of them are one photo.
  const sized = SIZE_SUFFIX.test(url.pathname);
  url.pathname = url.pathname.replace(SIZE_SUFFIX, "");
  // ?v=3 on a file is a cache buster; image.php?id=5 is the image itself.
  if (IMAGE_EXT.test(url.pathname)) url.search = "";
  return { key: url.href, download: href, sized };
}

// Size cuts of one upload: photo-300x200.jpg, photo-560x0.webp, photo-scaled.jpg.
const SIZE_SUFFIX = /-(?:\d{2,5}x\d{1,5}|scaled)(?=\.[a-z0-9]+$)/i;
// Counter pixels and ad beacons — never a photo.
const TRACKER = /(?:^|\.)(?:mc\.yandex\.ru|google-analytics\.com|googletagmanager\.com|facebook\.com|vk\.com|top-fwz1\.mail\.ru|counter\.yadro\.ru|doubleclick\.net)$/i;

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
