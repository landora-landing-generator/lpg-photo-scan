// Builds the domain-import fixtures in every format people bring a site list in.
// `node test/fixtures/make.mjs`; domains.xls comes from make_xls.py (xlwt).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import JSZip from "jszip";

const dir = path.dirname(fileURLToPath(import.meta.url));
const out = (name) => path.join(dir, name);

export const ROWS = [
  ["Название", "Сайт", "Контакт", "Заметка"],
  ["Ремонт кофемашин", "https://www.auto-coffee-service.ru/remont?utm=1", "info@auto-coffee-service.ru", "основной"],
  ["Компьютеры", "москва.частная-компьютерная.рф", "8 800 555-35-35", "цена 1.5 тыс"],
  ["Мастер Рома", "master-roma.ru/", "", "photo.jpg"],
  ["Дубль", "MASTER-ROMA.RU", "", ""],
  ["Ссылка", "https://komputer-remont.ru/", "", ""],
];

const csv = (sep) => ROWS.map((r) => r.map((v) => (v.includes(sep) ? `"${v}"` : v)).join(sep)).join("\r\n");

// Windows-1251 by hand: Node has a decoder for it but no encoder.
function cp1251(text) {
  return Buffer.from(
    [...text].map((ch) => {
      const c = ch.codePointAt(0);
      if (c < 0x80) return c;
      if (c >= 0x410 && c <= 0x44f) return c - 0x410 + 0xc0;
      if (c === 0x401) return 0xa8;
      if (c === 0x451) return 0xb8;
      return 0x3f;
    }),
  );
}

// .xlsx: a header, a hyperlink cell whose text is not the domain, a second sheet.
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("Сайты");
for (const row of ROWS.slice(0, 5)) ws.addRow(row);
ws.addRow(["Ссылка", { text: "сайт компании", hyperlink: "https://komputer-remont.ru/" }]);
wb.addWorksheet("Ещё").addRow(["master-roma.ru"]);
await wb.xlsx.writeFile(out("domains.xlsx"));

fs.writeFileSync(out("domains-utf8.csv"), csv(","));
fs.writeFileSync(out("domains-bom.csv"), "﻿" + csv(";"));
fs.writeFileSync(out("domains-1251.csv"), cp1251(csv(";")));
fs.writeFileSync(out("domains.tsv"), csv("\t"));
fs.writeFileSync(out("domains-utf16.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csv("\t"), "utf16le")]));
fs.writeFileSync(out("domains-list.txt"), ROWS.slice(1).map((r) => r[1]).join("\n"));
fs.writeFileSync(out("domains-oneline.txt"), ROWS.slice(1).map((r) => r[1]).join(", "));

// .ods: the parts LibreOffice needs to open it; a link cell with other text.
const cells = (row) => row.map((v) => `<table:table-cell office:value-type="string"><text:p>${v}</text:p></table:table-cell>`).join("");
const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" office:version="1.2"><office:body><office:spreadsheet><table:table table:name="Сайты">
${ROWS.slice(0, 5).map((r) => `<table:table-row>${cells(r)}</table:table-row>`).join("\n")}
<table:table-row><table:table-cell office:value-type="string"><text:p><text:a xlink:href="https://komputer-remont.ru/">сайт</text:a></text:p></table:table-cell></table:table-row>
</table:table></office:spreadsheet></office:body></office:document-content>`;
const zip = new JSZip();
zip.file("mimetype", "application/vnd.oasis.opendocument.spreadsheet", { compression: "STORE" });
zip.file("content.xml", content);
zip.file(
  "META-INF/manifest.xml",
  `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`,
);
fs.writeFileSync(out("domains.ods"), await zip.generateAsync({ type: "nodebuffer" }));
console.log("fixtures written");
