// Renders brand/og.html to site/og.png (1200x630). Needs Playwright with a Chromium; set CHROME to its path if needed.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(import.meta.url)('playwright');
const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
await p.goto(pathToFileURL(path.join(here, 'og.html')).href);
await p.screenshot({ path: path.join(here, '..', 'site', 'og.png') });
await b.close();
