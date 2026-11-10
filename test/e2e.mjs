// End-to-end test: real server + real Electron host (on a virtual X display) + real Chrome viewer.
// Linux only. Usage:  Xvfb :99 -screen 0 1280x800x24 &  DISPLAY=:99 node test/e2e.mjs
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pwPath = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium, _electron: electron } = require(pwPath);

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shackle-e2e-'));
const PORT = 8097;
const URL = `http://127.0.0.1:${PORT}`;
const EMAIL = 'owner@example.com';
const PASSWORD = 'correct horse battery';
const ACCESS = 'unattended-secret-1';

const results = [];
const step = async (name, fn) => {
  const t = Date.now();
  try {
    await fn();
    results.push([true, name]);
    console.log(`  ok   ${name} (${Date.now() - t} ms)`);
  } catch (e) {
    results.push([false, name]);
    console.log(`  FAIL ${name}\n       ${String(e.message).split('\n')[0]}`);
    throw e;
  }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server, browser, app;
try {
  /* ---------- server ---------- */
  let setupCode = null;
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    cwd: path.join(root, 'server'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR: path.join(tmp, 'data'), STUN_URLS: '' },
  });
  server.stdout.on('data', (d) => {
    const m = /setup code:\s+(\S+)/.exec(String(d));
    if (m) setupCode = m[1];
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  for (let i = 0; i < 50 && !setupCode; i++) await sleep(100);
  assert(setupCode, 'server did not print a setup code');

  /* ---------- viewer browser ---------- */
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: URL });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(e.message));

  await step('first-run setup creates the owner account', async () => {
    await page.goto(URL);
    await page.fill('input[name=code]', 'wrong-code');
    await page.fill('input[name=email]', EMAIL);
    await page.fill('input[name=password]', PASSWORD);
    await page.click('#auth-submit');
    await page.waitForFunction(() => document.getElementById('auth-error').textContent.includes('setup code'));
    await page.fill('input[name=code]', setupCode);
    await page.click('#auth-submit');
    await page.waitForSelector('#app:not([hidden])');
    assert((await page.textContent('#me')) === EMAIL, 'signed-in email not shown');
  });

  await step('sign out, wrong password rejected, sign in', async () => {
    await page.click('#logout');
    await page.waitForSelector('#auth:not([hidden])');
    await page.fill('input[name=email]', EMAIL);
    await page.fill('input[name=password]', 'nope nope nope');
    await page.click('#auth-submit');
    await page.waitForFunction(() => document.getElementById('auth-error').textContent.includes('Wrong'));
    await page.fill('input[name=password]', PASSWORD);
    await page.click('#auth-submit');
    await page.waitForSelector('#app:not([hidden])');
  });

  await step('API refuses unauthenticated and cross-origin requests', async () => {
    const anon = await fetch(`${URL}/api/devices`);
    assert(anon.status === 401, `anonymous device list returned ${anon.status}`);
    const cookie = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
    const csrf = await fetch(`${URL}/api/logout`, {
      method: 'POST', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}',
    });
    assert(csrf.status === 403, `cross-origin POST returned ${csrf.status}`);
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?role=viewer`);
    const opened = await new Promise((r) => { ws.onopen = () => r(true); ws.onerror = () => r(false); });
    assert(!opened, 'viewer socket opened without a session');
  });

  /* ---------- host app ---------- */
  app = await electron.launch({
    executablePath: require(path.join(root, 'host', 'node_modules', 'electron')),
    args: ['.', '--no-sandbox'],
    cwd: path.join(root, 'host'),
    env: {
      ...process.env, SHACKLE_SERVER_URL: URL, SHACKLE_USER_DATA: path.join(tmp, 'host'),
      SHACKLE_TEST_FILE: path.join(tmp, 'state.json'), SHACKLE_TEST_AUTO_ACCEPT: '1', SHACKLE_DEBUG: '1', NODE_OPTIONS: '',
    },
  });
  const hostLog = fs.createWriteStream(path.join(tmp, 'host.log'));
  app.process().stdout.pipe(hostLog);
  app.process().stderr.pipe(hostLog);
  let panel = null;
  for (let i = 0; i < 100 && !panel; i++) {
    panel = app.windows().find((w) => w.url().endsWith('panel.html')) || null;
    if (!panel) await sleep(100);
  }
  assert(panel, 'host panel window did not open');
  const hostErrors = [];
  for (const w of app.windows()) w.on('pageerror', (e) => hostErrors.push(e.message));

  const creds = async () => ({
    code: (await panel.textContent('#code')).replace(/\D/g, ''),
    pass: (await panel.textContent('#pass')).replace(/\s/g, ''),
  });

  await step('host registers and shows an ID and one-time password', async () => {
    await panel.waitForFunction(() => document.getElementById('status').textContent === 'Ready');
    const c = await creds();
    assert(/^\d{9}$/.test(c.code), `bad code ${c.code}`);
    assert(/^[a-z0-9]{8}$/.test(c.pass), `bad password ${c.pass}`);
  });

  const join = async (code, pass) => {
    await page.fill('#join-form input[name=code]', code);
    await page.fill('#join-form input[name=password]', pass);
    await page.click('#join-form button');
  };
  const live = () => page.waitForSelector('#stage.live', { timeout: 30_000 });
  const videoPoint = async (nx, ny) => {
    const box = await page.evaluate(() => {
      const v = document.getElementById('video');
      const r = v.getBoundingClientRect();
      const scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
      const w = v.videoWidth * scale, h = v.videoHeight * scale;
      return { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, w, h };
    });
    return { x: box.x + nx * box.w, y: box.y + ny * box.h };
  };
  const hostCursor = () => app.evaluate(({ screen }) => screen.getCursorScreenPoint());

  let firstCreds;
  await step('support session: wrong password is refused, then prompts again', async () => {
    firstCreds = await creds();
    await join(firstCreds.code, 'zzzzzzzz');
    await page.waitForSelector('#dlg-password[open]', { timeout: 30_000 });
    assert((await page.textContent('#pw-error')).includes('Wrong password'), 'no wrong-password message');
    assert(!(await page.$('#stage.live')), 'viewer went live with a wrong password');
  });

  await step('support session: correct password connects and video flows', async () => {
    await page.fill('#dlg-password input', firstCreds.pass.toUpperCase());
    await page.click('#dlg-password button[type=submit]');
    await live();
    await page.waitForFunction(() => document.getElementById('video').videoWidth > 0, null, { timeout: 20_000 });
    const size = await page.evaluate(() => { const v = document.getElementById('video'); return [v.videoWidth, v.videoHeight]; });
    console.log(`       remote screen ${size[0]}x${size[1]}`);
    assert(size[0] >= 640, 'video too small');
    const t0 = await page.evaluate(() => document.getElementById('video').getVideoPlaybackQuality().totalVideoFrames);
    await sleep(1500);
    const t1 = await page.evaluate(() => document.getElementById('video').getVideoPlaybackQuality().totalVideoFrames);
    assert(t1 > t0, `no new frames (${t0} -> ${t1})`);
    await panel.waitForSelector('#session:not([hidden])');
    assert((await panel.textContent('#session-viewer')) === EMAIL, 'host does not show who is connected');
    await page.screenshot({ path: path.join(tmp, 'viewer.png') });
  });

  await step('mouse: pointer position reaches the host', async () => {
    for (const [nx, ny] of [[0.25, 0.25], [0.75, 0.6], [0.5, 0.5]]) {
      const p = await videoPoint(nx, ny);
      await page.mouse.move(p.x, p.y);
      await sleep(400);
      const c = await hostCursor();
      const display = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds);
      const ex = nx * display.width, ey = ny * display.height;
      assert(Math.abs(c.x - ex) <= 3 && Math.abs(c.y - ey) <= 3, `cursor at ${c.x},${c.y}, expected ${ex},${ey}`);
    }
  });

  await step('mouse click and keyboard: typing lands in a host text field', async () => {
    // Use the host panel's own "server" field as the typing target.
    const target = await panel.evaluate(() => {
      const r = document.querySelector('#server-form input').getBoundingClientRect();
      return { x: r.left + r.width - 12, y: r.top + r.height / 2 };
    });
    const { bounds, display } = await app.evaluate(({ BrowserWindow, screen }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('panel.html'));
      return { bounds: w.getContentBounds(), display: screen.getPrimaryDisplay().bounds };
    });
    const p = await videoPoint((bounds.x + target.x) / display.width, (bounds.y + target.y) / display.height);
    await page.mouse.click(p.x, p.y);
    await sleep(500);
    await page.keyboard.press('End');
    await page.keyboard.type('/abc-123', { delay: 30 });
    await page.keyboard.down('Shift');
    await page.keyboard.press('KeyZ');
    await page.keyboard.up('Shift');
    await sleep(700);
    const value = await panel.inputValue('#server-form input');
    assert(value === `${URL}/abc-123Z`, `host field contains "${value}"`);
    await panel.fill('#server-form input', URL);
  });

  await step('clipboard: viewer to host and host to viewer', async () => {
    await page.evaluate(() => navigator.clipboard.writeText('from-viewer ✓'));
    await page.click('#v-clip');
    await sleep(600);
    assert((await app.evaluate(({ clipboard }) => clipboard.readText())) === 'from-viewer ✓', 'host clipboard not updated');
    await app.evaluate(({ clipboard }) => clipboard.writeText('from-host ✓'));
    await page.bringToFront();
    await page.waitForFunction(async () => (await navigator.clipboard.readText()) === 'from-host ✓', null, { timeout: 8000 });
  });

  await step('file transfer: viewer to host arrives intact', async () => {
    const src = path.join(tmp, 'payload-file.bin');
    const data = crypto.randomBytes(3 * 1024 * 1024 + 123);
    fs.writeFileSync(src, data);
    await page.setInputFiles('#file-input', src);
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /Saved on the remote|failed|Could not|not available|Another|over 2/.test(t.textContent)), null, { timeout: 30_000 })
      .catch(() => {});
    const toasts = await page.$$eval('.toast', (els) => els.map((t) => t.textContent));
    assert(toasts.some((t) => t.includes('Saved on the remote')), `toasts: ${JSON.stringify(toasts)}`);
    const dl = await app.evaluate(({ app: a }) => a.getPath('downloads'));
    const saved = path.join(dl, 'Shackle', 'payload-file.bin');
    assert(fs.existsSync(saved), 'file not saved on host');
    assert(Buffer.compare(fs.readFileSync(saved), data) === 0, 'saved file differs');
    fs.rmSync(saved);
  });

  await step('quality switch keeps the stream running', async () => {
    await page.selectOption('#v-quality', 'low');
    await sleep(1500);
    const t0 = await page.evaluate(() => document.getElementById('video').getVideoPlaybackQuality().totalVideoFrames);
    await page.mouse.move(300, 300);
    await page.mouse.move(600, 500);
    await sleep(1500);
    const t1 = await page.evaluate(() => document.getElementById('video').getVideoPlaybackQuality().totalVideoFrames);
    assert(t1 > t0, 'stream stalled after quality change');
    assert((await page.textContent('#v-stats')).includes('fps'), 'stats not shown');
  });

  await step('viewer disconnect ends the session and rotates the one-time credentials', async () => {
    await page.click('#v-end');
    await page.waitForSelector('#viewer', { state: 'hidden' });
    await panel.waitForSelector('#session', { state: 'hidden' });
    await panel.waitForFunction((old) => {
      const c = document.getElementById('code').textContent.replace(/\D/g, '');
      const p = document.getElementById('pass').textContent.replace(/\s/g, '');
      return c.length === 9 && c !== old.code && p !== old.pass;
    }, firstCreds);
    await join(firstCreds.code, firstCreds.pass);
    await page.waitForFunction(() => document.getElementById('v-status').textContent.includes('No computer is waiting'));
    await page.click('#v-cancel');
  });

  await step('unattended: enroll this computer from the host panel', async () => {
    await panel.fill('#enroll input[name=name]', 'Test Rig');
    await panel.fill('#enroll input[name=email]', EMAIL);
    await panel.fill('#enroll input[name=password]', 'wrong password!');
    await panel.click('#enroll button');
    await panel.waitForFunction(() => document.getElementById('enroll-msg').textContent.includes('Wrong'));
    await panel.fill('#enroll input[name=password]', PASSWORD);
    await panel.click('#enroll button');
    await panel.waitForSelector('#enrolled:not([hidden])');
    await panel.waitForFunction(() => document.getElementById('status').textContent === 'Ready');
    await page.waitForSelector('.device.online', { timeout: 15_000 });
    assert((await page.textContent('.device-name')) === 'Test Rig', 'device name not shown');
    await page.screenshot({ path: path.join(tmp, 'dashboard.png') });
    await panel.screenshot({ path: path.join(tmp, 'panel.png') });
  });

  await step('unattended: refused until an access password is set', async () => {
    await page.click('.device .btn.primary');
    await page.fill('#dlg-password input', 'whatever-123');
    await page.click('#dlg-password button[type=submit]');
    await page.waitForFunction(() => document.getElementById('v-status').textContent.includes('not set up'));
    await page.click('#v-cancel');
    await page.waitForSelector('#viewer', { state: 'hidden' });
  });

  await step('unattended: connects with the access password, no prompt on the host', async () => {
    await panel.fill('#access input', ACCESS);
    await panel.click('#access button');
    await panel.waitForFunction(() => document.getElementById('pw-state').textContent === 'Set');
    await page.waitForSelector('.device.online .btn.primary:not([disabled])');
    await page.click('.device .btn.primary');
    await page.fill('#dlg-password input', ACCESS);
    await page.click('#dlg-password button[type=submit]');
    await live();
    await page.waitForFunction(() => document.getElementById('video').videoWidth > 0);
    const p = await videoPoint(0.1, 0.9);
    await page.mouse.move(p.x, p.y);
    await sleep(400);
    const c = await hostCursor();
    assert(Math.abs(c.x - 128) <= 3 && Math.abs(c.y - 720) <= 3, `cursor at ${c.x},${c.y}`);
  });

  await step('file transfer: host to viewer download', async () => {
    const src = path.join(tmp, 'from-host.txt');
    fs.writeFileSync(src, 'hello from the host\n'.repeat(5000));
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, src);
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), page.click('#v-pull')]);
    const out = path.join(tmp, 'downloaded.txt');
    await download.saveAs(out);
    assert(download.suggestedFilename() === 'from-host.txt', 'wrong download name');
    assert(Buffer.compare(fs.readFileSync(out), fs.readFileSync(src)) === 0, 'downloaded file differs');
  });

  await step('host can end the session; viewer is told', async () => {
    await panel.click('#end-session');
    await page.waitForFunction(() => document.getElementById('v-status').textContent.includes('ended on the remote computer'));
    await page.click('#v-cancel');
    await page.waitForSelector('#viewer', { state: 'hidden' });
  });

  await step('removing the device on the server unenrolls the host', async () => {
    page.once('dialog', (d) => d.accept());
    await page.click('.device .btn.danger');
    await page.waitForSelector('#no-devices:not([hidden])');
    await panel.waitForSelector('#enroll:not([hidden])', { timeout: 10_000 });
  });

  await step('no script errors in the viewer or the host', async () => {
    const real = consoleErrors.filter((e) => !/favicon|401|403/.test(e));
    assert(real.length === 0, `viewer errors: ${real.join(' | ')}`);
    assert(hostErrors.length === 0, `host errors: ${hostErrors.join(' | ')}`);
  });
} catch (e) {
  if (!results.some(([ok]) => !ok)) console.error(e);
} finally {
  await app?.close().catch(() => {});
  await browser?.close().catch(() => {});
  server?.kill();
  const failed = results.filter(([ok]) => !ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed. Artifacts: ${tmp}`);
  process.exit(failed || results.length === 0 ? 1 : 0);
}
