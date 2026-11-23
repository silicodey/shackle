// Shackle landing page. Everything works without JavaScript; this only points the download buttons at the visitor's platform.
(function () {
  var ua = navigator.userAgent || '';
  var isMac = /Macintosh|Mac OS X/.test(ua) && !/iPhone|iPad/.test(ua);
  var isMobile = /Android|iPhone|iPad/.test(ua);
  var buttons = document.querySelectorAll('.dl-main');
  var link = function (os) { return document.querySelector('[data-os="' + os + '"]').href; };
  buttons.forEach(function (btn) {
    var label = btn.querySelector('.dl-label');
    if (isMobile) {
      // Phones need no app: they connect to a computer in the browser.
      label.textContent = 'Control a computer from this phone';
      btn.href = 'https://shackle.onrender.com/connect.html';
    } else if (isMac) {
      // Browsers on Apple-chip Macs still report "Intel", so default to Apple chip (every Mac since late 2020).
      btn.href = link('mac-arm');
      label.textContent = 'Download for Mac';
    }
  });
  if (isMac && !isMobile) document.getElementById('dl-alt').firstChild.textContent = 'Apple chip. Also for ';
})();
