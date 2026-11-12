// Viewer page opened by the Shackle desktop app to control another computer by ID + password.
import { openSession } from './viewer.js';
import { formatCode } from './proto.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const code = (params.get('code') || '').replace(/\D/g, '');
const ticket = params.get('ticket') || '';
history.replaceState(null, '', location.pathname); // keep the one-time ticket out of the address

for (const btn of document.querySelectorAll('[data-close]')) btn.addEventListener('click', () => btn.closest('dialog').close());

function askPassword(error) {
  return new Promise((resolve) => {
    const dlg = $('dlg-password');
    const form = $('pw-form');
    $('pw-title').textContent = `Connect to ${formatCode(code)}`;
    $('pw-sub').textContent = 'Enter the password shown in Shackle on the other computer.';
    $('pw-label').textContent = 'Password';
    $('pw-error').textContent = error || '';
    form.elements.password.value = '';
    let result = null;
    form.onsubmit = () => { result = form.elements.password.value; };
    dlg.onclose = () => resolve(result || null);
    dlg.showModal();
    form.elements.password.focus();
  });
}

openSession({
  target: { code },
  ticket,
  name: `Computer ${formatCode(code)}`,
  password: null,
  askPassword,
  onClose: () => window.close(),
});
