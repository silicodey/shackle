// Renders the web app icons in server/public from server/public/icon.svg.
// Needs Playwright with a Chromium; set CHROME to its path if needed.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'server', 'public');
const svg = fs.readFileSync(path.join(pub, 'icon.svg'), 'utf8');
// Maskable: square background to the edges, mark inside the central safe zone.
const maskable = svg.replace('rx="15"', 'rx="0"').replace(/(<rect width="64"[^>]*>)/, '$1<g transform="translate(9.6 9.6) scale(0.7)">').replace('</svg>', '</g></svg>');
const { chromium } = createRequire(import.meta.url)('playwright');
const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const p = await b.newPage();
for (const [src, out, size] of [[svg, 'icon-192.png', 192], [svg, 'icon-512.png', 512], [maskable, 'icon-maskable-512.png', 512]]) {
  await p.setViewportSize({ width: size, height: size });
  await p.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${src}`);
  await p.screenshot({ path: path.join(pub, out), omitBackground: true });
}
await b.close();
