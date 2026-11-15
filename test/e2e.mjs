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
const { chromium, devices, _electron: electron } = require(pwPath);

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
    env: { ...process.env, PORT: String(PORT), DATA_DIR: path.join(tmp, 'data'), STUN_URLS: '', ANDROID_APP_FINGERPRINTS: `not-a-fingerprint, ${Array(32).fill('ab').join(':')}` },
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

  await step('installable app: manifest, icons, offline page and app link file are served', async () => {
    const m = await (await fetch(`${URL}/manifest.webmanifest`)).json();
    assert(m.start_url === '/connect.html' && m.icons.length === 3, 'bad manifest');
    for (const i of m.icons) assert((await fetch(URL + i.src)).status === 200, `missing ${i.src}`);
    for (const f of ['/sw.js', '/offline.html', '/pwa.js']) assert((await fetch(URL + f)).status === 200, `missing ${f}`);
    const links = await fetch(`${URL}/.well-known/assetlinks.json`);
    assert(links.status === 200 && links.headers.get('content-type').includes('application/json'), 'asset links not served as JSON');
    const body = await links.json();
    assert(body.length === 1 && body[0].target.package_name === 'co.silicode.shackle' && body[0].target.sha256_cert_fingerprints.length === 1, `asset links: ${JSON.stringify(body)}`);
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
    await panel.screenshot({ path: path.join(tmp, 'panel.png') });
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
  const videoPoint = async (nx, ny, pg = page) => {
    const box = await pg.evaluate(() => {
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
    await panel.click('[data-tab=settings]');
    const target = await panel.evaluate(() => {
      const el = document.querySelector('#server-form input');
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
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
    await panel.click('[data-tab=remote]');
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

  await step('phone: a browser without an account must come from the server\'s own page', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?role=guest`);
    const opened = await new Promise((r) => { ws.onopen = () => r(true); ws.onerror = () => r(false); });
    assert(!opened, 'guest socket opened without the server\'s Origin');
  });

  // Phone helpers: real touch sequences through the browser's touch pipeline (CDP), so the page
  // sees genuine pointer events with pointerType "touch", one or two fingers.
  const phoneTools = async (phone, phoneCtx) => {
    const cdp = await phoneCtx.newCDPSession(phone);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, id) => ({ x: p.x, y: p.y, id })) });
    const stageMid = async () => phone.evaluate(() => {
      const r = document.getElementById('stage').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height * 0.45 };
    });
    const tapAt = async (p) => { await touch('touchStart', [p]); await sleep(40); await touch('touchEnd', []); };
    const swipe = async (from, dx, dy, steps, stepMs) => {
      await touch('touchStart', [from]);
      for (let i = 1; i <= steps; i++) {
        await sleep(stepMs);
        await touch('touchMove', [{ x: from.x + (dx * i) / steps, y: from.y + (dy * i) / steps }]);
      }
      await sleep(stepMs);
      await touch('touchEnd', []);
    };
    const twoFinger = async (mid, gap, dx, dy, steps, stepMs, endGap = gap) => {
      const pts = (k) => {
        const g = gap + ((endGap - gap) * k) / steps;
        return [{ x: mid.x - g / 2 + (dx * k) / steps, y: mid.y + (dy * k) / steps }, { x: mid.x + g / 2 + (dx * k) / steps, y: mid.y + (dy * k) / steps }];
      };
      await touch('touchStart', pts(0));
      for (let k = 1; k <= steps; k++) { await sleep(stepMs); await touch('touchMove', pts(k)); }
      await sleep(stepMs);
      await touch('touchEnd', []);
    };
    const picture = () => phone.evaluate(() => {
      const v = document.getElementById('video');
      const r = v.getBoundingClientRect();
      const sc = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
      return { w: v.videoWidth * sc, h: v.videoHeight * sc };
    });
    return { touch, stageMid, tapAt, swipe, twoFinger, picture };
  };

  await step('phone: connects by ID and password; touchpad mode with a visible cursor', async () => {
    const phoneCtx = await browser.newContext({ ...devices['Pixel 7'] });
    const phone = await phoneCtx.newPage();
    phone.on('console', (m) => m.type() === 'error' && consoleErrors.push(`[phone] ${m.text()}`));
    phone.on('pageerror', (e) => consoleErrors.push(`[phone] ${e.message}`));
    try {
      await page.goto(URL); // the desktop viewer stays signed in but idle
      const c = await creds();
      await phone.goto(`${URL}/connect.html`);
      await phone.waitForSelector('#guest:not([hidden])');
      await phone.screenshot({ path: path.join(tmp, 'phone-form.png') });
      await phone.fill('#guest-form input[name=code]', c.code);
      assert((await phone.inputValue('#guest-form input[name=code]')) === c.code.replace(/(\d{3})(?=\d)/g, '$1 '), 'ID not grouped');
      await phone.fill('#guest-form input[name=password]', c.pass);
      await phone.tap('#guest-form button');
      await phone.waitForSelector('#stage.live', { timeout: 30_000 });
      await phone.waitForFunction(() => document.getElementById('video').videoWidth > 0, null, { timeout: 20_000 });
      await panel.waitForSelector('#session:not([hidden])');
      const who = await panel.textContent('#session-viewer');
      assert(who === 'A web browser (no Shackle account)', `host shows "${who}"`);
      assert(await phone.isVisible('.dock'), 'control dock not shown');
      assert(await phone.isHidden('#bar'), 'desktop toolbar shown on the phone');
      await phone.waitForSelector('.tcursor:not([hidden])');

      const T = await phoneTools(phone, phoneCtx);
      const display = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds);
      const hostNorm = async () => { const h = await hostCursor(); return { x: h.x / display.width, y: h.y / display.height }; };
      const near = (a, b, tol = 0.012) => Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
      const overlayNorm = () => phone.evaluate(() => {
        const v = document.getElementById('video');
        const r = v.getBoundingClientRect();
        const sc = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
        const w = v.videoWidth * sc, h = v.videoHeight * sc;
        const px = r.left + (r.width - w) / 2, py = r.top + (r.height - h) / 2;
        const sr = document.getElementById('stage').getBoundingClientRect();
        const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(document.querySelector('.tcursor').style.transform);
        return { x: (sr.left + Number(m[1]) - px) / w, y: (sr.top + Number(m[2]) - py) / h };
      });

      // The session starts with the cursor in the middle of the remote screen.
      await sleep(400);
      assert(near(await hostNorm(), { x: 0.5, y: 0.5 }), `cursor did not start centred: ${JSON.stringify(await hostNorm())}`);

      // Sliding a finger anywhere moves the cursor relative to where it was; drawn cursor and real one agree.
      const mid = await T.stageMid();
      await T.swipe({ x: mid.x - 60, y: mid.y + 40 }, 90, -45, 30, 25);
      await sleep(400);
      const after = await hostNorm();
      assert(after.x > 0.6 && after.y < 0.45, `cursor did not follow the finger: ${JSON.stringify(after)}`);
      assert(near(after, await overlayNorm(), 0.01), 'drawn cursor and remote cursor disagree');

      // Quick flicks travel further than slow strokes over the same distance (pointer acceleration).
      const before = await hostNorm();
      await T.swipe(mid, -60, 0, 30, 25); // slow
      await sleep(300);
      const slow = before.x - (await hostNorm()).x;
      const before2 = await hostNorm();
      await T.swipe(mid, -60, 0, 4, 8); // fast
      await sleep(300);
      const fast = before2.x - (await hostNorm()).x;
      assert(fast > slow * 1.5, `no acceleration: slow ${slow.toFixed(3)}, fast ${fast.toFixed(3)}`);

      // Put the cursor on a harmless spot of the host window and record what arrives there.
      const moveTo = async (target) => {
        const pic = await T.picture();
        for (let i = 0; i < 6; i++) {
          const h = await hostNorm();
          if (near(h, target, 0.004)) return;
          const dx = ((target.x - h.x) * pic.w) / 0.75, dy = ((target.y - h.y) * pic.h) / 0.75;
          const steps = Math.max(2, Math.ceil(Math.hypot(dx, dy) / 2.5));
          await T.swipe(mid, dx, dy, steps, 22);
          await sleep(250);
        }
        assert(near(await hostNorm(), target, 0.006), `could not place the cursor at ${JSON.stringify(target)}: ${JSON.stringify(await hostNorm())}`);
      };
      const spot = async (selector, fx = 0.5) => {
        const r = await panel.evaluate(([sel, f]) => {
          const el = document.querySelector(sel);
          el.scrollIntoView({ block: 'center' });
          const b = el.getBoundingClientRect();
          return { x: b.left + b.width * f, y: b.top + b.height / 2 };
        }, [selector, fx]);
        const bounds = await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('panel.html')).getContentBounds());
        return { x: (bounds.x + r.x) / display.width, y: (bounds.y + r.y) / display.height };
      };
      await panel.evaluate(() => {
        window.__ev = [];
        const log = (e) => window.__ev.push(e.type === 'wheel' ? ['wheel', Math.sign(e.deltaY)] : [e.type, e.button ?? null]);
        for (const t of ['mousedown', 'click', 'dblclick', 'contextmenu']) window.addEventListener(t, log, true);
        window.addEventListener('wheel', log, { capture: true, passive: true });
      });
      const events = () => panel.evaluate(() => window.__ev.splice(0));
      await moveTo(await spot('#session-viewer', 0.25));
      await events();

      await T.tapAt(mid);
      await sleep(500);
      let ev = await events();
      assert(ev.some(([t, b]) => t === 'click' && b === 0), `tap did not click: ${JSON.stringify(ev)}`);
      assert(near(await hostNorm(), await spot('#session-viewer', 0.25), 0.006), 'tap moved the cursor');

      await T.tapAt(mid); await sleep(90); await T.tapAt(mid);
      await sleep(500);
      ev = await events();
      assert(ev.some(([t]) => t === 'dblclick'), `double tap did not double-click: ${JSON.stringify(ev)}`);
      await sleep(400);

      await T.twoFinger(mid, 70, 0, 0, 2, 30);
      await sleep(500);
      ev = await events();
      assert(ev.some(([t, b]) => t === 'contextmenu' || (t === 'mousedown' && b === 2)), `two-finger tap did not right-click: ${JSON.stringify(ev)}`);
      await panel.keyboard.press('Escape').catch(() => {});

      await T.twoFinger(mid, 70, 0, -120, 12, 25); // fingers slide up: content scrolls down
      await sleep(900);
      ev = await events();
      const wheels = ev.filter(([t]) => t === 'wheel');
      assert(wheels.length > 0 && wheels.every(([, d]) => d > 0), `two-finger scroll: ${JSON.stringify(ev)}`);
      assert(near(await hostNorm(), await spot('#session-viewer', 0.25), 0.006), 'scrolling moved the cursor');

      await phone.screenshot({ path: path.join(tmp, 'phone-viewer.png') });

      // Typing: click into a host text field, open the keyboard, type, Backspace, and Ctrl+A from the key strip.
      await panel.click('[data-tab=settings]');
      await moveTo(await spot('#server-form input', 0.92));
      await T.tapAt(mid);
      await sleep(400);
      await phone.tap('.dock-kbd');
      assert(await phone.evaluate(() => document.activeElement.id === 'kbd'), 'keyboard box not focused');
      assert(await phone.isVisible('.keystrip'), 'special-key strip not shown while typing');
      await phone.screenshot({ path: path.join(tmp, 'phone-typing.png') });
      await phone.keyboard.press('End');
      await phone.keyboard.insertText('/phone x');
      await phone.keyboard.press('Backspace');
      await phone.keyboard.press('Backspace');
      await phone.keyboard.insertText('-ok');
      await sleep(900);
      let value = await panel.inputValue('#server-form input');
      assert(value === `${URL}/phone-ok`, `host field contains "${value}"`);
      await phone.tap('.keystrip button:has-text("Ctrl")');
      assert(await phone.evaluate(() => document.activeElement.id === 'kbd'), 'key strip took the focus (keyboard would close)');
      await phone.keyboard.insertText('a');
      await phone.keyboard.insertText('replaced');
      await sleep(900);
      value = await panel.inputValue('#server-form input');
      assert(value === 'replaced', `Ctrl+A then typing gave "${value}"`);
      assert(!(await phone.$('.keystrip button.on')), 'Ctrl stayed held after one key');
      await panel.fill('#server-form input', URL);
      await panel.click('[data-tab=remote]');
      await phone.tap('.dock-kbd');
      await sleep(200);

      // Pinch zooms the picture; moving the cursor towards an edge slides the zoomed view along.
      const m2 = await T.stageMid();
      await T.twoFinger(m2, 60, 0, 0, 10, 25, 200);
      const scale = await phone.evaluate(() => Number((/scale\(([\d.]+)\)/.exec(document.getElementById('video').style.transform) || [0, 1])[1]));
      assert(scale > 2, `pinch did not zoom (scale ${scale})`);
      assert(await phone.isVisible('.dock-fit'), 'fit button not offered while zoomed');
      const tx0 = await phone.evaluate(() => document.getElementById('video').style.transform);
      await T.swipe(m2, 160, 0, 40, 20);
      await sleep(300);
      const tx1 = await phone.evaluate(() => document.getElementById('video').style.transform);
      assert(tx0 !== tx1, 'zoomed view did not follow the cursor');
      const o = await phone.evaluate(() => {
        const c = document.querySelector('.tcursor').getBoundingClientRect();
        const s = document.getElementById('stage').getBoundingClientRect();
        return c.left > s.left && c.left < s.right;
      });
      assert(o, 'cursor left the visible area while zoomed');
      await phone.screenshot({ path: path.join(tmp, 'phone-zoomed.png') });
      await phone.tap('.dock-fit');
      assert(await phone.evaluate(() => document.getElementById('video').style.transform === ''), 'fit did not reset the zoom');

      // Touch mode: tap exactly where to click.
      await phone.tap('.dock-mode');
      assert(await phone.isHidden('.tcursor'), 'cursor still drawn in touch mode');
      const target = { x: 0.3, y: 0.4 };
      const vp = await videoPoint(target.x, target.y, phone);
      await T.tapAt(vp);
      await sleep(500);
      assert(near(await hostNorm(), target, 0.01), `touch-mode tap landed at ${JSON.stringify(await hostNorm())}`);
      await phone.tap('.dock-mode'); // back to touchpad, remembered for next time

      // The menu holds the rest; Disconnect returns to the form.
      await phone.tap('.dock-menu');
      await phone.waitForSelector('#v-end', { state: 'visible' });
      await phone.screenshot({ path: path.join(tmp, 'phone-menu.png') });
      await phone.tap('#v-end');
      await phone.waitForSelector('#guest:not([hidden])');
      await panel.waitForSelector('#session', { state: 'hidden' });
      assert(!(await phone.$('.dock')), 'dock left behind after the session');
    } finally {
      await phoneCtx.close();
    }
  });

  await step('phone: landscape layout puts the controls at the side', async () => {
    const phoneCtx = await browser.newContext({ ...devices['Pixel 7 landscape'] });
    const phone = await phoneCtx.newPage();
    phone.on('pageerror', (e) => consoleErrors.push(`[phone-landscape] ${e.message}`));
    try {
      await sleep(1500); // the one-time ID and password rotate after the previous session
      const c = await creds();
      await phone.goto(`${URL}/connect.html`);
      await phone.fill('#guest-form input[name=code]', c.code);
      await phone.fill('#guest-form input[name=password]', c.pass);
      await phone.tap('#guest-form button');
      await phone.waitForSelector('#stage.live', { timeout: 30_000 });
      await phone.waitForFunction(() => document.getElementById('video').videoWidth > 0, null, { timeout: 20_000 });
      await sleep(600);
      const layout = await phone.evaluate(() => {
        const d = document.querySelector('.dock').getBoundingClientRect();
        return { vertical: d.height > d.width, right: innerWidth - d.right, fits: d.top >= 0 && d.bottom <= innerHeight };
      });
      assert(layout.vertical && layout.right < 40 && layout.fits, `landscape dock: ${JSON.stringify(layout)}`);
      await phone.screenshot({ path: path.join(tmp, 'phone-landscape.png') });
      await phone.tap('.dock-menu');
      await phone.screenshot({ path: path.join(tmp, 'phone-landscape-menu.png') });
      const fits = await phone.evaluate(() => {
        const bar = document.getElementById('bar');
        const b = bar.getBoundingClientRect();
        return b.top >= 0 && b.bottom <= innerHeight + 1 && bar.scrollHeight <= bar.clientHeight + 1;
      });
      assert(fits, 'menu does not fit on a landscape screen without scrolling');

      // Android Back: first closes the menu, then asks again before disconnecting.
      await phone.goBack({ waitUntil: 'commit' }).catch(() => {});
      await sleep(300);
      assert(!(await phone.evaluate(() => document.getElementById('viewer').classList.contains('menu-open'))), 'Back did not close the menu');
      // (Chrome's Back skips history entries the page added with no touch since, so touch as a user would.)
      await phone.tap('.dock', { position: { x: 30, y: 2 } });
      await sleep(400);
      await phone.goBack({ waitUntil: 'commit' }).catch(() => {});
      await sleep(500);
      assert(await phone.isVisible('#stage.live'), 'one Back press dropped the session');
      assert((await phone.textContent('#toasts')).includes('Press Back again'), 'no warning before disconnecting');
      await phone.goBack({ waitUntil: 'commit' }).catch(() => {});
      await panel.waitForSelector('#session', { state: 'hidden' });
    } finally {
      await phoneCtx.close();
    }
  });

  await step('unattended: enroll this computer from the host panel', async () => {
    await panel.click('[data-tab=unattended]');
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

  await step('hardening: account and password settings are locked while someone is connected', async () => {
    await panel.fill('#access input', 'attacker-sets-this-1');
    await panel.click('#access button');
    await panel.waitForFunction(() => document.getElementById('access-msg').textContent.includes('End the session first'));
    const r = await panel.evaluate(() => window.shackle.action('setServer', { url: 'https://evil.example' }));
    assert(r.ok === false, 'server address could be changed during a session');
    const r2 = await panel.evaluate(() => window.shackle.action('connectTo', { code: '123456789' }));
    assert(r2.ok === false, 'outgoing connection allowed during a session');
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

  await step('app to app: one Shackle app controls another by ID and password, no account', async () => {
    const app2 = await electron.launch({
      executablePath: require(path.join(root, 'host', 'node_modules', 'electron')),
      args: ['.', '--no-sandbox'],
      cwd: path.join(root, 'host'),
      env: {
        ...process.env, SHACKLE_SERVER_URL: URL, SHACKLE_USER_DATA: path.join(tmp, 'host2'),
        SHACKLE_TEST_FILE: path.join(tmp, 'state2.json'), NODE_OPTIONS: '',
      },
    });
    try {
      let panel2 = null;
      for (let i = 0; i < 100 && !panel2; i++) {
        panel2 = app2.windows().find((w) => w.url().endsWith('panel.html')) || null;
        if (!panel2) await sleep(100);
      }
      assert(panel2, 'second app did not open');
      await panel2.waitForFunction(() => document.getElementById('status').textContent === 'Ready');
      const own = (await panel2.textContent('#code')).replace(/\D/g, '');
      await panel2.fill('#connect-form input', own);
      await panel2.click('#connect-form button');
      await panel2.waitForFunction(() => document.getElementById('connect-msg').textContent.includes('own ID'));

      const c = await creds();
      assert(c.code !== own, 'both apps got the same ID');
      await panel2.fill('#connect-form input', c.code);
      const [win] = await Promise.all([app2.waitForEvent('window'), panel2.click('#connect-form button')]);
      win.on('pageerror', (e) => hostErrors.push(e.message));
      await win.waitForSelector('#dlg-password[open]', { timeout: 30_000 });
      await win.fill('#dlg-password input', c.pass);
      await win.click('#dlg-password button[type=submit]');
      await win.waitForSelector('#stage.live', { timeout: 30_000 });
      await win.waitForFunction(() => document.getElementById('video').videoWidth > 0, null, { timeout: 20_000 });
      await panel.waitForSelector('#session:not([hidden])');
      const who = await panel.textContent('#session-viewer');
      assert(who.includes(`ID ${own.replace(/(\d{3})(?=\d)/g, '$1 ')}`), `host shows "${who}"`);
      // Both apps share one test screen: keep the viewer window away from where the pointer will land,
      // otherwise the real pointer re-enters the viewer and feeds back.
      await app2.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('connect.html'));
        w.setBounds({ x: 0, y: 300, width: 900, height: 480 });
      });
      await sleep(500);
      const p = await videoPoint(0.9, 0.1, win);
      await win.mouse.move(p.x, p.y);
      await sleep(500);
      const cur = await hostCursor();
      assert(Math.abs(cur.x - 1152) <= 3 && Math.abs(cur.y - 80) <= 3, `cursor at ${cur.x},${cur.y}`);
      await win.screenshot({ path: path.join(tmp, 'app-viewer.png') });
      await panel2.screenshot({ path: path.join(tmp, 'panel2.png') });
      await Promise.all([win.waitForEvent('close'), win.click('#v-end')]);
      await panel.waitForSelector('#session', { state: 'hidden' });
    } finally {
      await app2.close().catch(() => {});
    }
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
