// Phone and tablet controls for the remote viewer.
//
// Two ways to work the mouse:
// - Touchpad (default): the screen is a laptop touchpad. A cursor sits on the remote picture and
//   one finger moves it from anywhere; tap clicks where the cursor is.
// - Touch: the finger is the mouse; tap exactly where to click.
//
// Gestures
//   Touchpad  one finger: move cursor · tap: click · double tap: double click
//             tap, then touch again and move: drag · two-finger tap: right-click
//   Touch     tap: click there · hold: right-click · drag: drag
//   Both      two fingers: scroll (with momentum) · pinch: zoom
//             zoomed: the view follows the cursor (touchpad) or two fingers pan (touch)
//
// A dock of buttons floats over the picture (keyboard, right-click, mode, fit, menu), and while
// the phone keyboard is open a strip offers the keys phones lack: Esc, Tab, Ctrl, Alt, the
// Windows/Command key, arrows and Delete. Ctrl, Alt and Win stay held for the next key.

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const MODE_KEY = 'shackle-touch-mode';

const ICONS = {
  keyboard: '<path d="M3 7h18v10H3z"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 13.5h10"/>',
  right: '<path d="M8 3h8a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4z"/><path d="M12 3v7h8"/><path d="M12 3h4a4 4 0 0 1 4 4v3h-8z" fill="currentColor" stroke="none"/>',
  touchpad: '<rect x="3" y="5" width="18" height="14" rx="2.500"/><path d="M3 15h18M12 15v4"/>',
  finger: '<path d="M9 11V5.500a1.500 1.500 0 0 1 3 0V11m0-2.500a1.500 1.500 0 0 1 3 0V11m0-1.500a1.500 1.500 0 0 1 3 0V15a6 6 0 0 1-6 6h-.500a6 6 0 0 1-5-2.700L4.300 15a1.500 1.500 0 0 1 2.400-1.800L9 15"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

const STRIP_KEYS = [
  ['Esc', 'Escape'], ['Tab', 'Tab'], ['Ctrl', 'ControlLeft', true], ['Alt', 'AltLeft', true],
  [/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Win', 'MetaLeft', true],
  ['←', 'ArrowLeft'], ['↑', 'ArrowUp'], ['↓', 'ArrowDown'], ['→', 'ArrowRight'], ['Del', 'Delete'],
];

/** KeyboardEvent.code for a typed character, so Ctrl/Alt/Win + character can be sent as a combo. */
function codeForChar(ch) {
  if (/^[a-z]$/i.test(ch)) return `Key${ch.toUpperCase()}`;
  if (/^[0-9]$/.test(ch)) return `Digit${ch}`;
  return { ' ': 'Space', '-': 'Minus', '=': 'Equal', ',': 'Comma', '.': 'Period', '/': 'Slash', ';': 'Semicolon',
    "'": 'Quote', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', '`': 'Backquote' }[ch] || null;
}

function readMode() {
  try { return localStorage.getItem(MODE_KEY) === 'direct' ? 'direct' : 'trackpad'; } catch { return 'trackpad'; }
}
function saveMode(mode) {
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* private mode */ }
}

/**
 * @param {object} session  viewer Session: send(), toast(), live, closed
 * @param {(el: EventTarget, type: string, fn: Function, opts?: object) => void} on  listener helper
 *        that removes everything when the session ends
 */
export function attachTouch(session, on) {
  const viewer = $('viewer');
  const stage = $('stage');
  const video = $('video');
  const box = $('kbd');
  viewer.classList.add('touch-ui');

  /* ───────── elements ───────── */
  const cursorEl = document.createElement('div');
  cursorEl.className = 'tcursor';
  cursorEl.innerHTML = '<svg viewBox="0 0 20 24" aria-hidden="true"><path d="M2 2l15 10.500-6.600 1.300L14.500 21l-3.200 1.500-4.100-7.200L2 19.500z"/></svg>';
  stage.append(cursorEl);

  const dock = document.createElement('div');
  dock.className = 'dock';
  dock.setAttribute('role', 'toolbar');
  dock.setAttribute('aria-label', 'Remote controls');
  const button = (name, label, ic) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `dock-btn dock-${name}`;
    b.setAttribute('aria-label', label);
    b.title = label;
    b.innerHTML = icon(ic);
    dock.append(b);
    return b;
  };
  const kbdBtn = button('kbd', 'Keyboard', 'keyboard');
  const rightBtn = button('right', 'Right-click', 'right');
  const modeBtn = button('mode', 'Switch mouse mode', 'touchpad');
  const fitBtn = button('fit', 'Fit to screen', 'fit');
  const menuBtn = button('menu', 'Menu', 'menu');
  menuBtn.setAttribute('aria-expanded', 'false');
  fitBtn.hidden = true;
  viewer.append(dock);

  const strip = document.createElement('div');
  strip.className = 'keystrip';
  strip.setAttribute('role', 'toolbar');
  strip.setAttribute('aria-label', 'Special keys');
  for (const [label, code, sticky] of STRIP_KEYS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.dataset.code = code;
    if (sticky) b.dataset.sticky = '1';
    strip.append(b);
  }
  viewer.append(strip);

  /* ───────── state ───────── */
  let mode = readMode();
  const zoom = { s: 1, x: 0, y: 0 };
  const cur = { x: 0.5, y: 0.5 };          // remote cursor, 0..1 of the remote screen
  const touches = new Map();               // pointerId -> {x, y}
  let one = null;                          // one-finger gesture
  let two = null;                          // two-finger gesture
  let lastTap = { t: 0, x: 0, y: 0 };
  let movePending = false;
  let inertia = 0;
  let hintToast = null;
  let wakeLock = null;
  let backArmed = 0;
  const mods = new Set();

  /** The visible remote picture in page coordinates (after zoom and letterboxing). */
  const picture = () => {
    const r = video.getBoundingClientRect();
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || !r.width || !r.height) return null;
    const sc = Math.min(r.width / vw, r.height / vh);
    const w = vw * sc, h = vh * sc;
    return { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, w, h };
  };
  const toRemote = (cx, cy) => {
    const p = picture();
    if (!p) return null;
    return { x: clamp((cx - p.x) / p.w, 0, 1), y: clamp((cy - p.y) / p.h, 0, 1) };
  };

  const drawCursor = () => {
    const p = picture();
    if (!p || mode !== 'trackpad' || !session.live) { cursorEl.hidden = true; return; }
    const sr = stage.getBoundingClientRect();
    cursorEl.hidden = false;
    cursorEl.style.transform = `translate(${p.x + cur.x * p.w - sr.left}px, ${p.y + cur.y * p.h - sr.top}px)`;
  };

  const applyZoom = () => {
    const r = stage.getBoundingClientRect();
    zoom.s = clamp(zoom.s, 1, 6);
    if (zoom.s < 1.02) { zoom.s = 1; zoom.x = 0; zoom.y = 0; }
    zoom.x = clamp(zoom.x, r.width - r.width * zoom.s, 0);
    zoom.y = clamp(zoom.y, r.height - r.height * zoom.s, 0);
    video.style.transform = zoom.s === 1 ? '' : `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`;
    fitBtn.hidden = zoom.s === 1;
    drawCursor();
  };

  /** While zoomed in touchpad mode, slide the view so the cursor stays away from the edges. */
  const follow = () => {
    if (zoom.s === 1 || mode !== 'trackpad') return;
    const p = picture();
    const sr = stage.getBoundingClientRect();
    if (!p) return;
    const cx = p.x + cur.x * p.w, cy = p.y + cur.y * p.h;
    const mx = sr.width * 0.18, my = sr.height * 0.18;
    if (cx < sr.left + mx) zoom.x += sr.left + mx - cx;
    else if (cx > sr.right - mx) zoom.x -= cx - (sr.right - mx);
    if (cy < sr.top + my) zoom.y += sr.top + my - cy;
    else if (cy > sr.bottom - my) zoom.y -= cy - (sr.bottom - my);
    applyZoom();
  };

  const sendMove = () => {
    if (movePending) return;
    movePending = true;
    requestAnimationFrame(() => {
      movePending = false;
      session.send({ t: 'm', x: cur.x, y: cur.y });
    });
  };
  const click = (b, count = 1) => {
    session.send({ t: 'm', x: cur.x, y: cur.y });
    for (let i = 0; i < count; i++) {
      session.send({ t: 'd', b, x: cur.x, y: cur.y });
      session.send({ t: 'u', b, x: cur.x, y: cur.y });
    }
  };
  const press = (down) => session.send({ t: down ? 'd' : 'u', b: 0, x: cur.x, y: cur.y });
  const buzz = () => navigator.vibrate?.(12);

  const stopInertia = () => { cancelAnimationFrame(inertia); inertia = 0; };
  const startInertia = (vx, vy) => {
    stopInertia();
    const step = () => {
      vx *= 0.92; vy *= 0.92;
      if (Math.abs(vx) + Math.abs(vy) < 1.5 || !session.live) { inertia = 0; return; }
      session.send({ t: 'w', dx: Math.round(vx), dy: Math.round(vy) });
      inertia = requestAnimationFrame(step);
    };
    inertia = requestAnimationFrame(step);
  };

  const setMode = (next, announce) => {
    mode = next;
    saveMode(mode);
    modeBtn.innerHTML = icon(mode === 'trackpad' ? 'touchpad' : 'finger');
    modeBtn.setAttribute('aria-label', mode === 'trackpad' ? 'Mouse mode: touchpad. Switch to touch' : 'Mouse mode: touch. Switch to touchpad');
    modeBtn.title = modeBtn.getAttribute('aria-label');
    viewer.classList.toggle('mode-direct', mode === 'direct');
    drawCursor();
    if (announce) showHint();
  };
  const hint = () => (mode === 'trackpad'
    ? 'Touchpad: slide to move the cursor, tap to click, two-finger tap to right-click, two fingers to scroll, pinch to zoom.'
    : 'Touch: tap where you want to click, hold to right-click, drag to drag, two fingers to scroll, pinch to zoom.')
    + (innerHeight > innerWidth ? ' Turn the phone sideways for a bigger picture.' : '');
  // One hint at a time: a new one replaces the last instead of stacking up.
  const showHint = (text = hint()) => {
    hintToast?.remove();
    hintToast = session.toast(text);
  };

  /* ───────── screen on, Back button ───────── */
  const keepAwake = async () => {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
  };
  on(document, 'visibilitychange', () => { if (!document.hidden && session.live && (!wakeLock || wakeLock.released)) keepAwake(); });
  // Android's Back button would leave the page and drop the session. Back first closes the
  // keyboard or the menu; otherwise it asks for a second press within two seconds to disconnect.
  let lastPop = 0;
  on(window, 'popstate', () => {
    if (!session.live) return;
    history.pushState({ shackle: 1 }, '');
    // One press of Back can arrive as two history steps a moment apart: count those as one press.
    const now = performance.now();
    if (now - lastPop < 350) return;
    lastPop = now;
    if (document.activeElement === box) return box.blur();
    if (viewer.classList.contains('menu-open')) return closeMenu();
    if (now - backArmed < 2000) return session.finish(null);
    backArmed = now;
    showHint('Press Back again to disconnect.');
  });

  /* ───────── gestures ───────── */
  on(stage, 'pointerdown', (e) => {
    if (!session.live || e.pointerType !== 'touch') return;
    e.preventDefault();
    stopInertia();
    closeMenu();
    try { stage.setPointerCapture(e.pointerId); } catch { /* already released */ }
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (touches.size === 1) {
      const now = performance.now();
      one = {
        id: e.pointerId, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, lt: now, t0: now,
        moved: false, dragging: false, held: false,
        // A second touch right after a tap, near it, drags if it then moves (tap-and-a-half).
        tapDrag: mode === 'trackpad' && now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 60,
      };
      if (mode === 'direct') {
        const p = toRemote(e.clientX, e.clientY);
        if (p) Object.assign(cur, p);
        one.timer = setTimeout(() => {
          if (!one || one.moved) return;
          one.held = true;
          buzz();
          click(2);
        }, 500);
      }
    } else if (touches.size === 2) {
      if (one) {
        clearTimeout(one.timer);
        if (one.dragging) press(false);
        one = null;
      }
      const [a, b] = [...touches.values()];
      const sr = stage.getBoundingClientRect();
      const mid = { x: (a.x + b.x) / 2 - sr.left, y: (a.y + b.y) / 2 - sr.top };
      two = {
        t0: performance.now(), d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: zoom.s, x0: zoom.x, y0: zoom.y,
        mid0: mid, last: mid, lt: performance.now(), vx: 0, vy: 0, mode: null, travel: 0, done: false,
      };
    }
  }, { passive: false });

  on(stage, 'pointermove', (e) => {
    if (!session.live || e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
    e.preventDefault();
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (one && one.id === e.pointerId) {
      const now = performance.now();
      let dx = e.clientX - one.lx, dy = e.clientY - one.ly;
      const dt = Math.max(1, now - one.lt);
      const dist = Math.hypot(e.clientX - one.sx, e.clientY - one.sy);
      // A tap may wobble a few pixels; a finger that stays down longer than a tap is moving on
      // purpose, so even a tiny nudge then counts (for precise positioning).
      const threshold = mode === 'trackpad' ? (now - one.t0 > 220 ? 1 : 5) : 10;
      if (!one.moved && dist <= threshold) return;
      one.lx = e.clientX; one.ly = e.clientY; one.lt = now;
      if (!one.moved) {
        // Apply the distance covered before the movement was recognised, instead of dropping it.
        dx = e.clientX - one.sx; dy = e.clientY - one.sy;
        one.moved = true;
        clearTimeout(one.timer);
        if (one.tapDrag || (mode === 'direct' && !one.held)) {
          one.dragging = true;
          press(true);
        }
      }
      if (!one.moved) return;
      if (mode === 'trackpad') {
        const p = picture();
        if (!p) return;
        // Pointer acceleration: slow strokes are precise, quick flicks cross the screen.
        const speed = Math.hypot(dx, dy) / dt; // px per ms
        const gain = clamp(0.75 + (speed - 0.15) * 1.5, 0.75, 2.8);
        cur.x = clamp(cur.x + (dx * gain) / p.w, 0, 1);
        cur.y = clamp(cur.y + (dy * gain) / p.h, 0, 1);
        drawCursor();
        follow();
        sendMove();
      } else if (!one.held) {
        const p = toRemote(e.clientX, e.clientY);
        if (!p) return;
        Object.assign(cur, p);
        sendMove();
      }
    } else if (two && !two.done && touches.size === 2) {
      const [a, b] = [...touches.values()];
      const sr = stage.getBoundingClientRect();
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2 - sr.left, y: (a.y + b.y) / 2 - sr.top };
      two.travel = Math.max(two.travel, Math.hypot(mid.x - two.mid0.x, mid.y - two.mid0.y), Math.abs(d - two.d0));
      if (!two.mode) {
        if (Math.abs(d / two.d0 - 1) > 0.15) two.mode = 'zoom';
        else if (Math.hypot(mid.x - two.mid0.x, mid.y - two.mid0.y) > 10) two.mode = mode === 'direct' && zoom.s > 1 ? 'zoom' : 'scroll';
      }
      if (two.mode === 'zoom') {
        // Keep the spot that was under the fingers under them while zooming and panning.
        const s = clamp(two.s0 * (d / two.d0), 1, 6);
        const cx = (two.mid0.x - two.x0) / two.s0;
        const cy = (two.mid0.y - two.y0) / two.s0;
        zoom.s = s;
        zoom.x = mid.x - cx * s;
        zoom.y = mid.y - cy * s;
        applyZoom();
      } else if (two.mode === 'scroll') {
        const now = performance.now();
        // Content follows the fingers, as when scrolling a page on the phone.
        const dx = (two.last.x - mid.x) * 2.2, dy = (two.last.y - mid.y) * 2.2;
        if (Math.abs(dx) + Math.abs(dy) >= 3) {
          session.send({ t: 'w', dx: Math.round(dx), dy: Math.round(dy) });
          const dt = Math.max(8, now - two.lt) / 16.7; // in frames
          two.vx = two.vx * 0.5 + (dx / dt) * 0.5;
          two.vy = two.vy * 0.5 + (dy / dt) * 0.5;
          two.last = mid;
          two.lt = now;
        }
      }
    }
  }, { passive: false });

  const end = (e) => {
    if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
    touches.delete(e.pointerId);
    const cancelled = e.type === 'pointercancel' || !session.live;

    if (one && one.id === e.pointerId) {
      clearTimeout(one.timer);
      const quick = performance.now() - one.t0 < 300;
      if (one.dragging) {
        press(false);
      } else if (!cancelled && !one.moved && !one.held && (mode === 'direct' || quick)) {
        click(0);
        lastTap = { t: performance.now(), x: e.clientX, y: e.clientY };
      }
      one = null;
    }

    if (two && !two.done) {
      // The first finger to lift ends the two-finger gesture; the other is ignored until it lifts.
      two.done = true;
      if (!cancelled && !two.mode && two.travel < 12 && performance.now() - two.t0 < 350) {
        if (mode === 'direct') {
          const [a] = [...touches.values()];
          const p = a && toRemote(a.x, a.y);
          if (p) Object.assign(cur, p);
        }
        buzz();
        click(2);
      } else if (two.mode === 'scroll' && performance.now() - two.lt < 80) {
        startInertia(two.vx, two.vy);
      }
    }
    if (touches.size === 0) two = null;
  };
  on(stage, 'pointerup', end);
  on(stage, 'pointercancel', end);
  on(window, 'resize', () => { applyZoom(); });
  on(video, 'resize', drawCursor);

  /* ───────── dock ───────── */
  // Buttons must not take focus from the keyboard box, or the phone keyboard closes.
  for (const el of [dock, strip]) on(el, 'pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); });

  on(rightBtn, 'click', () => { if (session.live) { buzz(); click(2); } });
  on(modeBtn, 'click', () => setMode(mode === 'trackpad' ? 'direct' : 'trackpad', true));
  on(fitBtn, 'click', () => { zoom.s = 1; applyZoom(); });

  const closeMenu = () => {
    viewer.classList.remove('menu-open');
    menuBtn.setAttribute('aria-expanded', 'false');
  };
  on(menuBtn, 'click', () => {
    hintToast?.remove();
    const open = viewer.classList.toggle('menu-open');
    menuBtn.setAttribute('aria-expanded', String(open));
  });
  // Close the menu after a button in it is used; selects close it when they change.
  on($('bar'), 'click', (e) => { if (e.target.closest('button')) closeMenu(); });
  on($('bar'), 'change', closeMenu);

  /* ───────── keyboard ───────── */
  // Phone keyboards do not report physical keys, so the hidden box collects what is typed and it
  // is sent as text. The box always holds one placeholder character, so Backspace has something
  // to delete even when it looks empty.
  const MARK = ' ';
  let composing = false;
  const resetBox = () => {
    box.value = MARK;
    box.setSelectionRange(1, 1);
  };
  const sendKey = (code) => {
    const held = [...mods];
    session.send({ t: 'combo', codes: [...held, code] });
    clearMods();
  };
  const clearMods = () => {
    mods.clear();
    for (const b of strip.querySelectorAll('[data-sticky]')) b.classList.remove('on');
  };
  const sendText = (text) => {
    if (!mods.size) return session.send({ t: 'text', s: text });
    // Ctrl/Alt/Win held: the first character goes as a key combo (Ctrl+C), the rest as text.
    const code = codeForChar(text[0]);
    if (code) sendKey(code);
    else clearMods();
    if (text.length > 1) session.send({ t: 'text', s: text.slice(1) });
  };
  const flush = () => {
    if (composing || !session.live) return;
    const v = box.value;
    if (v === MARK) return;
    if (v === '') {
      sendKey('Backspace');
    } else {
      const typed = v.startsWith(MARK) ? v.slice(1) : v;
      typed.split('\n').forEach((part, i, parts) => {
        if (part) sendText(part);
        if (i < parts.length - 1) sendKey('Enter');
      });
    }
    resetBox();
  };
  on(box, 'compositionstart', () => { composing = true; });
  on(box, 'compositionend', () => { composing = false; flush(); });
  on(box, 'input', flush);
  on(box, 'focus', () => { resetBox(); viewer.classList.add('typing'); });
  on(box, 'blur', () => { viewer.classList.remove('typing'); clearMods(); });
  on(kbdBtn, 'click', () => {
    if (document.activeElement === box) return box.blur();
    resetBox();
    box.focus();
  });
  on(strip, 'click', (e) => {
    const b = e.target.closest('button');
    if (!b || !session.live) return;
    if (b.dataset.sticky) {
      if (mods.has(b.dataset.code)) mods.delete(b.dataset.code);
      else mods.add(b.dataset.code);
      b.classList.toggle('on', mods.has(b.dataset.code));
      return;
    }
    sendKey(b.dataset.code);
  });

  setMode(mode, false);

  return {
    live() {
      cur.x = 0.5; cur.y = 0.5;
      session.send({ t: 'm', x: cur.x, y: cur.y });
      applyZoom();
      showHint();
      keepAwake();
      history.pushState({ shackle: 1 }, '');
    },
    reset() {
      stopInertia();
      wakeLock?.release().catch(() => {});
      wakeLock = null;
      if (history.state?.shackle) history.back();
      zoom.s = 1;
      applyZoom();
      closeMenu();
      box.blur();
      cursorEl.hidden = true;
    },
    destroy() {
      stopInertia();
      cursorEl.remove();
      dock.remove();
      strip.remove();
      video.style.transform = '';
      viewer.classList.remove('touch-ui', 'menu-open', 'typing', 'mode-direct');
    },
  };
}

/** True on phones and tablets (a touch screen is the main pointer). */
export const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches;
