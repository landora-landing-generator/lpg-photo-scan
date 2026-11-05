import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { backgroundKind, kindOfPixels, unmatteWhite } from "../src/main/cutout.js";
import { cutoutFormat } from "../src/main/web-image.js";

const svg = (body, w = 400, h = 500) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`);
const person = '<ellipse cx="200" cy="260" rx="110" ry="190" fill="#2b4c8c"/>';

describe("background of the old frame", () => {
  it("a cut-out subject on transparency", async () => {
    expect(await backgroundKind(await sharp(svg(person)).png().toBuffer())).toBe("transparent");
    expect(await backgroundKind(await sharp(svg(person)).webp({ lossless: true }).toBuffer())).toBe("transparent");
  });
  it("a subject on a plain white or near-white field", async () => {
    expect(await backgroundKind(await sharp(svg(`<rect width="400" height="500" fill="#fff"/>${person}`)).jpeg().toBuffer())).toBe("white");
    expect(await backgroundKind(await sharp(svg(`<rect width="400" height="500" fill="#f1f1ef"/>${person}`)).jpeg().toBuffer())).toBe("white");
  });
  it("an ordinary photo and a rounded-corner photo are not cut-outs", async () => {
    const photo = svg('<rect width="400" height="500" fill="#7a8f6a"/><rect y="300" width="400" height="200" fill="#5b4a3a"/>' + person);
    expect(await backgroundKind(await sharp(photo).jpeg().toBuffer())).toBe(null);
    const rounded = svg('<rect width="400" height="500" rx="40" fill="#7a8f6a"/>' + person);
    expect(await backgroundKind(await sharp(rounded).png().toBuffer())).toBe(null);
  });
  it("a coloured studio backdrop is not white", () => {
    const px = Buffer.alloc(10 * 10 * 4);
    for (let i = 0; i < 100; i++) px.set([120, 170, 230, 255], i * 4);
    expect(kindOfPixels(px, 10, 10, false)).toBe(null);
  });
});

describe("cut-out edges", () => {
  it("takes the white back out of half-transparent edge pixels", () => {
    // 50% of pure red over white = (255, 128, 128); the subject's own colour is red.
    const out = unmatteWhite(Buffer.from([255, 128, 128, 255, 255, 255, 10, 20, 30]), Buffer.from([128, 0, 255]));
    expect(out[0]).toBe(255);
    expect(out[1]).toBeLessThanOrEqual(3);
    expect(out[2]).toBeLessThanOrEqual(3);
    expect(out[3]).toBe(128);
    expect(out[7]).toBe(0);
    expect([...out.subarray(8, 12)]).toEqual([10, 20, 30, 255]);
  });
  it("keeps WebP for WebP/AVIF originals, PNG otherwise", () => {
    expect(cutoutFormat("https://a.ru/x.webp")).toBe("webp");
    expect(cutoutFormat("https://a.ru/x.avif?v=2")).toBe("webp");
    expect(cutoutFormat("https://optim.tildacdn.com/tild1-2/-/format/webp/photo.png")).toBe("webp");
    expect(cutoutFormat("https://a.ru/x.png")).toBe("png");
  });
});
