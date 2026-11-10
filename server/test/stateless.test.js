import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8123;
const env = { OWNER_EMAIL: 'owner@example.com', OWNER_PASSWORD: 'a long password', SECRET_KEY: 'k'.repeat(40) };

async function boot(extra = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'shackle-st-'));
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    cwd: dir, env: { ...process.env, PORT: String(PORT), DATA_DIR: data, ...env, ...extra }, stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) return p; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  p.kill();
  throw new Error('server did not start');
}
const stop = (p) => new Promise((r) => { p.on('exit', r); p.kill(); });

function hello(deviceId, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?role=host`);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', name: 'x', platform: 'win32', deviceId, token }));
    ws.onmessage = (e) => { resolve(JSON.parse(e.data)); ws.close(); };
    ws.onerror = reject;
  });
}

test('owner comes from the environment and devices survive a database wipe', async () => {
  let p = await boot();
  let state = await (await fetch(`http://127.0.0.1:${PORT}/api/state`)).json();
  assert.equal(state.needsSetup, false);
  const res = await fetch(`http://127.0.0.1:${PORT}/api/enroll`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: env.OWNER_EMAIL, password: env.OWNER_PASSWORD, name: 'Office PC', platform: 'win32' }),
  });
  assert.equal(res.status, 200);
  const { deviceId, deviceToken } = await res.json();
  assert.equal((await hello(deviceId, deviceToken)).deviceOk, true);
  await stop(p);

  p = await boot(); // brand-new empty database
  const again = await hello(deviceId, deviceToken);
  assert.equal(again.deviceOk, true);
  assert.equal(again.name, 'Office PC');
  const forged = deviceToken.slice(0, -3) + 'AAA';
  assert.equal((await hello(deviceId, forged)).deviceOk, false);
  await stop(p);

  p = await boot({ SECRET_KEY: 'a-different-key-entirely-0000000000000000' });
  assert.equal((await hello(deviceId, deviceToken)).deviceOk, false);
  await stop(p);
});
