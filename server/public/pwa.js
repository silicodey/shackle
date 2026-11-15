// Registers the offline page helper (see sw.js).
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
