import { describe, expect, it } from "vitest";
import { parseDomains, normalizeHost, sameSite } from "../src/main/domains.js";
import { imageKey, cssUrls } from "../src/main/image-urls.js";
import { verdictOf } from "../src/main/verdict.js";
import { parseKind } from "../src/main/classify.js";
import { newer } from "../src/main/update.js";

describe("domains", () => {
  it("cleans an Excel column with junk", () => {
    const text = "https://www.Site.ru/page?x=1\nsite.ru\n\nother.com/\t«third.org»\nnot a domain\nxn--80ak6aa92e.xn--p1ai";
    expect(parseDomains(text)).toEqual(["site.ru", "other.com", "third.org", "xn--80ak6aa92e.xn--p1ai"]);
  });
  it("turns a Cyrillic domain into punycode", () => {
    expect(normalizeHost("пример.рф")).toBe("xn--e1afmkfd.xn--p1ai");
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
  it("resolves relative URLs and skips svg/data", () => {
    expect(imageKey("/img/a.jpg", "https://site.ru/page/").download).toBe("https://site.ru/img/a.jpg");
    expect(imageKey("/logo.svg", "https://site.ru/")).toBeNull();
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
  it("parses fenced JSON and falls back to unsure", () => {
    expect(parseKind('```json\n{"kind":"people"}\n```')).toBe("people");
    expect(parseKind('{"kind":"cat"}')).toBe("unsure");
    expect(parseKind("no idea")).toBe("unsure");
  });
});

describe("update", () => {
  it("compares versions numerically", () => {
    expect(newer("0.10.0", "0.9.9")).toBe(true);
    expect(newer("0.1.0", "0.1.0")).toBe(false);
  });
});
