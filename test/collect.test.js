import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { extractFromHtml, extractFromCss, extractFromSitemap } from "../src/main/html-collector.js";
import { imageKey } from "../src/main/image-urls.js";
import { createVerdictCache } from "../src/main/verdict-cache.js";

describe("images from HTML without a browser", () => {
  const page = "https://site.ru/uslugi/";
  const html = `<!doctype html><html><head>
    <link rel="stylesheet" href="/css/site.css?v=2">
    <meta property="og:image" content="https://site.ru/og.jpg">
    <style>.hero{background:url('/img/hero.webp')}</style>
    </head><body>
    <img src="a.jpg" srcset="a-300x200.jpg 300w, a-1024x683.jpg 1024w">
    <img src="data:image/gif;base64,R0lGOD" data-src="/lazy/b.png" data-srcset="/lazy/b-640x480.png 640w">
    <div class="t-bgimg" data-original="https://static.tildacdn.com/tild1234-abcd/photo.jpg"></div>
    <div style="background-image: url(&quot;/img/bg.jpg&quot;)"></div>
    <picture><source srcset="/p/c.avif" type="image/avif"><img src="/p/c.jpg"></picture>
    <a href="/gallery/big.jpg">open</a> <a href="/contacts/">contacts</a> <a href="tel:+7900">call</a>
    <video poster="/v/poster.jpg"></video>
    <script>var slides = [{"img":"https:\\/\\/cdn.site.ru\\/s\\/slide.jpeg"}];</script>
    </body></html>`;
  const r = extractFromHtml(html, page);

  it("finds every place a photo hides", () => {
    for (const want of [
      "https://site.ru/uslugi/a.jpg",
      "https://site.ru/uslugi/a-1024x683.jpg",
      "https://site.ru/lazy/b.png",
      "https://site.ru/lazy/b-640x480.png",
      "https://static.tildacdn.com/tild1234-abcd/photo.jpg",
      "https://site.ru/img/bg.jpg",
      "https://site.ru/img/hero.webp",
      "https://site.ru/p/c.avif",
      "https://site.ru/gallery/big.jpg",
      "https://site.ru/v/poster.jpg",
      "https://site.ru/og.jpg",
      "https://cdn.site.ru/s/slide.jpeg",
    ]) {
      expect(r.images).toContain(want);
    }
    expect(r.images.some((u) => u.startsWith("data:"))).toBe(false);
  });
  it("returns page links and stylesheets, not phone links", () => {
    expect(r.links).toEqual(["https://site.ru/contacts/"]);
    expect(r.styles).toEqual(["https://site.ru/css/site.css?v=2"]);
  });
  it("respects <base href>", () => {
    const b = extractFromHtml('<base href="https://cdn.site.ru/x/"><img src="p.jpg">', "https://site.ru/");
    expect(b.images).toEqual(["https://cdn.site.ru/x/p.jpg"]);
  });
  it("flags script-drawn apps", () => {
    expect(extractFromHtml('<div id="root"></div>', page).scriptApp).toBe(true);
    expect(r.scriptApp).toBe(false);
  });
  it("reads stylesheet backgrounds against the stylesheet URL", () => {
    expect(extractFromCss(".a{background:url(../img/x.jpg)} @font-face{src:url(f.woff2)}", "https://site.ru/css/s.css")).toEqual([
      "https://site.ru/img/x.jpg",
    ]);
  });
  it("reads sitemaps and sitemap indexes", () => {
    expect(extractFromSitemap("<urlset><url><loc>https://site.ru/a/</loc></url></urlset>")).toEqual({ index: false, locs: ["https://site.ru/a/"] });
    expect(extractFromSitemap("<sitemapindex><sitemap><loc>https://site.ru/s1.xml</loc></sitemap></sitemapindex>").index).toBe(true);
  });
});

describe("one photo in many sizes is one image", () => {
  it("folds WordPress size cuts and keeps the original to download", () => {
    const a = imageKey("https://site.ru/wp-content/uploads/0-13-300x281.jpg");
    const b = imageKey("https://site.ru/wp-content/uploads/0-13.jpg");
    expect(a.key).toBe(b.key);
    expect(a.sized).toBe(true);
    expect(b.sized).toBe(false);
  });
  it("unwraps image CDN proxies", () => {
    const a = imageKey("https://sp-ao.shortpixel.ai/client/to_auto,q_glossy,w_320/https://site.ru/up/p.jpg");
    expect(a.key).toBe(imageKey("https://site.ru/up/p.jpg").key);
    expect(a.download).toContain("shortpixel");
  });
  it("drops cache busters on files but keeps ids of script images", () => {
    expect(imageKey("https://site.ru/a.jpg?v=3").key).toBe(imageKey("https://site.ru/a.jpg").key);
    expect(imageKey("https://site.ru/image.php?id=5").key).not.toBe(imageKey("https://site.ru/image.php?id=6").key);
  });
  it("skips counter pixels", () => {
    expect(imageKey("https://mc.yandex.ru/watch/123")).toBeNull();
  });
});

describe("verdict cache", () => {
  it("remembers answers between runs", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lpg-vc-")), "v.json");
    const a = createVerdictCache(file);
    a.set("m:abc", "face");
    a.flush();
    expect(createVerdictCache(file).get("m:abc")).toBe("face");
    expect(createVerdictCache(file).get("m:zzz")).toBeNull();
  });
  it("starts empty on a broken file", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lpg-vc-")), "v.json");
    fs.writeFileSync(file, "{broken");
    expect(createVerdictCache(file).get("x")).toBeNull();
  });
});
