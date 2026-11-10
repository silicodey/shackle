// Control panel UI. All privileged work happens in the main process via window.shackle.
const $ = (id) => document.getElementById(id);
const T = window.shackle;
let state = null;
let enrollFormTouched = false;

const fmtCode = (c) => (c ? String(c).replace(/(\d{3})(?=\d)/g, '$1 ') : '--- --- ---');
const fmtPass = (p) => (p ? `${p.slice(0, 4)} ${p.slice(4)}` : '--------');

function msg(id, text, ok = false) {
  const el = $(id);
  el.textContent = text || '';
  el.classList.toggle('ok', ok);
}

async function act(name, payload, msgId) {
  const res = await T.action(name, payload);
  if (!res.ok && msgId) msg(msgId, res.error || 'That did not work.');
  return res;
}

function render(s) {
  state = s;
  const status = s.session ? 'In session'
    : s.connection === 'online' ? 'Ready'
    : s.connection === 'connecting' ? 'Connecting…'
    : !s.serverUrl ? 'No server set' : 'Server unreachable, retrying…';
  $('status').textContent = status;
  $('dot').className = `dot ${s.session ? 'warn' : s.connection === 'online' ? 'on' : s.connection === 'connecting' ? 'warn' : 'off'}`;

  $('session').hidden = !s.session;
  if (s.session) $('session-viewer').textContent = s.session.viewer;

  const needPerms = s.platform === 'darwin' && (!s.permissions.screen || !s.permissions.accessibility);
  $('perms').hidden = !needPerms;
  $('perm-screen').classList.toggle('granted', s.permissions.screen);
  $('perm-accessibility').classList.toggle('granted', s.permissions.accessibility);

  const urlInput = $('server-form').elements.url;
  if (document.activeElement !== urlInput) urlInput.value = s.serverUrl || '';
  if (s.serverUrl && s.serverUrl.startsWith('http://') && !/^http:\/\/(localhost|127\.|\[::1\])/.test(s.serverUrl)) {
    msg('server-msg', 'This address is not encrypted (http). Use https for anything beyond a private network.');
  } else if (!$('server-msg').classList.contains('ok')) {
    msg('server-msg', '');
  }

  const online = s.connection === 'online';
  $('code').textContent = online ? fmtCode(s.code) : '--- --- ---';
  $('pass').textContent = online ? fmtPass(s.supportPassword) : '--------';
  $('copy').disabled = !online;
  $('new-code').disabled = !online || !!s.session;

  $('enroll').hidden = !!s.device;
  $('enrolled').hidden = !s.device;
  if (!s.device && !enrollFormTouched) $('enroll').elements.name.value = s.deviceName || '';
  if (s.device) {
    $('dev-name').textContent = `${s.deviceName} · ${fmtCode(s.device.id)}`;
    $('dev-account').textContent = s.device.account || '';
    $('pw-state').textContent = s.unattendedSet ? 'Set' : 'Not set: unattended access is off';
    $('pw-state').style.color = s.unattendedSet ? 'var(--accent)' : 'var(--warn)';
    $('opt-login').checked = !!s.startAtLogin;
    $('opt-awake').checked = !!s.keepAwake;
  }
  $('version').textContent = `Shackle ${s.version}${s.inputAvailable ? '' : ' · input control unavailable on this system'}`;
}

$('server-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  msg('server-msg', '');
  const res = await act('setServer', { url: e.target.elements.url.value }, 'server-msg');
  if (res.ok) msg('server-msg', 'Saved.', true);
  e.target.elements.url.blur();
});

$('copy').addEventListener('click', async () => {
  if (!state?.code) return;
  await act('copy', { text: `Shackle ID: ${fmtCode(state.code)}\nPassword: ${state.supportPassword}` });
  $('copy').textContent = 'Copied';
  setTimeout(() => ($('copy').textContent = 'Copy both'), 1500);
});
$('new-code').addEventListener('click', () => act('newCode'));
$('end-session').addEventListener('click', () => act('endSession'));

$('enroll').addEventListener('input', () => { enrollFormTouched = true; });
$('enroll').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const btn = e.target.querySelector('button');
  msg('enroll-msg', '');
  btn.disabled = true;
  const res = await T.action('enroll', { name: f.name.value, email: f.email.value, password: f.password.value, totp: f.totp.value });
  btn.disabled = false;
  if (res.ok) {
    e.target.reset();
    enrollFormTouched = false;
    $('enroll-totp').hidden = true;
  } else {
    if (res.code === 'totp_required' || res.code === 'invalid_totp') {
      $('enroll-totp').hidden = false;
      f.totp.focus();
    }
    msg('enroll-msg', res.error);
  }
});

$('access').addEventListener('submit', async (e) => {
  e.preventDefault();
  msg('access-msg', '');
  const res = await act('setAccessPassword', { password: e.target.elements.password.value }, 'access-msg');
  if (res.ok) {
    e.target.reset();
    msg('access-msg', 'Access password saved. You will need it each time you connect.', true);
  }
});

$('opt-login').addEventListener('change', (e) => act('setOption', { key: 'startAtLogin', value: e.target.checked }));
$('opt-awake').addEventListener('change', (e) => act('setOption', { key: 'keepAwake', value: e.target.checked }));
$('unenroll').addEventListener('click', () => {
  if (confirm('Remove this computer from the account? Unattended access will stop.')) act('unenroll');
});
for (const b of document.querySelectorAll('[data-perm]')) {
  b.addEventListener('click', () => act('openPermission', { which: b.dataset.perm }));
}

T.onState(render);
T.getState().then(render);
