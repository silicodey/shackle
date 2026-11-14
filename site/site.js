// Shackle landing page. Everything still works without JavaScript.
(function () {
  // 1. Point the download buttons at the visitor's platform.
  var ua = navigator.userAgent || '';
  var isMac = /Macintosh|Mac OS X/.test(ua) && !/iPhone|iPad/.test(ua);
  var isMobile = /Android|iPhone|iPad/.test(ua);
  var buttons = document.querySelectorAll('.dl-main');
  var link = function (os) { return document.querySelector('[data-os="' + os + '"]').href; };
  buttons.forEach(function (btn) {
    var label = btn.querySelector('.dl-label');
    if (isMobile) {
      label.textContent = 'Download on a Windows PC or Mac';
      btn.removeAttribute('href');
      btn.classList.add('off');
    } else if (isMac) {
      // Browsers on Apple-chip Macs still report "Intel", so default to Apple chip (every Mac since late 2020).
      btn.href = link('mac-arm');
      label.textContent = 'Download for Mac';
    }
  });
  if (isMac && !isMobile) document.getElementById('dl-alt').firstChild.textContent = 'Apple chip. Also for ';

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.documentElement.classList.add('js');

  // 2. Reveal sections as they scroll into view.
  var items = document.querySelectorAll('.reveal');
  if (reduce || !('IntersectionObserver' in window)) {
    items.forEach(function (el) { el.classList.add('in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px' });
    items.forEach(function (el) { io.observe(el); });
  }

  // 3. Spotlight that follows the pointer on cards.
  document.querySelectorAll('.spot').forEach(function (el) {
    el.addEventListener('pointermove', function (e) {
      var r = el.getBoundingClientRect();
      el.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      el.style.setProperty('--my', (e.clientY - r.top) + 'px');
    });
  });

  // 4. The product window tilts back and flattens as it scrolls into view.
  var shot = document.getElementById('shot');
  if (shot && !reduce) {
    var ticking = false;
    var update = function () {
      ticking = false;
      var r = shot.getBoundingClientRect();
      var p = Math.min(1, Math.max(0, (window.innerHeight - r.top) / (window.innerHeight * 0.9)));
      shot.style.setProperty('--tilt', ((1 - p) * 18).toFixed(2) + 'deg');
      shot.style.setProperty('--lift', ((1 - p) * 0.08 + 0.92).toFixed(3));
    };
    window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    update();
  }

  // 5. Header gets a background once the page scrolls.
  var top = document.querySelector('.top');
  var onScroll = function () { top.classList.toggle('scrolled', window.scrollY > 8); };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();
