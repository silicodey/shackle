// Applies remote mouse and keyboard events to this computer.
// Events are queued so they are replayed strictly in order; consecutive pointer moves collapse.
const { screen } = require('electron');

let nut = null;
let loadError = null;
try {
  nut = require('@nut-tree-fork/nut-js');
  nut.mouse.config.autoDelayMs = 0;
  nut.mouse.config.mouseSpeed = 100000;
  nut.keyboard.config.autoDelayMs = 0;
} catch (e) {
  loadError = e;
  console.error('[shackle] input library failed to load:', e.message);
}

// KeyboardEvent.code → nut-js Key name
const KEYMAP = {
  Escape: 'Escape', Backquote: 'Grave', Minus: 'Minus', Equal: 'Equal', Backspace: 'Backspace', Tab: 'Tab',
  BracketLeft: 'LeftBracket', BracketRight: 'RightBracket', Backslash: 'Backslash', IntlBackslash: 'Backslash',
  Semicolon: 'Semicolon', Quote: 'Quote', Enter: 'Return', Comma: 'Comma', Period: 'Period', Slash: 'Slash',
  Space: 'Space', CapsLock: 'CapsLock',
  ShiftLeft: 'LeftShift', ShiftRight: 'RightShift', ControlLeft: 'LeftControl', ControlRight: 'RightControl',
  AltLeft: 'LeftAlt', AltRight: 'RightAlt', MetaLeft: 'LeftSuper', MetaRight: 'RightSuper', ContextMenu: 'Menu',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  PrintScreen: 'Print', ScrollLock: 'ScrollLock', Pause: 'Pause', NumLock: 'NumLock',
  NumpadDivide: 'Divide', NumpadMultiply: 'Multiply', NumpadSubtract: 'Subtract', NumpadAdd: 'Add',
  NumpadEnter: 'Enter', NumpadDecimal: 'Decimal', NumpadEqual: 'NumPadEqual',
  AudioVolumeMute: 'AudioMute', AudioVolumeDown: 'AudioVolDown', AudioVolumeUp: 'AudioVolUp',
  MediaPlayPause: 'AudioPlay', MediaStop: 'AudioStop', MediaTrackPrevious: 'AudioPrev', MediaTrackNext: 'AudioNext',
};
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') KEYMAP[`Key${c}`] = c;
for (let i = 0; i <= 9; i++) {
  KEYMAP[`Digit${i}`] = `Num${i}`;
  KEYMAP[`Numpad${i}`] = `NumPad${i}`;
}
for (let i = 1; i <= 24; i++) KEYMAP[`F${i}`] = `F${i}`;

function keyFor(code) {
  const name = KEYMAP[code];
  if (!name || !nut) return undefined;
  return nut.Key[name];
}

const BUTTONS = nut ? [nut.Button.LEFT, nut.Button.MIDDLE, nut.Button.RIGHT] : [];

const downKeys = new Set();
const downButtons = new Set();
let queue = [];
let running = false;

/** Maps a 0..1 position on a display to the coordinates the OS input API expects. */
function toScreenPoint(displayId, x, y) {
  const displays = screen.getAllDisplays();
  const d = displays.find((v) => String(v.id) === String(displayId)) || screen.getPrimaryDisplay();
  const nx = Math.min(1, Math.max(0, Number(x) || 0));
  const ny = Math.min(1, Math.max(0, Number(y) || 0));
  const dip = {
    x: Math.round(d.bounds.x + nx * (d.bounds.width - 1)),
    y: Math.round(d.bounds.y + ny * (d.bounds.height - 1)),
  };
  // Windows input uses physical pixels; macOS uses points (the same unit as Electron's DIPs).
  if (process.platform === 'win32') return screen.dipToScreenPoint(dip);
  if (process.platform === 'linux') {
    return { x: Math.round(dip.x * d.scaleFactor), y: Math.round(dip.y * d.scaleFactor) };
  }
  return dip;
}

async function apply(ev) {
  const { mouse, keyboard, Point } = nut;
  switch (ev.t) {
    case 'm':
      return mouse.setPosition(new Point(ev.px, ev.py));
    case 'd':
    case 'u': {
      const button = BUTTONS[ev.b];
      if (button === undefined) return;
      await mouse.setPosition(new Point(ev.px, ev.py));
      if (ev.t === 'd') {
        downButtons.add(button);
        return mouse.pressButton(button);
      }
      downButtons.delete(button);
      return mouse.releaseButton(button);
    }
    case 'w': {
      // Browser wheel deltas are in CSS pixels (about 100 per notch).
      const scale = process.platform === 'win32' ? 1.2 : process.platform === 'darwin' ? 1 : 0.03;
      const step = (v) => Math.max(1, Math.round(Math.abs(v) * scale));
      const dy = Math.max(-3000, Math.min(3000, Number(ev.dy) || 0));
      const dx = Math.max(-3000, Math.min(3000, Number(ev.dx) || 0));
      if (dy > 0) await mouse.scrollDown(step(dy));
      else if (dy < 0) await mouse.scrollUp(step(dy));
      if (dx > 0) await mouse.scrollRight(step(dx));
      else if (dx < 0) await mouse.scrollLeft(step(dx));
      return;
    }
    case 'k': {
      const key = keyFor(ev.c);
      if (key === undefined) return;
      if (ev.d) {
        downKeys.add(key);
        return keyboard.pressKey(key);
      }
      downKeys.delete(key);
      return keyboard.releaseKey(key);
    }
    case 'combo': {
      const keys = (Array.isArray(ev.codes) ? ev.codes.slice(0, 5) : []).map(keyFor).filter((k) => k !== undefined);
      if (!keys.length) return;
      await keyboard.pressKey(...keys);
      return keyboard.releaseKey(...keys.reverse());
    }
    case 'release': {
      for (const key of [...downKeys]) await keyboard.releaseKey(key).catch(() => {});
      for (const b of [...downButtons]) await mouse.releaseButton(b).catch(() => {});
      downKeys.clear();
      downButtons.clear();
      return;
    }
    default:
  }
}

async function drain() {
  if (running) return;
  running = true;
  while (queue.length) {
    const ev = queue.shift();
    try {
      await apply(ev);
    } catch (e) {
      console.error('[shackle] input event failed:', ev.t, e.message);
    }
  }
  running = false;
}

/** @param {object} ev control-channel input event  @param {string} displayId display being shared */
function handle(ev, displayId) {
  if (!nut || !ev || typeof ev.t !== 'string') return;
  if (ev.t === 'm' || ev.t === 'd' || ev.t === 'u') {
    const p = toScreenPoint(displayId, ev.x, ev.y);
    ev = { t: ev.t, b: Number(ev.b) | 0, px: p.x, py: p.y };
    const last = queue[queue.length - 1];
    if (ev.t === 'm' && last && last.t === 'm') {
      queue[queue.length - 1] = ev;
      return;
    }
  }
  if (queue.length > 2000) queue = queue.filter((e) => e.t !== 'm');
  queue.push(ev);
  drain();
}

function releaseAll() {
  queue = queue.filter((e) => e.t !== 'm');
  queue.push({ t: 'release' });
  drain();
}

module.exports = { handle, releaseAll, available: () => !!nut, loadError: () => loadError, KEYMAP };
