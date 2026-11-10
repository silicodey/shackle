// Remote session viewer: WebRTC peer, end-to-end password proof, input capture, clipboard, files.
import {
  PROTO_VERSION, FILE_CHUNK, MAX_FILE_BYTES, deriveKey, fingerprintOf, makeProof, sameProof,
  normalizeSupportPassword,
} from './proto.js';

const $ = (id) => document.getElementById(id);

const ERRORS = {
  offline: 'That computer is offline.',
  not_found: 'No computer is waiting with that ID.',
  busy: 'That computer is already in a session.',
  too_many_attempts: 'Too many attempts. Wait a few minutes and try again.',
  declined: 'The other person declined the connection.',
  timeout: 'Nobody answered the request.',
  locked: 'Too many wrong passwords. That computer is refusing connections for a few minutes.',
  no_password: 'Unattended access is not set up on that computer.',
  host_disconnected: 'The remote computer went offline.',
  host_ended: 'The session was ended on the remote computer.',
  host_replaced: 'The remote computer reconnected. Start a new session.',
  device_removed: 'That computer was removed from your account.',
  wrong_password: 'Wrong password.',
  connection_failed: 'The connection to the remote computer was lost.',
  setup_failed: 'The remote computer could not start the session.',
  capture_failed: 'The remote computer could not share its screen. Check its screen-recording permission.',
};

const KEY_COMBOS = [
  ['Windows / Command key', ['MetaLeft']],
  ['Alt + Tab', ['AltLeft', 'Tab']],
  ['Command + Tab', ['MetaLeft', 'Tab']],
  ['Ctrl + Shift + Esc (Task Manager)', ['ControlLeft', 'ShiftLeft', 'Escape']],
  ['Command + Space (Spotlight)', ['MetaLeft', 'Space']],
  ['Alt + F4', ['AltLeft', 'F4']],
  ['Command + Q', ['MetaLeft', 'KeyQ']],
  ['Print Screen', ['PrintScreen']],
];

let active = null;

/**
 * @param {{target: {deviceId?: string, code?: string}, password: string|null, name: string,
 *   askPassword: (error: string|null) => Promise<string|null>, onClose: (message: string|null) => void}} opts
 */
export function openSession(opts) {
  if (active) return;
  active = new Session(opts);
  active.start();
}

class Session {
  constructor(opts) {
    this.opts = opts;
    this.kind = opts.target.deviceId ? 'unattended' : 'support';
    this.password = opts.password;
    this.pending = [];
    this.live = false;
    this.closed = false;
    this.abort = new AbortController();
    this.incoming = null;
    this.sending = false;
    this.remoteClip = null;
  }

  /* ───────────── lifecycle ───────────── */
  start() {
    $('viewer').hidden = false;
    $('v-name').textContent = this.opts.name;
    $('v-stats').textContent = '';
    $('v-dot').className = 'dot warn';
    $('v-screen').hidden = true;
    $('v-quality').value = 'balanced';
    this.status('Connecting…');
    this.bindUi();

    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${scheme}//${location.host}/ws?role=viewer`);
    this.ws.onopen = () => this.sig({ type: 'connect', ...this.opts.target });
    this.ws.onmessage = (e) => this.onSignal(JSON.parse(e.data)).catch((err) => this.fail(err.message));
    this.ws.onclose = () => {
      if (!this.live && !this.closed) this.finish('Lost the connection to the server.');
    };
  }

  sig(obj) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  status(text, done = false) {
    const o = $('v-overlay');
    o.hidden = false;
    o.classList.toggle('done', done);
    $('v-status').textContent = text;
    $('v-cancel').textContent = done ? 'Close' : 'Cancel';
    $('stage').classList.remove('live');
  }

  fail(message) {
    console.error('[shackle]', message);
    this.finish(message);
  }

  /** Tear down and show a final message (or return to the dashboard when message is null). */
  finish(message) {
    if (this.closed) return;
    this.closed = true;
    this.live = false;
    clearInterval(this.statsTimer);
    try { this.control?.send(JSON.stringify({ t: 'bye' })); } catch {}
    if (this.sessionId) this.sig({ type: 'session-end', sessionId: this.sessionId });
    setTimeout(() => {
      try { this.pc?.close(); } catch {}
      try { this.ws?.close(); } catch {}
    }, 50);
    navigator.keyboard?.unlock?.();
    $('video').srcObject = null;
    if (message) {
      $('v-dot').className = 'dot off';
      this.status(message, true);
      this.finalMessage = message;
    } else {
      this.destroy();
    }
  }

  destroy() {
    this.abort.abort();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    $('viewer').hidden = true;
    $('toasts').replaceChildren();
    active = null;
    this.opts.onClose(null);
  }

  /* ───────────── signaling ───────────── */
  async onSignal(msg) {
    switch (msg.type) {
      case 'error':
        return this.finish(ERRORS[msg.code] || `Could not connect (${msg.code}).`);
      case 'connecting':
        this.sessionId = msg.sessionId;
        this.ice = msg.ice;
        $('v-name').textContent = msg.hostName || this.opts.name;
        this.status(this.kind === 'support' ? 'Waiting for the other person to allow access…' : 'Reaching the computer…');
        return;
      case 'rejected':
        this.sessionId = null;
        return this.finish(ERRORS[msg.reason] || 'The connection was refused.');
      case 'accepted':
        this.status('Establishing a secure connection…');
        return this.createPeer();
      case 'signal':
        return this.onPeerSignal(msg.data);
      case 'session-end':
        this.sessionId = null;
        return this.finish(ERRORS[msg.reason] || 'The session ended.');
      default:
    }
  }

  createPeer() {
    const pc = (this.pc = new RTCPeerConnection({ iceServers: this.ice }));
    pc.onicecandidate = (e) => e.candidate && this.sig({ type: 'signal', sessionId: this.sessionId, data: { candidate: e.candidate } });
    pc.ontrack = (e) => {
      const video = $('video');
      video.srcObject = e.streams[0] || new MediaStream([e.track]);
      video.play().catch(() => {});
    };
    pc.ondatachannel = (e) => {
      const ch = e.channel;
      if (ch.label === 'control') {
        this.control = ch;
        ch.onmessage = (ev) => this.onControl(JSON.parse(ev.data)).catch((err) => this.fail(err.message));
        ch.onclose = () => !this.closed && this.finish('The connection was lost.');
      } else if (ch.label === 'file') {
        this.fileCh = ch;
        ch.binaryType = 'arraybuffer';
        ch.bufferedAmountLowThreshold = 256 * 1024;
        ch.onmessage = (ev) => this.onFileData(ev.data);
      }
    };
    pc.onconnectionstatechange = () => {
      if (this.closed) return;
      if (pc.connectionState === 'failed') {
        this.finish(this.live ? 'The connection was lost.' : 'Could not reach the computer directly. A TURN relay may be needed (see the server README).');
      } else if (pc.connectionState === 'disconnected' && this.live) {
        $('v-dot').className = 'dot warn';
      } else if (pc.connectionState === 'connected' && this.live) {
        $('v-dot').className = 'dot on';
      }
    };
  }

  async onPeerSignal(data) {
    const pc = this.pc;
    if (!pc || !data) return;
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        this.sig({ type: 'signal', sessionId: this.sessionId, data: { sdp: pc.localDescription } });
      }
      for (const c of this.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
      else this.pending.push(data.candidate);
    }
  }

  /* ───────────── control channel ───────────── */
  send(obj) {
    if (this.control?.readyState === 'open') this.control.send(JSON.stringify(obj));
  }

  async onControl(msg) {
    switch (msg.t) {
      case 'challenge': {
        if (msg.v !== PROTO_VERSION) return this.finish('This host app is a different version. Update the host or the server.');
        if (this.password == null) {
          this.status('Waiting for password…');
          this.password = await this.opts.askPassword(this.authError || null);
          if (this.password == null) return this.finish(null);
          this.status('Checking password…');
        }
        const pw = this.kind === 'support' ? normalizeSupportPassword(this.password) : this.password;
        this.key = await deriveKey(pw, msg.salt, msg.iter);
        this.nonce = msg.nonce;
        this.hostFp = fingerprintOf(this.pc.remoteDescription.sdp);
        this.viewerFp = fingerprintOf(this.pc.localDescription.sdp);
        this.send({ t: 'auth', proof: await makeProof(this.key, 'viewer', this.nonce, this.hostFp, this.viewerFp) });
        return;
      }
      case 'auth-fail':
        this.password = null;
        this.authError = 'Wrong password. Try again.';
        return;
      case 'auth-ok': {
        const expected = await makeProof(this.key, 'host', this.nonce, this.hostFp, this.viewerFp);
        if (!sameProof(expected, msg.proof)) {
          return this.finish('Security check failed: the remote computer could not prove its identity. The session was stopped.');
        }
        this.authed = true;
        this.status('Starting the screen…');
        return;
      }
      case 'ready':
        if (!this.authed) return;
        this.setScreens(msg.screens, msg.current);
        this.goLive();
        return;
      case 'screens':
        return this.setScreens(msg.screens, msg.current);
      case 'clip':
        return this.onRemoteClipboard(String(msg.text || ''));
      case 'file-result':
        this.toast(msg.ok ? `Saved on the remote computer: ${msg.savedAs}` : `File transfer failed: ${msg.error}`, !msg.ok);
        return;
      case 'pull-result':
        if (!msg.ok && msg.error !== 'cancelled') this.toast(`Could not get the file: ${msg.error}`, true);
        return;
      case 'bye':
        this.sessionId = null;
        return this.finish(ERRORS[msg.reason] || 'The session ended.');
      default:
    }
  }

  goLive() {
    this.live = true;
    $('v-overlay').hidden = true;
    $('v-dot').className = 'dot on';
    $('stage').classList.add('live');
    $('stage').focus();
    this.statsTimer = setInterval(() => this.updateStats(), 2000);
  }

  setScreens(screens, current) {
    const sel = $('v-screen');
    sel.replaceChildren(...(screens || []).map((s) => new Option(`${s.label} · ${s.width}×${s.height}`, s.id)));
    sel.value = current;
    sel.hidden = !screens || screens.length < 2;
  }

  async updateStats() {
    if (!this.pc || this.closed) return;
    const stats = await this.pc.getStats().catch(() => null);
    if (!stats) return;
    let video, pair;
    stats.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') video = r;
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
    });
    const parts = [];
    if (video?.frameWidth) parts.push(`${video.frameWidth}×${video.frameHeight}`);
    if (video?.framesPerSecond != null) parts.push(`${Math.round(video.framesPerSecond)} fps`);
    if (pair?.currentRoundTripTime != null) parts.push(`${Math.round(pair.currentRoundTripTime * 1000)} ms`);
    if (pair) {
      const local = stats.get(pair.localCandidateId);
      const remote = stats.get(pair.remoteCandidateId);
      parts.push(local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relayed' : 'direct');
    }
    $('v-stats').textContent = parts.join(' · ');
  }

  /* ───────────── input ───────────── */
  bindUi() {
    const on = (el, type, fn, opts = {}) => el.addEventListener(type, fn, { signal: this.abort.signal, ...opts });
    const stage = $('stage');
    const video = $('video');

    const point = (e) => {
      const r = video.getBoundingClientRect();
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh || !r.width || !r.height) return null;
      const scale = Math.min(r.width / vw, r.height / vh);
      const w = vw * scale, h = vh * scale;
      const x = (e.clientX - r.left - (r.width - w) / 2) / w;
      const y = (e.clientY - r.top - (r.height - h) / 2) / h;
      return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
    };

    let pendingMove = null;
    const flushMove = () => {
      if (pendingMove) {
        this.send({ t: 'm', ...pendingMove });
        pendingMove = null;
      }
    };
    on(stage, 'pointermove', (e) => {
      if (!this.live) return;
      const p = point(e);
      if (!p) return;
      if (!pendingMove) requestAnimationFrame(flushMove);
      pendingMove = p;
    });
    on(stage, 'pointerdown', (e) => {
      if (!this.live) return;
      stage.focus();
      const p = point(e);
      if (!p) return;
      e.preventDefault();
      stage.setPointerCapture(e.pointerId);
      pendingMove = null;
      this.send({ t: 'd', b: e.button, ...p });
    });
    on(stage, 'pointerup', (e) => {
      if (!this.live) return;
      const p = point(e);
      if (!p) return;
      e.preventDefault();
      pendingMove = null;
      this.send({ t: 'u', b: e.button, ...p });
    });
    on(stage, 'contextmenu', (e) => e.preventDefault());
    on(stage, 'wheel', (e) => {
      if (!this.live) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1;
      this.send({ t: 'w', dx: Math.round(e.deltaX * unit), dy: Math.round(e.deltaY * unit) });
    }, { passive: false });

    const inBar = (e) => e.target instanceof Element && e.target.closest('.bar, dialog');
    on(window, 'keydown', (e) => {
      if (!this.live || inBar(e)) return;
      e.preventDefault();
      if (e.code) this.send({ t: 'k', c: e.code, d: 1 });
    });
    on(window, 'keyup', (e) => {
      if (!this.live || inBar(e)) return;
      e.preventDefault();
      if (e.code) this.send({ t: 'k', c: e.code, d: 0 });
    });
    // Never leave a key or button held down on the remote side when this tab loses focus.
    on(window, 'blur', () => this.send({ t: 'release' }));
    on(document, 'visibilitychange', () => document.hidden && this.send({ t: 'release' }));

    /* toolbar */
    on($('v-cancel'), 'click', () => (this.closed ? this.destroy() : this.finish(null)));
    on($('v-end'), 'click', () => this.finish(null));
    on($('v-screen'), 'change', (e) => { this.send({ t: 'screen', id: e.target.value }); stage.focus(); });
    on($('v-quality'), 'change', (e) => { this.send({ t: 'quality', level: e.target.value }); stage.focus(); });

    const keys = $('v-keys');
    keys.replaceChildren(new Option('Send keys…', ''), ...KEY_COMBOS.map(([label], i) => new Option(label, String(i))));
    on(keys, 'change', () => {
      if (keys.value !== '') this.send({ t: 'combo', codes: KEY_COMBOS[Number(keys.value)][1] });
      keys.value = '';
      stage.focus();
    });

    on($('v-clip'), 'click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (!text) return this.toast('Your clipboard has no text.');
        if (text.length > 100_000) return this.toast('That clipboard text is too large to send.', true);
        this.send({ t: 'clip', text });
        this.toast('Clipboard sent. Paste on the remote computer.');
      } catch {
        this.toast('The browser blocked clipboard access. Allow it for this site and try again.', true);
      }
      stage.focus();
    });

    on($('v-send'), 'click', () => $('file-input').click());
    on($('file-input'), 'change', (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) this.sendFile(file);
    });
    on($('v-pull'), 'click', () => {
      if (this.incoming) return this.toast('A download is already in progress.');
      this.send({ t: 'pull' });
      this.toast('Choose the file in the dialog on the remote screen.');
      stage.focus();
    });

    on($('v-full'), 'click', async () => {
      if (document.fullscreenElement) return document.exitFullscreen();
      await $('viewer').requestFullscreen().catch(() => {});
      // Chromium: route Esc, Alt+Tab, the Windows key etc. to the remote machine while full screen.
      navigator.keyboard?.lock?.().catch(() => {});
      stage.focus();
    });
    on(document, 'fullscreenchange', () => {
      $('v-full').textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
      if (!document.fullscreenElement) navigator.keyboard?.unlock?.();
    });
    on($('viewer'), 'mousemove', (e) => $('bar').classList.toggle('peek', e.clientY < 6));
  }

  /* ───────────── clipboard ───────────── */
  async onRemoteClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // No permission or focus: offer a click-to-copy toast instead.
      const t = this.toast('The remote clipboard changed. Click here to copy it.');
      t.style.cursor = 'pointer';
      t.onclick = () => navigator.clipboard.writeText(text).then(() => t.remove()).catch(() => {});
    }
  }

  /* ───────────── files ───────────── */
  async sendFile(file) {
    const ch = this.fileCh;
    if (!ch || ch.readyState !== 'open') return this.toast('File transfer is not available yet.', true);
    if (this.sending) return this.toast('Another file is still being sent.');
    if (file.size > MAX_FILE_BYTES) return this.toast('Files over 2 GB are not supported.', true);
    this.sending = true;
    const id = crypto.randomUUID();
    const t = this.toast(`Sending ${file.name}…`, false, true);
    const bar = t.querySelector('progress');
    try {
      ch.send(JSON.stringify({ t: 'start', id, name: file.name, size: file.size }));
      let offset = 0;
      while (offset < file.size) {
        if (this.closed || ch.readyState !== 'open') throw new Error('connection closed');
        if (ch.bufferedAmount > 1024 * 1024) {
          await new Promise((res) => { ch.onbufferedamountlow = () => { ch.onbufferedamountlow = null; res(); }; });
          continue;
        }
        const buf = await file.slice(offset, offset + FILE_CHUNK).arrayBuffer();
        ch.send(buf);
        offset += buf.byteLength;
        bar.value = offset / file.size;
      }
      ch.send(JSON.stringify({ t: 'end', id }));
      t.firstChild.textContent = `Sent ${file.name}. Waiting for confirmation…`;
      setTimeout(() => t.remove(), 3000);
    } catch (e) {
      t.remove();
      this.toast(`Could not send ${file.name}: ${e.message}`, true);
    } finally {
      this.sending = false;
    }
  }

  onFileData(data) {
    if (typeof data === 'string') {
      const msg = JSON.parse(data);
      if (msg.t === 'start') {
        const size = Number(msg.size) || 0;
        if (size > MAX_FILE_BYTES) return;
        const toast = this.toast(`Downloading ${msg.name}…`, false, true);
        this.incoming = { id: msg.id, name: String(msg.name || 'download'), size, got: 0, chunks: [], toast };
      } else if (msg.t === 'end' && this.incoming?.id === msg.id) {
        const inc = this.incoming;
        this.incoming = null;
        const url = URL.createObjectURL(new Blob(inc.chunks));
        const a = document.createElement('a');
        a.href = url;
        a.download = inc.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        inc.toast.remove();
        this.toast(`Downloaded ${inc.name}`);
      } else if (msg.t === 'abort' && this.incoming?.id === msg.id) {
        this.incoming.toast.remove();
        this.incoming = null;
        this.toast('The download was interrupted.', true);
      }
    } else if (this.incoming) {
      const inc = this.incoming;
      inc.got += data.byteLength;
      if (inc.got > inc.size) {
        inc.toast.remove();
        this.incoming = null;
        return;
      }
      inc.chunks.push(data);
      inc.toast.querySelector('progress').value = inc.size ? inc.got / inc.size : 0;
    }
  }

  toast(text, bad = false, progress = false) {
    const t = document.createElement('div');
    t.className = `toast${bad ? ' bad' : ''}`;
    t.append(document.createTextNode(text));
    if (progress) {
      const p = document.createElement('progress');
      p.max = 1;
      p.value = 0;
      t.append(p);
    } else {
      setTimeout(() => t.remove(), bad ? 9000 : 5000);
    }
    $('toasts').append(t);
    return t;
  }
}
