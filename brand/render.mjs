import { createRequire } from 'node:module';
import fs from 'node:fs';
const { chromium } = createRequire(import.meta.url)('/opt/npm-tools/node_modules/playwright');
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const p = await b.newPage();
for (const [file, out, size] of JSON.parse(process.argv[2])) {
  await p.setViewportSize({ width: size, height: size });
  await p.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${fs.readFileSync(file, 'utf8')}`);
  await p.screenshot({ path: out, omitBackground: true });
}
await b.close();
