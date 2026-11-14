// Point the main button at the visitor's platform. Everything still works without JavaScript.
(function () {
  var ua = navigator.userAgent || '';
  var isMac = /Macintosh|Mac OS X/.test(ua) && !/iPhone|iPad/.test(ua);
  var isMobile = /Android|iPhone|iPad/.test(ua);
  var main = document.getElementById('dl-main');
  var label = document.getElementById('dl-label');
  var link = function (os) { return document.querySelector('[data-os="' + os + '"]').href; };
  if (isMobile) {
    label.textContent = 'Download on a Windows PC or Mac';
    main.removeAttribute('href');
    main.classList.add('off');
  } else if (isMac) {
    // Browsers on Apple-chip Macs still report "Intel", so default to Apple chip (every Mac since late 2020).
    main.href = link('mac-arm');
    label.textContent = 'Download for Mac';
    document.getElementById('dl-alt').firstChild.textContent = 'Apple chip. Also for ';
  }
})();
