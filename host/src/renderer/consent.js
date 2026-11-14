// Asks the person at this computer before anyone is let in. "Allow" unlocks after a short pause
// so the warning cannot be clicked through by reflex.
const viewer = new URLSearchParams(location.search).get('viewer') || 'Someone';
document.getElementById('who').textContent = viewer;
const allow = document.getElementById('allow');
let left = 3;
const tick = setInterval(() => {
  left -= 1;
  if (left <= 0) {
    clearInterval(tick);
    allow.disabled = false;
    allow.textContent = 'Allow';
  } else {
    allow.textContent = `Allow (${left})`;
  }
}, 1000);
allow.addEventListener('click', () => window.shackle.action('consentReply', { allow: true }));
document.getElementById('decline').addEventListener('click', () => window.shackle.action('consentReply', { allow: false }));
