// Connect to another computer by ID + password.
// Opened by the Shackle desktop app (with a one-time ticket), or directly in any browser, such as a
// phone's, where the visitor types the ID and password into the form on this page.
import { openSession } from './viewer.js';
import { formatCode } from './proto.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const ticket = params.get('ticket') || '';
let code = (params.get('code') || '').replace(/\D/g, '');
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

if (ticket) {
  openSession({
    target: { code },
    ticket,
    name: `Computer ${formatCode(code)}`,
    password: null,
    askPassword,
    onClose: () => window.close(),
  });
} else {
  const guest = $('guest');
  const form = $('guest-form');
  guest.hidden = false;
  if (code) form.elements.code.value = formatCode(code);

  // Group the digits as they are typed: 123 456 789.
  form.elements.code.addEventListener('input', (e) => {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 9);
    e.target.value = digits.replace(/(\d{3})(?=\d)/g, '$1 ');
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const entered = form.elements.code.value.replace(/\D/g, '');
    const password = form.elements.password.value.trim();
    if (entered.length !== 9) {
      $('guest-error').textContent = 'The ID has 9 digits.';
      return form.elements.code.focus();
    }
    if (!password) {
      $('guest-error').textContent = 'Enter the password shown on the other computer.';
      return form.elements.password.focus();
    }
    $('guest-error').textContent = '';
    code = entered;
    guest.hidden = true;
    openSession({
      target: { code },
      role: 'guest',
      name: `Computer ${formatCode(code)}`,
      password,
      askPassword,
      onClose: () => {
        form.elements.password.value = '';
        guest.hidden = false;
      },
    });
  });
}
