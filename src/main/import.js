"use strict";

const fs = require("node:fs");
const path = require("node:path");
const ExcelJS = require("exceljs");
const { parseDomains } = require("./domains");

const JSZip = require("jszip");

const TEXT_EXT = new Set([".txt", ".csv", ".tsv", ".list", ""]);

/** Every cell of every sheet as text — the domains column can be anywhere. */
async function excelText(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const parts = [];
  wb.eachSheet((sheet) =>
    sheet.eachRow((row) =>
      row.eachCell((cell) => {
        const v = cell.value;
        if (v == null) return;
        if (typeof v === "object") {
          if (v.hyperlink) parts.push(v.hyperlink);
          if (v.text) parts.push(typeof v.text === "string" ? v.text : JSON.stringify(v.text));
          if (v.richText) parts.push(v.richText.map((t) => t.text).join(""));
          if (v.result) parts.push(String(v.result));
        } else {
          parts.push(String(v));
        }
      }),
    ),
  );
  return parts.join("\n");
}

/**
 * Old binary Excel (.xls, BIFF8). No parser is shipped for it: cell strings sit
 * in the file as Latin-1 or UTF-16LE runs, and the domain filter downstream
 * throws away everything that is not a domain — enough for a list of sites.
 */
function xlsText(buf) {
  // Binary bytes glue onto the strings; cut everything that is not text into separators.
  const latin = buf.toString("latin1").replace(/[^\x20-\x7e]+/g, "\n");
  const wide = (b) => b.toString("utf16le").replace(/[^\x20-\x7e\u0400-\u04ff]+/g, "\n");
  return [latin, wide(buf), wide(buf.subarray(1))].join("\n");
}

/** LibreOffice / OpenDocument spreadsheet: cell text and link targets from content.xml. */
async function odsText(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const xml = await zip.file("content.xml")?.async("string");
  if (!xml) throw new Error("Файл .ods повреждён: внутри нет таблицы.");
  const links = [...xml.matchAll(/xlink:href="([^"]*)"/g)].map((m) => m[1]);
  return [xml.replace(/<[^>]+>/g, " "), ...links]
    .join(" ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Text files come from anywhere: UTF-8 (with or without BOM), UTF-16 from
 * Excel's "Unicode text", Windows-1251 from a Russian Excel's CSV export.
 */
function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf.subarray(2));
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
  // UTF-16 without a BOM: every other byte of Latin text is zero.
  const sample = buf.subarray(0, 400);
  const zeros = sample.filter((b, i) => i % 2 === 1 && b === 0).length;
  if (sample.length > 8 && zeros > sample.length / 4) return new TextDecoder("utf-16le").decode(buf);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("windows-1251").decode(buf);
  }
}

/**
 * A file the user dropped or picked → domains in it. Excel (.xlsx, .xls),
 * OpenDocument (.ods), CSV/TSV and plain text in any common encoding;
 * anything that is not a domain is skipped.
 */
async function domainsFromFile(file) {
  const ext = path.extname(file).toLowerCase();
  let text;
  if (ext === ".xlsx" || ext === ".xlsm") text = await excelText(file);
  else if (ext === ".xls") text = xlsText(fs.readFileSync(file));
  else if (ext === ".ods") text = await odsText(file);
  else if (TEXT_EXT.has(ext)) text = decodeText(fs.readFileSync(file));
  else throw new Error(`Файл ${path.basename(file)} не подходит: нужен Excel (.xlsx, .xls), .ods, .csv или .txt.`);
  return parseDomains(text);
}

module.exports = { domainsFromFile, decodeText };
