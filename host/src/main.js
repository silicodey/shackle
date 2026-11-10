// Tether host: main process.
// - "engine" window (hidden): signaling socket, WebRTC peer, screen capture.
// - "panel" window: the visible control panel.
// - this process: config, tray, consent prompts, input injection, clipboard, file I/O.
const {
  app, BrowserWindow, Tray, Menu, ipcMain, desktopCapturer, screen, dialog, clipboard, nativeImage,
  safeStorage, powerSaveBlocker, systemPreferences, shell, Notification,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const input = require('./input');

const IS_TEST = !app.isPackaged && !!process.env.TETHER_TEST_FILE;
if (!app.isPackaged && process.env.TETHER_USER_DATA) app.setPath('userData', process.env.TETHER_USER_DATA);

const PBKDF2_ITERATIONS = 200_000; // must match renderer/proto.js
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* config                                                              */
/* ------------------------------------------------------------------ */
let defaults = {};
try {
  defaults = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tether.config.json'), 'utf8'));
} catch {}

const configFile = () => path.join(app.getPath('userData'), 'config.json');
let cfg = { serverUrl: '', deviceName: os.hostname(), device: null, unattended: null, startAtLogin: false, keepAwake: false };

function protect(value) {
  if (safeStorage.isEncryptionAvailable()) return { enc: safeStorage.encryptString(value).toString('base64') };
  return { plain: value };
}
function reveal(box) {
  if (!box) return null;
  try {
    if (box.enc) return safeStorage.decryptString(Buffer.from(box.enc, 'base64'));
    return box.plain ?? null;
  } catch {
    return null;
  }
}

function loadConfig() {
  try {
    cfg = { ...cfg, ...JSON.parse(fs.readFileSync(configFile(), 'utf8')) };
  } catch {}
  if (!cfg.serverUrl) cfg.serverUrl = process.env.TETHER_SERVER_URL || defaults.defaultServerUrl || '';
}
function saveConfig() {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  const tmp = `${configFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, configFile());
}

function normalizeServerUrl(raw) {
  let s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Use an http(s) address');
  return u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, ''));
}

/* ------------------------------------------------------------------ */
/* state shared with the panel                                         */
/* ------------------------------------------------------------------ */
const state = { connection: 'offline', code: null, supportPassword: null, session: null, error: null };
let engineWin = null;
let panelWin = null;
let indicatorWin = null;
let tray = null;
let quitting = false;
let awakeId = null;

function permissions() {
  if (process.platform !== 'darwin') return { screen: true, accessibility: true };
  return {
    screen: systemPreferences.getMediaAccessStatus('screen') === 'granted',
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
  };
}

function fullState() {
  return {
    ...state,
    version: app.getVersion(),
    platform: process.platform,
    serverUrl: cfg.serverUrl,
    deviceName: cfg.deviceName,
    device: cfg.device ? { id: cfg.device.id, account: cfg.device.account } : null,
    unattendedSet: !!cfg.unattended,
    startAtLogin: cfg.startAtLogin,
    keepAwake: cfg.keepAwake,
    inputAvailable: input.available(),
    permissions: permissions(),
  };
}

function broadcast() {
  const s = fullState();
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('panel:state', s);
  updateTray();
  if (IS_TEST) {
    try { fs.writeFileSync(process.env.TETHER_TEST_FILE, JSON.stringify(s)); } catch {}
  }
}

/* ------------------------------------------------------------------ */
/* windows                                                             */
/* ------------------------------------------------------------------ */
const asset = (name) => path.join(__dirname, '..', 'assets', name);
const page = (name) => path.join(__dirname, 'renderer', name);
const webPreferences = (preload) => ({
  preload: path.join(__dirname, preload),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  backgroundThrottling: false,
});

function lockDown(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function createEngine() {
  engineWin = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: webPreferences('preload-engine.js') });
  lockDown(engineWin);
  engineWin.loadFile(page('engine.html'));
  engineWin.webContents.on('render-process-gone', () => {
    onSessionChange(null);
    if (!quitting) setTimeout(() => engineWin && !engineWin.isDestroyed() && engineWin.reload(), 1000);
  });
  if (process.env.TETHER_DEBUG) engineWin.webContents.on('console-message', (e) => console.log('[engine]', e.message));
}

function showPanel() {
  if (panelWin && !panelWin.isDestroyed()) {
    if (panelWin.isMinimized()) panelWin.restore();
    panelWin.show();
    panelWin.focus();
    return;
  }
  panelWin = new BrowserWindow({
    width: 440, height: 720, minWidth: 400, minHeight: 560,
    title: 'Tether', backgroundColor: '#0a0c0f', autoHideMenuBar: true, show: false,
    icon: process.platform === 'linux' ? asset('icon.png') : undefined,
    webPreferences: webPreferences('preload-panel.js'),
  });
  lockDown(panelWin);
  panelWin.setMenuBarVisibility(false);
  panelWin.loadFile(page('panel.html'));
  panelWin.once('ready-to-show', () => panelWin.show());
  panelWin.on('close', (e) => {
    // Keep running in the tray so unattended access stays available.
    if (!quitting) {
      e.preventDefault();
      panelWin.hide();
    }
  });
}

function showIndicator(session) {
  hideIndicator();
  const area = screen.getPrimaryDisplay().workArea;
  const w = 380, h = 60;
  indicatorWin = new BrowserWindow({
    width: w, height: h, x: area.x + area.width - w - 16, y: area.y + area.height - h - 16,
    frame: false, resizable: false, movable: true, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, focusable: false, show: false, backgroundColor: '#12151a',
    webPreferences: webPreferences('preload-panel.js'),
  });
  lockDown(indicatorWin);
  indicatorWin.setAlwaysOnTop(true, 'screen-saver');
  indicatorWin.setVisibleOnAllWorkspaces(true);
  indicatorWin.loadFile(page('indicator.html'), { query: { viewer: session.viewer } });
  indicatorWin.once('ready-to-show', () => indicatorWin && indicatorWin.showInactive());
}
function hideIndicator() {
  if (indicatorWin && !indicatorWin.isDestroyed()) indicatorWin.destroy();
  indicatorWin = null;
}

function updateTray() {
  if (!tray) return;
  const status = state.session
    ? `In session with ${state.session.viewer}`
    : state.connection === 'online' ? 'Ready' : state.connection === 'connecting' ? 'Connecting…' : 'Offline';
  tray.setToolTip(`Tether: ${status}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: status, enabled: false },
    { type: 'separator' },
    { label: 'Open Tether', click: showPanel },
    { label: 'End session', visible: !!state.session, click: () => engineWin?.webContents.send('engine:end-session') },
    { type: 'separator' },
    { label: 'Quit Tether', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(asset(process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
    if (process.platform === 'darwin') img.setTemplateImage(true);
    tray = new Tray(img);
    tray.on('click', showPanel);
    updateTray();
  } catch (e) {
    console.error('[tether] tray unavailable:', e.message);
  }
}

/* ------------------------------------------------------------------ */
/* options                                                             */
/* ------------------------------------------------------------------ */
function applyOptions() {
  if (app.isPackaged && process.platform !== 'linux') {
    app.setLoginItemSettings({ openAtLogin: !!cfg.startAtLogin, args: ['--hidden'] });
  }
  if (cfg.keepAwake && awakeId === null) awakeId = powerSaveBlocker.start('prevent-app-suspension');
  if (!cfg.keepAwake && awakeId !== null) {
    powerSaveBlocker.stop(awakeId);
    awakeId = null;
  }
}

/* ------------------------------------------------------------------ */
/* session side effects                                                */
/* ------------------------------------------------------------------ */
let clipTimer = null;
let lastClip = '';

function onSessionChange(session) {
  const was = state.session;
  state.session = session;
  if (session && !was) {
    showIndicator(session);
    lastClip = clipboard.readText();
    clipTimer = setInterval(() => {
      const text = clipboard.readText();
      if (text && text !== lastClip && text.length <= 100_000) {
        lastClip = text;
        engineWin?.webContents.send('engine:clipboard', text);
      }
    }, 1000);
    if (Notification.isSupported()) {
      new Notification({ title: 'Tether', body: `${session.viewer} is now connected to this computer.` }).show();
    }
  }
  if (!session && was) {
    hideIndicator();
    clearInterval(clipTimer);
    input.releaseAll();
    closeAllFiles();
  }
  broadcast();
}

/* ------------------------------------------------------------------ */
/* incoming files (viewer → this computer)                             */
/* ------------------------------------------------------------------ */
const incoming = new Map();
let fileChain = Promise.resolve();

function safeFileName(name) {
  const base = path.basename(String(name || 'file')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '_').slice(0, 180);
  return base || 'file';
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
  return candidate;
}

function fileResult(id, ok, extra) {
  engineWin?.webContents.send('engine:file-result', { id, ok, ...extra });
}

async function fileOp(msg) {
  if (!state.session) return;
  if (msg.op === 'start') {
    const size = Number(msg.size);
    if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_BYTES) return fileResult(msg.id, false, { error: 'file too large' });
    const dir = path.join(app.getPath('downloads'), 'Tether');
    await fs.promises.mkdir(dir, { recursive: true });
    const target = uniquePath(dir, safeFileName(msg.name));
    const handle = await fs.promises.open(target, 'wx');
    incoming.set(msg.id, { handle, target, size, got: 0 });
  } else if (msg.op === 'chunk') {
    const f = incoming.get(msg.id);
    if (!f) return;
    const buf = Buffer.from(msg.data);
    f.got += buf.length;
    if (f.got > f.size) {
      await abortFile(msg.id);
      return fileResult(msg.id, false, { error: 'more data than announced' });
    }
    await f.handle.write(buf);
  } else if (msg.op === 'end') {
    const f = incoming.get(msg.id);
    if (!f) return;
    incoming.delete(msg.id);
    await f.handle.close();
    if (f.got !== f.size) {
      await fs.promises.rm(f.target, { force: true });
      return fileResult(msg.id, false, { error: 'incomplete transfer' });
    }
    fileResult(msg.id, true, { savedAs: path.join('Downloads', 'Tether', path.basename(f.target)) });
  }
}

async function abortFile(id) {
  const f = incoming.get(id);
  if (!f) return;
  incoming.delete(id);
  await f.handle.close().catch(() => {});
  await fs.promises.rm(f.target, { force: true }).catch(() => {});
}

const outgoing = new Map();
function closeAllFiles() {
  fileChain = fileChain.then(async () => {
    for (const id of [...incoming.keys()]) await abortFile(id);
    for (const [id, f] of outgoing) {
      await f.handle.close().catch(() => {});
      outgoing.delete(id);
    }
  });
}

/* ------------------------------------------------------------------ */
/* IPC: engine                                                         */
/* ------------------------------------------------------------------ */
const fromEngine = (e) => engineWin && e.sender === engineWin.webContents;

ipcMain.handle('engine:config', (e) => {
  if (!fromEngine(e)) return null;
  const token = reveal(cfg.device?.token);
  const key = reveal(cfg.unattended?.key);
  return {
    serverUrl: cfg.serverUrl,
    name: cfg.deviceName,
    platform: process.platform,
    version: app.getVersion(),
    device: cfg.device && token ? { id: cfg.device.id, token } : null,
    unattended: cfg.unattended && key ? { salt: cfg.unattended.salt, iter: cfg.unattended.iter, key } : null,
  };
});

ipcMain.handle('engine:screens', async (e) => {
  if (!fromEngine(e)) return [];
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => {
    const src = sources.find((s) => s.display_id && s.display_id === String(d.id)) || sources[i] || sources[0];
    return {
      id: String(d.id),
      sourceId: src ? src.id : null,
      label: d.label || `Display ${i + 1}`,
      width: Math.round(d.size.width * d.scaleFactor),
      height: Math.round(d.size.height * d.scaleFactor),
      primary: d.id === primary,
    };
  }).filter((d) => d.sourceId);
});

ipcMain.on('engine:state', (e, patch) => {
  if (!fromEngine(e) || !patch || typeof patch !== 'object') return;
  for (const k of ['connection', 'code', 'supportPassword', 'error']) if (k in patch) state[k] = patch[k];
  broadcast();
});

ipcMain.handle('engine:confirm', async (e, viewer) => {
  if (!fromEngine(e)) return false;
  if (IS_TEST && process.env.TETHER_TEST_AUTO_ACCEPT === '1') return true;
  app.focus({ steal: true });
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: 'Tether',
    message: `Allow ${String(viewer).slice(0, 120)} to see and control this computer?`,
    detail: 'Only allow this if you know this person and are expecting their help. You can end the session at any time.',
    buttons: ['Allow', 'Decline'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    signal: AbortSignal.timeout(60_000),
  }).catch(() => ({ response: 1 }));
  return response === 0;
});

ipcMain.on('engine:session', (e, session) => {
  if (!fromEngine(e)) return;
  onSessionChange(session ? { viewer: String(session.viewer).slice(0, 120), kind: session.kind, since: Date.now() } : null);
});

ipcMain.on('engine:input', (e, ev, displayId) => {
  if (!fromEngine(e) || !state.session) return;
  input.handle(ev, displayId);
});

ipcMain.on('engine:clipboard-write', (e, text) => {
  if (!fromEngine(e) || !state.session || typeof text !== 'string' || text.length > 100_000) return;
  lastClip = text;
  clipboard.writeText(text);
});

ipcMain.on('engine:file', (e, msg) => {
  if (!fromEngine(e) || !msg) return;
  if (process.env.TETHER_DEBUG && msg.op !== 'chunk') console.log('[file]', msg.op, msg.id, msg.name || '', msg.size ?? '');
  fileChain = fileChain.then(() => fileOp(msg)).catch(async (err) => {
    await abortFile(msg.id);
    fileResult(msg.id, false, { error: err.message });
  });
});

ipcMain.handle('engine:pull-pick', async (e) => {
  if (!fromEngine(e) || !state.session) return { ok: false, error: 'no session' };
  app.focus({ steal: true });
  const res = await dialog.showOpenDialog({ title: 'Choose a file to send', properties: ['openFile'] });
  if (res.canceled || !res.filePaths[0]) return { ok: false, error: 'cancelled' };
  const file = res.filePaths[0];
  const handle = await fs.promises.open(file, 'r');
  const { size } = await handle.stat();
  if (size > MAX_FILE_BYTES) {
    await handle.close();
    return { ok: false, error: 'file is larger than 2 GB' };
  }
  const id = crypto.randomUUID();
  outgoing.set(id, { handle, size });
  return { ok: true, id, name: path.basename(file), size };
});

ipcMain.handle('engine:pull-read', async (e, id, offset, length) => {
  const f = outgoing.get(id);
  if (!fromEngine(e) || !f) return null;
  const buf = Buffer.alloc(Math.min(Number(length) || 0, 64 * 1024));
  const { bytesRead } = await f.handle.read(buf, 0, buf.length, Number(offset) || 0);
  return buf.subarray(0, bytesRead);
});

ipcMain.on('engine:pull-close', async (e, id) => {
  const f = outgoing.get(id);
  if (!fromEngine(e) || !f) return;
  outgoing.delete(id);
  await f.handle.close().catch(() => {});
});

ipcMain.handle('engine:clear-device', (e) => {
  if (!fromEngine(e)) return;
  cfg.device = null;
  saveConfig();
  broadcast();
});

/* ------------------------------------------------------------------ */
/* IPC: panel                                                          */
/* ------------------------------------------------------------------ */
const fromPanel = (e) =>
  (panelWin && e.sender === panelWin.webContents) || (indicatorWin && e.sender === indicatorWin.webContents);

const ENROLL_ERRORS = {
  invalid_credentials: 'Wrong email or password.',
  totp_required: 'Enter the 6-digit code from your authenticator app.',
  invalid_totp: 'That authenticator code is not right.',
  too_many_attempts: 'Too many attempts. Wait a few minutes and try again.',
};

const actions = {
  async setServer({ url }) {
    const next = normalizeServerUrl(url);
    if (next === cfg.serverUrl) return;
    cfg.serverUrl = next;
    cfg.device = null; // a device identity belongs to one server
    saveConfig();
    engineWin?.webContents.reload();
  },
  async enroll({ email, password, totp, name }) {
    if (!cfg.serverUrl) throw new Error('Set the server address first.');
    const deviceName = String(name || '').trim().slice(0, 64) || os.hostname();
    let res;
    try {
      res = await fetch(`${cfg.serverUrl}/api/enroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, totp: totp || undefined, name: deviceName, platform: process.platform }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error('Could not reach the server. Check the address and your connection.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(ENROLL_ERRORS[data.error] || 'The server refused the request.'), { code: data.error });
    cfg.deviceName = deviceName;
    cfg.device = { id: data.deviceId, token: protect(data.deviceToken), account: data.account };
    saveConfig();
    engineWin?.webContents.reload();
  },
  async unenroll() {
    cfg.device = null;
    cfg.unattended = null;
    saveConfig();
    engineWin?.webContents.reload();
  },
  async setAccessPassword({ password }) {
    if (typeof password !== 'string' || password.length < 10) throw new Error('Use at least 10 characters.');
    const salt = crypto.randomBytes(16);
    const key = await new Promise((resolve, reject) =>
      crypto.pbkdf2(password, salt, PBKDF2_ITERATIONS, 32, 'sha256', (err, k) => (err ? reject(err) : resolve(k))));
    cfg.unattended = { salt: salt.toString('base64'), iter: PBKDF2_ITERATIONS, key: protect(key.toString('base64')) };
    saveConfig();
    engineWin?.webContents.send('engine:config-refresh');
  },
  async clearAccessPassword() {
    cfg.unattended = null;
    saveConfig();
    engineWin?.webContents.send('engine:config-refresh');
  },
  async setOption({ key, value }) {
    if (!['startAtLogin', 'keepAwake'].includes(key)) return;
    cfg[key] = !!value;
    saveConfig();
    applyOptions();
  },
  async newCode() {
    engineWin?.webContents.send('engine:new-code');
  },
  async endSession() {
    engineWin?.webContents.send('engine:end-session');
  },
  async copy({ text }) {
    clipboard.writeText(String(text || ''));
  },
  async openPermission({ which }) {
    if (process.platform !== 'darwin') return;
    if (which === 'accessibility') systemPreferences.isTrustedAccessibilityClient(true);
    const pane = which === 'screen' ? 'Privacy_ScreenCapture' : 'Privacy_Accessibility';
    await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
  },
};

ipcMain.handle('panel:state', (e) => (fromPanel(e) ? fullState() : null));
ipcMain.handle('panel:action', async (e, name, payload) => {
  if (!fromPanel(e) || !Object.hasOwn(actions, name)) return { ok: false, error: 'Not allowed.' };
  try {
    await actions[name](payload || {});
    broadcast();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  }
});

/* ------------------------------------------------------------------ */
/* app lifecycle                                                       */
/* ------------------------------------------------------------------ */
app.on('second-instance', showPanel);
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  quitting = true;
  input.releaseAll();
});
app.on('activate', showPanel);

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.silicode.tether');
  loadConfig();
  applyOptions();
  createTray();
  createEngine();
  const hidden = process.argv.includes('--hidden') || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
  if (!hidden) showPanel();
  // Permission status can change while we run (macOS System Settings).
  let lastPerms = JSON.stringify(permissions());
  setInterval(() => {
    const p = JSON.stringify(permissions());
    if (p !== lastPerms) {
      lastPerms = p;
      broadcast();
    }
  }, 3000);
});
