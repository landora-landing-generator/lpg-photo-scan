import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { domainsFromFile } from "../src/main/import.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

// Every fixture holds the same sites among headers, e-mails, phones, file names,
// duplicates and hyperlinks whose text is not the domain.
const EXPECTED = [
  "auto-coffee-service.ru",
  "xn--80adxhks.xn----7sbaby3aoefhmneoh3e1eqbmm.xn--p1ai", // москва.частная-компьютерная.рф
  "master-roma.ru",
  "komputer-remont.ru",
].sort();

describe("domains from files", () => {
  for (const file of [
    "domains.xlsx",
    "domains.xls",
    "domains.ods",
    "domains-utf8.csv",
    "domains-bom.csv",
    "domains-1251.csv",
    "domains.tsv",
    "domains-utf16.txt",
    "domains-list.txt",
    "domains-oneline.txt",
  ]) {
    it(file, async () => {
      expect((await domainsFromFile(path.join(dir, file))).sort()).toEqual(EXPECTED);
    });
  }

  it("refuses a file that is not a list", async () => {
    await expect(domainsFromFile(path.join(dir, "..", "pure.test.js"))).rejects.toThrow(/не подходит/);
  });
});
