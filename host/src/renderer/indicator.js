const viewer = new URLSearchParams(location.search).get('viewer') || 'Someone';
document.getElementById('text').textContent = `${viewer} is controlling this computer`;
document.getElementById('end').addEventListener('click', () => window.tether.action('endSession'));
