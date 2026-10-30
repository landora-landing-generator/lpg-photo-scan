"use strict";

const ExcelJS = require("exceljs");
const { VERDICT_TEXT, verdictOf, personKind, countKind } = require("./verdict");
const { displayHost, displayUrl } = require("./domains");

const FILL = {
  faces: "FFFBD0C0",
  people: "FFFDE2C2",
  unsure: "FFFFF3B0",
  clean: "FFD9F2D9",
  error: "FFE6E6E6",
};

/** Two sheets: one row per site, and one row per image with a person (for the people who will replace them). */
async function writeExcel(filePath, hosts, results) {
  const wb = new ExcelJS.Workbook();

  const sites = wb.addWorksheet("Сайты", { views: [{ state: "frozen", ySplit: 1 }] });
  sites.columns = [
    { header: "Домен", key: "host", width: 32 },
    { header: "Итог", key: "verdict", width: 20 },
    { header: "Кадров с лицами", key: "faces", width: 16 },
    { header: "Части людей", key: "bodies", width: 14 },
    { header: "Проверить глазами", key: "unsure", width: 18 },
    { header: "Кадров проверено", key: "images", width: 16 },
    { header: "Страниц", key: "pages", width: 10 },
    { header: "Причина / заметка", key: "note", width: 50 },
    { header: "Проверено", key: "checkedAt", width: 18 },
  ];
  for (const host of hosts) {
    const r = results[host];
    const row = sites.addRow(
      r
        ? {
            host: displayHost(host),
            verdict: VERDICT_TEXT[verdictOf(r)],
            faces: countKind(r, "face"),
            bodies: countKind(r, "body"),
            unsure: r.unsure.length,
            images: r.images,
            pages: r.pages,
            note: r.error ?? (r.unchecked ? `не проверено кадров: ${r.unchecked}` : ""),
            checkedAt: r.checkedAt ? new Date(r.checkedAt) : null,
          }
        : { host: displayHost(host), verdict: "Не проверен" },
    );
    if (r) row.getCell("verdict").fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILL[verdictOf(r)] } };
    row.getCell("checkedAt").numFmt = "dd.mm.yyyy hh:mm";
  }
  sites.getRow(1).font = { bold: true };
  sites.autoFilter = { from: "A1", to: "I1" };

  const images = wb.addWorksheet("Кадры с людьми", { views: [{ state: "frozen", ySplit: 1 }] });
  images.columns = [
    { header: "Домен", key: "host", width: 32 },
    { header: "Что", key: "kind", width: 18 },
    { header: "Страница", key: "page", width: 50 },
    { header: "Картинка", key: "url", width: 80 },
  ];
  for (const host of hosts) {
    const r = results[host];
    if (!r) continue;
    for (const [list, kindOf] of [
      [r.people, (img) => (personKind(img) === "face" ? "Лицо" : "Часть человека")],
      [r.unsure, () => "Проверить глазами"],
    ]) {
      for (const img of list) {
        const kind = kindOf(img);
        const row = images.addRow({ host: displayHost(host), kind, page: displayUrl(img.page), url: img.url });
        row.getCell("url").value = { text: img.url, hyperlink: img.url };
        row.getCell("url").font = { color: { argb: "FF1A56DB" }, underline: true };
      }
    }
  }
  images.getRow(1).font = { bold: true };

  await wb.xlsx.writeFile(filePath);
}

module.exports = { writeExcel };
