"use strict";

/**
 * Runs INSIDE the scanned page (stringified into executeJavaScript): scrolls to
 * the bottom so lazy loaders swap placeholders for real images, then reports
 * every image candidate and every link. Self-contained — no closures.
 */
async function collectInPage() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let last = -1;
  for (let step = 0; step < 80; step++) {
    window.scrollBy(0, Math.max(400, window.innerHeight * 0.8));
    await sleep(200);
    if (window.scrollY === last) break;
    last = window.scrollY;
  }
  await sleep(1200);

  const imageAttr = /\.(?:jpe?g|jfif|pjpeg|png|apng|webp|avif|gif|bmp|tiff?|heic|heif|jxl)(?:$|[?#])|tildacdn\./i;
  const found = [];
  const push = (url) => {
    if (url && typeof url === "string" && !url.startsWith("data:")) found.push(url.trim());
  };
  const fromSrcset = (srcset) => {
    for (const part of String(srcset).split(",")) push(part.trim().split(/\s+/)[0]);
  };

  for (const img of document.images) {
    push(img.currentSrc || img.src);
    if (img.srcset) fromSrcset(img.srcset);
  }
  for (const source of document.querySelectorAll("source[srcset]")) fromSrcset(source.srcset);
  for (const video of document.querySelectorAll("video[poster]")) push(video.poster);
  for (const input of document.querySelectorAll('input[type="image"][src]')) push(input.src);
  for (const svgImage of document.querySelectorAll("svg image")) {
    push(svgImage.href?.baseVal || svgImage.getAttribute("href") || svgImage.getAttribute("xlink:href"));
  }
  for (const obj of document.querySelectorAll("object[data], embed[src]")) {
    const u = obj.getAttribute("data") || obj.getAttribute("src");
    if (imageAttr.test(u || "")) push(u);
  }

  for (const el of document.querySelectorAll("*")) {
    for (const attr of el.attributes) {
      if (attr.name.startsWith("data-") && imageAttr.test(attr.value) && !/\s/.test(attr.value.trim())) {
        push(attr.value);
      }
    }
    const bg = getComputedStyle(el).backgroundImage;
    if (bg && bg !== "none") {
      const re = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
      let m;
      while ((m = re.exec(bg))) push(m[2]);
    }
  }

  return {
    finalUrl: location.href,
    images: [...new Set(found)],
    links: [...new Set([...document.links].map((a) => a.href))],
  };
}

module.exports = { collectScript: `(${collectInPage.toString()})()` };
