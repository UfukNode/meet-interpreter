// Renders src/icons/*.png from one SVG with Playwright's Chromium. Run once: node scripts/make-icons.mjs
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src/icons');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4c6ef5"/><stop offset="1" stop-color="#5f3dc4"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#g)"/>
  <path d="M26 24h50a12 12 0 0 1 12 12v24a12 12 0 0 1-12 12H48L32 85V72h-6a12 12 0 0 1-12-12V36a12 12 0 0 1 12-12z" fill="#ffffff"/>
  <rect x="28" y="38" width="44" height="7" rx="3.5" fill="#4c6ef5"/>
  <rect x="28" y="52" width="30" height="7" rx="3.5" fill="#4c6ef5"/>
  <path d="M62 56h42a12 12 0 0 1 12 12v22a12 12 0 0 1-12 12h-4v13L86 102H62a12 12 0 0 1-12-12V68a12 12 0 0 1 12-12z" fill="#ffd43b"/>
  <rect x="66" y="74" width="6" height="12" rx="3" fill="#3b2a00"/>
  <rect x="78" y="67" width="6" height="26" rx="3" fill="#3b2a00"/>
  <rect x="90" y="71" width="6" height="18" rx="3" fill="#3b2a00"/>
  <rect x="102" y="76" width="6" height="8" rx="3" fill="#3b2a00"/>
</svg>`;

await mkdir(out, { recursive: true });
const browser = await chromium.launch();
for (const size of [16, 32, 48, 128]) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: path.join(out, `icon${size}.png`), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
}
await browser.close();
console.log('icons written to src/icons');
