"use strict";

const fs = require("node:fs");
const path = require("node:path");
const ExcelJS = require("exceljs");
const { parseDomains } = require("./domains");

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
 * A file the user dropped or picked → domains in it. Excel (.xlsx), CSV/TSV and
 * plain text; anything that is not a domain is skipped.
 */
async function domainsFromFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".xls") {
    throw new Error("Старый формат .xls не читается. Откройте файл в Excel и сохраните как .xlsx или .csv.");
  }
  let text;
  if (ext === ".xlsx" || ext === ".xlsm") text = await excelText(file);
  else if (TEXT_EXT.has(ext)) text = fs.readFileSync(file, "utf8");
  else throw new Error(`Файл ${path.basename(file)} не подходит: нужен Excel (.xlsx), .csv или .txt.`);
  return parseDomains(text);
}

module.exports = { domainsFromFile };
