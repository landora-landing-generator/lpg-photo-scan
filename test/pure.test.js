import { describe, expect, it } from "vitest";
import { parseDomains, normalizeHost, sameSite, displayHost, displayUrl } from "../src/main/domains.js";
import { imageKey, cssUrls } from "../src/main/image-urls.js";
import { verdictOf } from "../src/main/verdict.js";
import { parseKind, cleanPrompt } from "../src/main/classify.js";
import { aspectRatioFor, openAiSize, polzaResult } from "../src/main/draw.js";
import { baseName } from "../src/main/redraw-names.js";
import { newer } from "../src/main/update.js";

describe("domains", () => {
  it("cleans an Excel column with junk", () => {
    const text = "https://www.Site.ru/page?x=1\nsite.ru\n\nother.com/\t«third.org»\nnot a domain\nxn--80ak6aa92e.xn--p1ai";
    expect(parseDomains(text)).toEqual(["site.ru", "other.com", "third.org", "xn--80ak6aa92e.xn--p1ai"]);
  });
  it("skips e-mails and file names found in spreadsheets", () => {
    expect(parseDomains("info@site.ru\nphoto.jpg\nprice.xlsx\nКомпания\nreal.ru")).toEqual(["real.ru"]);
  });
  it("turns a Cyrillic domain into punycode", () => {
    expect(normalizeHost("пример.рф")).toBe("xn--e1afmkfd.xn--p1ai");
    expect(normalizeHost("https://www.Пример.РФ/страница")).toBe("xn--e1afmkfd.xn--p1ai");
    expect(displayHost("xn--e1afmkfd.xn--p1ai")).toBe("пример.рф");
    expect(displayUrl("https://xn--e1afmkfd.xn--p1ai/%D1%83%D1%81%D0%BB%D1%83%D0%B3%D0%B8")).toBe("https://пример.рф/услуги");
  });
  it("treats www and bare host as one site", () => {
    expect(sameSite("https://www.site.ru/a", "site.ru")).toBe(true);
    expect(sameSite("https://cdn.site.ru/a", "site.ru")).toBe(false);
  });
});

describe("image keys", () => {
  const id = "tild3335-6435-4434-b965-623237306533";
  it("folds Tilda variants into one original", () => {
    const a = imageKey(`https://thumb.tildacdn.com/${id}/-/resize/20x/photo.jpg`);
    const b = imageKey(`https://optim.tildacdn.com/${id}/-/format/webp/photo.jpg`);
    const c = imageKey(`https://static.tildacdn.com/${id}/photo.jpg`);
    expect(a.key).toBe(c.key);
    expect(b.key).toBe(c.key);
    expect(a.download).toBe(`https://static.tildacdn.com/${id}/photo.jpg`);
  });
  it("keeps raster formats, drops svg/ico and non-http", () => {
    expect(imageKey("/img/a.jpg", "https://site.ru/page/").download).toBe("https://site.ru/img/a.jpg");
    for (const ext of ["png", "webp", "bmp", "avif", "tiff", "heic", "jxl"]) {
      expect(imageKey(`/img/a.${ext}`, "https://site.ru/")).not.toBeNull();
    }
    for (const ext of ["svg", "ico"]) expect(imageKey(`/img/a.${ext}`, "https://site.ru/")).toBeNull();
    expect(imageKey("javascript:void(0)", "https://site.ru/")).toBeNull();
  });
  it("reads css url() values", () => {
    expect(cssUrls('url("a.jpg"), url(b.png), url(data:image/png;base64,xx)')).toEqual(["a.jpg", "b.png"]);
  });
});

describe("verdict", () => {
  const base = { people: [], unsure: [], unchecked: 0, error: null };
  it("orders error > people > unsure > clean", () => {
    expect(verdictOf({ ...base, error: "x", people: [{}] })).toBe("error");
    expect(verdictOf({ ...base, people: [{}], unsure: [{}] })).toBe("people");
    expect(verdictOf({ ...base, unchecked: 1 })).toBe("unsure");
    expect(verdictOf(base)).toBe("clean");
  });
});

describe("model answer", () => {
  it("reads one word, tolerates noise, falls back to unsure", () => {
    expect(parseKind("people")).toBe("people");
    expect(parseKind("Photo.")).toBe("photo");
    expect(parseKind('{"kind":"graphic"}')).toBe("graphic");
    expect(parseKind("cat")).toBe("unsure");
  });
  it("cleans a described prompt", () => {
    expect(cleanPrompt('Prompt: "A technician at work."')).toBe("A technician at work.");
  });
});

describe("update", () => {
  it("compares versions numerically", () => {
    expect(newer("0.10.0", "0.9.9")).toBe(true);
    expect(newer("0.1.0", "0.1.0")).toBe(false);
  });
});

describe("drawing sizes", () => {
  it("picks the nearest ratio and a 16px grid size", () => {
    expect(aspectRatioFor(1200, 800)).toBe("3:2");
    expect(aspectRatioFor(1920, 1080)).toBe("16:9");
    expect(openAiSize(1200, 800)).toBe("1200x800");
    expect(openAiSize(300, 200)).toBe("512x512");
  });
});

describe("export names", () => {
  it("keeps a Latin, OS-safe base name", () => {
    expect(baseName("https://site.ru/img/Фото%20мастер.PNG")).toBe("image");
    expect(baseName("https://site.ru/img/team_photo-1.webp?x=1")).toBe("team_photo-1");
  });
});

describe("polza.ai answer", () => {
  it("finds the picture wherever the docs put it", () => {
    expect(polzaResult({ data: { url: "https://x/a.jpg" } })).toEqual({ url: "https://x/a.jpg" });
    expect(polzaResult({ data: [{ url: "https://x/b.jpg" }] })).toEqual({ url: "https://x/b.jpg" });
    expect(polzaResult({ output: { url: "https://x/c.jpg" } })).toEqual({ url: "https://x/c.jpg" });
    expect(polzaResult({ data: { images: [{ url: "https://x/d.jpg" }] } })).toEqual({ url: "https://x/d.jpg" });
    expect(polzaResult({ status: "completed" })).toBeNull();
  });
});
