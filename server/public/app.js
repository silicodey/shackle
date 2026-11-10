// Dashboard: sign-in, device list, support-session join, account settings.
import { openSession } from './viewer.js';
import { formatCode } from './proto.js';

const $ = (id) => document.getElementById(id);

const MESSAGES = {
  invalid_credentials: 'Wrong email or password.',
  invalid_totp: 'That authenticator code is not right.',
  totp_required: 'Enter the code from your authenticator app.',
  too_many_attempts: 'Too many attempts. Wait a few minutes and try again.',
  invalid_setup_code: 'That setup code is not right. It is printed in the server log.',
  invalid_email: 'Enter a valid email address.',
  weak_password: 'Use a password of at least 10 characters.',
  not_signed_in: 'Your session expired. Sign in again.',
  bad_origin: 'This page was opened from an unexpected address. Check PUBLIC_URL on the server.',
};
const say = (code) => MESSAGES[code] || 'Something went wrong. Try again.';

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && data.error === 'not_signed_in' && state.user) location.reload();
    throw Object.assign(new Error(data.error || 'server_error'), { code: data.error || 'server_error' });
  }
  return data;
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  el.append(...children.filter((c) => c != null));
  return el;
}

const state = { user: null, needsSetup: false, devices: [], inSession: false };

/* ───────────── auth ───────────── */
async function boot() {
  const s = await api('GET', '/api/state');
  state.user = s.user;
  state.needsSetup = s.needsSetup;
  if (s.user) return showApp();
  $('app').hidden = true;
  $('auth').hidden = false;
  if (s.needsSetup) {
    $('auth-title').textContent = 'Create the owner account';
    $('auth-sub').textContent = 'First run. This account controls every computer you add.';
    $('f-code').hidden = false;
    $('auth-submit').textContent = 'Create account';
    $('auth-form').elements.password.autocomplete = 'new-password';
  }
  $('auth-form').elements[s.needsSetup ? 'code' : 'email'].focus();
}

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const btn = $('auth-submit');
  $('auth-error').textContent = '';
  btn.disabled = true;
  try {
    if (state.needsSetup) {
      await api('POST', '/api/setup', { code: f.code.value, email: f.email.value, password: f.password.value });
    } else {
      await api('POST', '/api/login', { email: f.email.value, password: f.password.value, totp: f.totp.value || undefined });
    }
    location.reload();
  } catch (err) {
    if (err.code === 'totp_required') {
      $('f-totp').hidden = false;
      f.totp.focus();
    }
    $('auth-error').textContent = say(err.code);
  } finally {
    btn.disabled = false;
  }
});

/* ───────────── dashboard ───────────── */
function showApp() {
  $('auth').hidden = true;
  $('app').hidden = false;
  $('me').textContent = state.user.email;
  refresh();
  setInterval(() => !state.inSession && !document.hidden && refresh(), 5000);
  document.addEventListener('visibilitychange', () => !document.hidden && !state.inSession && refresh());
}

async function refresh() {
  try {
    const [{ devices }, { events }] = await Promise.all([api('GET', '/api/devices'), api('GET', '/api/audit')]);
    state.devices = devices;
    renderDevices();
    renderActivity(events);
  } catch {
    /* transient: keep the last good view */
  }
}

const PLATFORM = { win32: 'Windows', darwin: 'macOS', linux: 'Linux', unknown: 'Computer' };

function monitorIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M4 5h16v11H4zM9 20h6M12 16v4');
  svg.append(path);
  return svg;
}

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function renderDevices() {
  const list = state.devices;
  $('no-devices').hidden = list.length > 0;
  const online = list.filter((d) => d.online).length;
  $('device-count').textContent = list.length ? `${online} of ${list.length} online` : '';
  $('devices').replaceChildren(
    ...list.map((d) =>
      h('article', { class: `device${d.online ? ' online' : ''}` },
        h('div', { class: 'device-head' },
          h('div', { class: 'device-icon' }, monitorIcon()),
          h('div', {},
            h('div', { class: 'device-name' }, d.name),
            h('div', { class: 'device-meta' },
              h('span', { class: `dot${d.online ? (d.busy ? ' warn' : ' on') : ''}` }),
              d.online ? (d.busy ? 'In a session' : 'Online') : `Offline · seen ${ago(d.lastSeen)}`,
              ` · ${PLATFORM[d.platform] || 'Computer'}`),
            h('div', { class: 'device-meta mono' }, formatCode(d.id)))),
        h('div', { class: 'device-actions' },
          h('button', { class: 'btn primary', disabled: !d.online || d.busy, onclick: () => connectDevice(d) }, 'Connect'),
          h('button', { class: 'btn', title: 'Rename', onclick: () => renameDevice(d) }, 'Rename'),
          h('button', { class: 'btn danger', title: 'Remove this computer', onclick: () => removeDevice(d) }, 'Remove')))),
  );
}

const EVENT_LABEL = {
  login: 'Signed in', login_failed: 'Failed sign-in', login_failed_2fa: 'Failed 2-step code',
  account_created: 'Account created', device_enrolled: 'Computer added', device_removed: 'Computer removed',
  session_started: 'Session started', session_ended: 'Session ended', password_changed: 'Password changed',
  '2fa_enabled': '2-step verification on', '2fa_disabled': '2-step verification off',
};

function renderActivity(events) {
  const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  $('activity').replaceChildren(
    ...(events.length ? events.slice(0, 25) : [{ ts: Date.now(), event: 'Nothing yet', detail: '' }]).map((e) =>
      h('li', {},
        h('time', {}, fmt.format(e.ts)),
        h('span', {}, EVENT_LABEL[e.event] || e.event),
        h('span', { class: 'detail', title: e.detail || '' }, e.detail || ''))),
  );
}

async function renameDevice(d) {
  const name = prompt('Name for this computer', d.name);
  if (!name || name.trim() === d.name) return;
  await api('PATCH', `/api/devices/${d.id}`, { name }).catch(() => {});
  refresh();
}

async function removeDevice(d) {
  if (!confirm(`Remove "${d.name}"? Unattended access to it stops immediately.`)) return;
  await api('DELETE', `/api/devices/${d.id}`).catch(() => {});
  refresh();
}

/* ───────────── starting sessions ───────────── */
function askPassword({ title, sub, label, error }) {
  return new Promise((resolve) => {
    const dlg = $('dlg-password');
    const form = $('pw-form');
    $('pw-title').textContent = title;
    $('pw-sub').textContent = sub;
    $('pw-label').textContent = label;
    $('pw-error').textContent = error || '';
    form.elements.password.value = '';
    let result = null;
    form.onsubmit = () => { result = form.elements.password.value; };
    dlg.onclose = () => resolve(result || null);
    dlg.showModal();
    form.elements.password.focus();
  });
}

function begin(target, name, password, prompt) {
  state.inSession = true;
  openSession({
    target, name, password,
    askPassword: (error) => askPassword({ ...prompt, error }),
    onClose: () => { state.inSession = false; refresh(); },
  });
}

async function connectDevice(d) {
  const prompt = {
    title: `Connect to ${d.name}`,
    sub: 'Enter the unattended access password that was set on that computer.',
    label: 'Access password',
  };
  const password = await askPassword(prompt);
  if (password) begin({ deviceId: d.id }, d.name, password, prompt);
}

$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const code = f.code.value.replace(/\D/g, '');
  if (code.length !== 9) return f.code.focus();
  if (!f.password.value.trim()) return f.password.focus();
  begin({ code }, `Support session ${formatCode(code)}`, f.password.value, {
    title: 'Session password', sub: 'Ask the other person to read the password shown in their Shackle window.', label: 'Password',
  });
  f.password.value = '';
  f.code.value = '';
});
$('join-form').elements.code.addEventListener('input', (e) => {
  e.target.value = formatCode(e.target.value.replace(/\D/g, '').slice(0, 9));
});

/* ───────────── settings ───────────── */
for (const btn of document.querySelectorAll('[data-close]')) btn.addEventListener('click', () => btn.closest('dialog').close());

function renderTotp() {
  $('totp-off').hidden = state.user.totpEnabled;
  $('totp-on').hidden = !state.user.totpEnabled;
  $('totp-setup').hidden = true;
}
const note = (text, ok = false) => {
  const el = $('settings-msg');
  el.textContent = text;
  el.className = ok ? 'ok' : 'error';
};

$('open-settings').addEventListener('click', () => {
  $('settings-email').textContent = state.user.email;
  note('');
  renderTotp();
  $('dlg-settings').showModal();
});
$('logout').addEventListener('click', async () => {
  await api('POST', '/api/logout', {}).catch(() => {});
  location.reload();
});
$('totp-begin').addEventListener('click', async () => {
  try {
    const { secret, uri } = await api('POST', '/api/totp/begin', {});
    $('totp-secret').textContent = secret.replace(/(.{4})/g, '$1 ').trim();
    $('totp-uri').href = uri;
    $('totp-off').hidden = true;
    $('totp-setup').hidden = false;
  } catch (err) { note(say(err.code)); }
});
$('totp-setup').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('POST', '/api/totp/enable', { code: e.target.elements.code.value });
    state.user.totpEnabled = true;
    e.target.reset();
    renderTotp();
    note('Two-step verification is on.', true);
  } catch (err) { note(say(err.code)); }
});
$('totp-on').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('POST', '/api/totp/disable', { password: e.target.elements.password.value });
    state.user.totpEnabled = false;
    e.target.reset();
    renderTotp();
    note('Two-step verification is off.', true);
  } catch (err) { note(say(err.code)); }
});
$('pass-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  try {
    await api('POST', '/api/password', { current: f.current.value, next: f.next.value });
    e.target.reset();
    note('Password changed. Other browsers were signed out.', true);
  } catch (err) { note(say(err.code)); }
});

boot().catch(() => {
  document.body.textContent = 'Cannot reach the Shackle server.';
});
