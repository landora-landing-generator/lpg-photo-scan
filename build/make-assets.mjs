// Renders the app icon and the DMG window background (1x + 2x) from inline SVG.
// Run after editing: `node build/make-assets.mjs`. Outputs are committed.

import sharp from "sharp";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const out = (name) => path.join(dir, name);

const icon = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#1d4ed8"/>
    </linearGradient>
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="200" fill="url(#g)"/>
  <rect x="200" y="230" width="460" height="360" rx="36" fill="#ffffff" opacity="0.95"/>
  <circle cx="430" cy="360" r="62" fill="#1d4ed8"/>
  <path d="M310 560c0-80 54-130 120-130s120 50 120 130z" fill="#1d4ed8"/>
  <circle cx="640" cy="620" r="150" fill="none" stroke="#ffffff" stroke-width="56"/>
  <path d="M745 725l120 120" stroke="#ffffff" stroke-width="72" stroke-linecap="round"/>
</svg>`;

// DMG window is 600×420 points; Finder places the icons at (150,200) and (450,200).
const dmg = (scale) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${600 * scale}" height="${420 * scale}" viewBox="0 0 600 420">
  <rect width="600" height="420" fill="#f6f7f9"/>
  <text x="300" y="58" text-anchor="middle" font-family="-apple-system, Helvetica, Arial" font-size="20" font-weight="600" fill="#1c2430">Перетащите приложение в папку «Программы»</text>
  <path d="M232 200 H360" stroke="#2563eb" stroke-width="6" stroke-linecap="round"/>
  <path d="M350 184 L372 200 L350 216" fill="none" stroke="#2563eb" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="24" y="300" width="552" height="100" rx="12" fill="#fdf3c4"/>
  <text font-family="-apple-system, Helvetica, Arial" font-size="13.5" fill="#1c2430">
    <tspan x="44" y="326" font-weight="600">Mac не дал открыть приложение?</tspan>
    <tspan x="44" y="348">1. Откройте его двойным кликом и нажмите «Готово».</tspan>
    <tspan x="44" y="368">2. Системные настройки → Конфиденциальность и безопасность.</tspan>
    <tspan x="44" y="388">3. Внизу нажмите «Всё равно открыть» и введите пароль Mac.</tspan>
  </text>
</svg>`;

await sharp(Buffer.from(icon)).png().toFile(out("icon.png"));
await sharp(Buffer.from(dmg(1))).png().toFile(out("background.png"));
await sharp(Buffer.from(dmg(2))).png().toFile(out("background@2x.png"));
console.log("icon.png, background.png, background@2x.png");
