// Google Analytics 4 for the landing page only. The Shackle app and server contain no analytics.
//
// Nothing is loaded from Google, and no cookie is set, until the visitor accepts. Visitors whose
// browser sends Global Privacy Control or Do Not Track are treated as having declined.
(function () {
  // Your GA4 measurement ID (Admin > Data streams > Web). Analytics stays off while this is empty.
  var GA_ID = 'G-Q0YD9HWRHN';
  // Ask before measuring. Required for visitors in the EU/UK; set to false only if you are sure
  // you do not need consent, in which case measuring starts on page load.
  var REQUIRE_CONSENT = true;

  var KEY = 'shackle-analytics';
  var started = false;

  function read() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function write(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* private mode */ } }

  function gtag() { window.dataLayer.push(arguments); }

  function platform() {
    var ua = navigator.userAgent || '';
    if (/Android/.test(ua)) return 'android';
    if (/iPhone|iPad/.test(ua)) return 'ios';
    if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
    if (/Windows/.test(ua)) return 'windows';
    if (/Linux/.test(ua)) return 'linux';
    return 'other';
  }

  function start() {
    if (started || !GA_ID) return;
    started = true;
    window.dataLayer = window.dataLayer || [];
    gtag('consent', 'default', {
      analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied'
    });
    gtag('js', new Date());
    // Page views, unique visitors, referrer, country, device, scrolls and outbound clicks are
    // collected by GA4 itself. No advertising features.
    gtag('config', GA_ID, { allow_google_signals: false, allow_ad_personalization_signals: false });
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA_ID);
    document.head.appendChild(s);
  }

  // Download clicks. A custom event name is used because GA4's built-in file_download does not
  // recognise .dmg and would double count the .exe.
  var FILES = {
    'Shackle-Setup-Windows.exe': 'windows',
    'Shackle-Mac-arm64.dmg': 'mac-arm64',
    'Shackle-Mac-x64.dmg': 'mac-x64'
  };
  document.addEventListener('click', function (e) {
    if (!started || !e.target.closest) return;
    var a = e.target.closest('a[href*="/releases/latest/download/"]');
    if (!a) return;
    var file = a.href.split('/').pop();
    if (FILES[file]) {
      gtag('event', 'app_download', {
        file_name: file,
        download_os: FILES[file],
        placement: a.id === 'dl-main' ? 'main_button' : a.classList.contains('dl-main') ? 'closing_button' : 'alt_link',
        visitor_platform: platform()
      });
    } else if (file === 'SHA256SUMS.txt') {
      gtag('event', 'checksums_click', { visitor_platform: platform() });
    }
  });

  // Consent banner
  var bar = null;
  function hide() { if (bar) { bar.remove(); bar = null; } }
  function choose(yes) {
    var before = read();
    write(yes ? 'yes' : 'no');
    hide();
    if (yes) start();
    // Withdrawing consent: remove GA's cookies and reload so the script is gone too.
    else if (before === 'yes') { clearCookies(); if (started) location.reload(); }
  }
  function clearCookies() {
    document.cookie.split(';').forEach(function (c) {
      var name = c.split('=')[0].trim();
      if (!/^_ga/.test(name)) return;
      var parts = location.hostname.split('.');
      for (var i = 0; i < parts.length; i++) {
        var domain = parts.slice(i).join('.');
        document.cookie = name + '=; Max-Age=0; path=/; domain=' + domain;
        document.cookie = name + '=; Max-Age=0; path=/; domain=.' + domain;
      }
      document.cookie = name + '=; Max-Age=0; path=/';
    });
  }
  function button(text, cls, yes) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    b.addEventListener('click', function () { choose(yes); });
    return b;
  }
  function ask() {
    if (bar) return;
    bar = document.createElement('div');
    bar.className = 'consent';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Analytics choice');
    var p = document.createElement('p');
    p.textContent = 'May we count this visit with Google Analytics? It sets a cookie and tells us how many people visit and download. The Shackle app itself is never tracked.';
    var actions = document.createElement('div');
    actions.className = 'consent-actions';
    actions.appendChild(button('Decline', 'consent-btn', false));
    actions.appendChild(button('Allow', 'consent-btn yes', true));
    bar.appendChild(p);
    bar.appendChild(actions);
    document.body.appendChild(bar);
  }

  var settings = document.getElementById('analytics-settings');
  if (!GA_ID) { var wrap = document.getElementById('analytics-settings-wrap'); if (wrap) wrap.hidden = true; return; }
  if (settings) settings.addEventListener('click', ask);

  var optedOut = navigator.globalPrivacyControl === true || navigator.doNotTrack === '1';
  var choice = read();
  if (!REQUIRE_CONSENT) { if (choice !== 'no' && !optedOut) start(); }
  else if (choice === 'yes') start();
  else if (choice !== 'no' && !optedOut) ask();
})();
