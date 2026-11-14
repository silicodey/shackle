// Shackle host engine: runs in a hidden window. Keeps the signaling socket open, answers session
// requests, verifies the viewer's password end to end, then streams the screen and relays input.
import {
  PROTO_VERSION, PBKDF2_ITERATIONS, FILE_CHUNK, MAX_FILE_BYTES, deriveKey, fingerprintOf, makeProof, sameProof,
  randomB64, newSupportPassword,
} from './proto.js';

const T = window.shackle;

let cfg = null;
let ws = null;
let retryMs = 1000;
let lastPong = 0;
let support = null; // { password, salt, iter, key }: one-time credentials for attended sessions
let supportFailures = 0;
let session = null;
let requestPending = false;
let recentRequests = [];
const lockout = { fails: [], until: 0 };

const QUALITY = {
  balanced: { bitrate: 6_000_000, fps: 30, hint: 'detail', degrade: 'maintain-resolution', scale: 1 },
  sharp: { bitrate: 10_000_000, fps: 20, hint: 'text', degrade: 'maintain-resolution', scale: 1 },
  smooth: { bitrate: 8_000_000, fps: 30, hint: 'motion', degrade: 'maintain-framerate', scale: 1 },
  low: { bitrate: 1_200_000, fps: 15, hint: 'detail', degrade: 'balanced', scale: 1.5 },
};

const log = (...a) => console.log('[engine]', ...a);
const send = (obj) => (ws && ws.readyState === 1 ? (ws.send(JSON.stringify(obj)), true) : false);

async function newSupport() {
  const password = newSupportPassword();
  const salt = randomB64(16);
  support = { password, salt, iter: PBKDF2_ITERATIONS, key: await deriveKey(password, salt, PBKDF2_ITERATIONS) };
  supportFailures = 0;
  T.setState({ supportPassword: password });
}

/* ───────────── signaling socket ───────────── */
function connect() {
  if (!cfg.serverUrl) {
    T.setState({ connection: 'offline', code: null, error: 'no_server' });
    return;
  }
  T.setState({ connection: 'connecting', error: null });
  try {
    ws = new WebSocket(`${cfg.serverUrl.replace(/^http/i, 'ws')}/ws?role=host`);
  } catch {
    T.setState({ connection: 'offline', code: null, error: 'bad_server' });
    return;
  }
  const sock = ws;
  sock.onopen = () => {
    lastPong = Date.now();
    send({
      type: 'hello', name: cfg.name, platform: cfg.platform, version: cfg.version,
      deviceId: cfg.device?.id, token: cfg.device?.token,
    });
  };
  sock.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    onServer(msg).catch((err) => log('server message failed:', err.message));
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    endSession('host_disconnected', false);
    T.setState({ connection: 'offline', code: null, error: 'unreachable' });
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 30_000);
  };
  sock.onerror = () => {};
}

setInterval(() => {
  if (!ws || ws.readyState !== 1) return;
  if (Date.now() - lastPong > 70_000) return ws.close();
  send({ type: 'ping' });
}, 25_000);

async function onServer(msg) {
  switch (msg.type) {
    case 'registered':
      retryMs = 1000;
      if (msg.deviceError === 'unknown_device') {
        // This computer was removed from the account on the server.
        await T.clearDevice();
        cfg = await T.getConfig();
      }
      if (!support) await newSupport();
      T.setState({ connection: 'online', code: msg.code, error: null });
      return;
    case 'code':
      return T.setState({ code: msg.code });
    case 'pong':
      lastPong = Date.now();
      return;
    case 'ticket':
      return T.ticket(msg.reqId, msg.ticket || null);
    case 'unenrolled':
      await T.clearDevice();
      cfg = await T.getConfig();
      return;
    case 'session-request':
      return onRequest(msg);
    case 'signal':
      if (session && session.id === msg.sessionId) return onPeerSignal(session, msg.data);
      return;
    case 'session-end':
      if (session && session.id === msg.sessionId) endSession(msg.reason || 'viewer_ended', false);
      return;
    default:
  }
}

/* ───────────── session setup ───────────── */
async function onRequest(msg) {
  const reject = (reason) => send({ type: 'session-response', sessionId: msg.sessionId, accept: false, reason });
  if (session || requestPending) return reject('busy');
  requestPending = true;
  try {
    let creds;
    if (msg.kind === 'unattended') {
      if (!cfg.unattended) return reject('no_password');
      if (Date.now() < lockout.until) return reject('locked');
      creds = cfg.unattended;
    } else {
      if (!support) return reject('busy');
      // Flood guard: a stranger hammering this ID cannot keep the app busy indefinitely.
      const t = Date.now();
      recentRequests = recentRequests.filter((x) => t - x < 60_000);
      if (recentRequests.length >= 6) return reject('busy');
      recentRequests.push(t);
      // No prompt yet: the person at this computer is only asked AFTER the caller has proven
      // they know the password, so strangers guessing IDs can never make a prompt appear.
      creds = support;
    }
    send({ type: 'session-response', sessionId: msg.sessionId, accept: true });
    await startPeer(msg, creds);
  } catch (e) {
    log('session setup failed:', e.message);
    if (session && session.id === msg.sessionId) endSession('setup_failed');
    else reject('setup_failed');
  } finally {
    requestPending = false;
  }
}

async function startPeer(msg, creds) {
  const pc = new RTCPeerConnection({ iceServers: msg.ice || [] });
  const s = (session = {
    id: msg.sessionId, kind: msg.kind, viewer: msg.viewer, creds, pc,
    authed: false, attempts: 0, verifying: false, pending: [], displayId: null, stream: null, quality: 'balanced',
    control: pc.createDataChannel('control'),
    file: pc.createDataChannel('file'),
    tx: pc.addTransceiver('video', { direction: 'sendonly' }),
    rxFile: null, pulling: false, timers: [],
  });
  s.file.binaryType = 'arraybuffer';
  s.file.bufferedAmountLowThreshold = 256 * 1024;

  pc.onicecandidate = (e) => e.candidate && send({ type: 'signal', sessionId: s.id, data: { candidate: e.candidate } });
  pc.onconnectionstatechange = () => {
    if (session !== s) return;
    clearTimeout(s.dropTimer);
    if (pc.connectionState === 'failed') endSession('connection_failed');
    else if (pc.connectionState === 'disconnected') s.dropTimer = setTimeout(() => endSession('connection_failed'), 20_000);
    else if (pc.connectionState === 'connected') applyQuality(s);
  };
  s.control.onopen = () => challenge(s);
  s.control.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    onControl(s, m).catch((err) => log('control message failed:', err.message));
  };
  s.control.onclose = () => session === s && endSession('viewer_ended');
  s.file.onmessage = (e) => onFileData(s, e.data);

  await pc.setLocalDescription(await pc.createOffer());
  send({ type: 'signal', sessionId: s.id, data: { sdp: pc.localDescription } });
  // The viewer may be typing a password; give them time, but not forever.
  s.timers.push(setTimeout(() => session === s && !s.authed && endSession('timeout'), 180_000));
}

async function onPeerSignal(s, data) {
  if (!data) return;
  if (data.sdp) {
    if (data.sdp.type !== 'answer') return;
    await s.pc.setRemoteDescription(data.sdp);
    for (const c of s.pending.splice(0)) await s.pc.addIceCandidate(c).catch(() => {});
  } else if (data.candidate) {
    if (s.pc.remoteDescription) await s.pc.addIceCandidate(data.candidate).catch(() => {});
    else s.pending.push(data.candidate);
  }
}

const ctrl = (s, obj) => s.control.readyState === 'open' && s.control.send(JSON.stringify(obj));

function challenge(s) {
  s.nonce = randomB64(24);
  ctrl(s, { t: 'challenge', v: PROTO_VERSION, nonce: s.nonce, salt: s.creds.salt, iter: s.creds.iter });
}

/* ───────────── control channel ───────────── */
async function onControl(s, msg) {
  if (session !== s || !msg || typeof msg.t !== 'string') return;
  if (msg.t === 'bye') return endSession('viewer_ended');

  if (!s.authed) {
    if (msg.t !== 'auth' || s.verifying) return;
    s.verifying = true;
    const hostFp = fingerprintOf(s.pc.localDescription.sdp);
    const viewerFp = fingerprintOf(s.pc.remoteDescription.sdp);
    const expected = await makeProof(s.creds.key, 'viewer', s.nonce, hostFp, viewerFp);
    const ok = sameProof(expected, msg.proof);
    const hostProof = ok ? await makeProof(s.creds.key, 'host', s.nonce, hostFp, viewerFp) : null;
    s.verifying = false;
    if (session !== s) return;

    if (!ok) {
      s.attempts += 1;
      let reason = 'too_many_attempts';
      if (s.kind === 'unattended') {
        const now = Date.now();
        lockout.fails = lockout.fails.filter((t) => now - t < 10 * 60_000);
        lockout.fails.push(now);
        if (lockout.fails.length >= 8) {
          lockout.until = now + 10 * 60_000;
          lockout.fails = [];
          reason = 'locked';
        }
      } else {
        supportFailures += 1;
      }
      if (s.attempts >= 3 || reason === 'locked' || supportFailures >= 5) return endSession(reason);
      ctrl(s, { t: 'auth-fail', remaining: 3 - s.attempts });
      return challenge(s);
    }

    if (s.kind === 'support') {
      s.verifying = true;
      s.consenting = true;
      ctrl(s, { t: 'awaiting-consent' });
      const allowed = await T.confirmSession(s.viewer);
      s.consenting = false;
      s.verifying = false;
      if (session !== s) return;
      if (!allowed) return endSession('declined');
    }
    s.authed = true;
    lockout.fails = [];
    ctrl(s, { t: 'auth-ok', proof: hostProof });
    T.setSession({ viewer: s.viewer, kind: s.kind });
    try {
      const screens = await capture(s, null);
      ctrl(s, { t: 'ready', screens, current: s.displayId, platform: cfg.platform, name: cfg.name });
    } catch (e) {
      log('capture failed:', e.message);
      endSession('capture_failed');
    }
    return;
  }

  switch (msg.t) {
    case 'm': case 'd': case 'u': case 'w': case 'k': case 'combo': case 'release':
      return T.input(msg, s.displayId);
    case 'clip':
      if (typeof msg.text === 'string') T.clipboardWrite(msg.text);
      return;
    case 'screen': {
      const screens = await capture(s, String(msg.id)).catch((e) => (log('screen switch failed:', e.message), null));
      if (screens) ctrl(s, { t: 'screens', screens, current: s.displayId });
      return;
    }
    case 'quality':
      if (Object.hasOwn(QUALITY, msg.level)) {
        s.quality = msg.level;
        await applyQuality(s);
      }
      return;
    case 'pull':
      return pullFile(s);
    default:
  }
}

/* ───────────── screen capture ───────────── */
async function capture(s, displayId) {
  const screens = await T.getScreens();
  if (!screens.length) throw new Error('no screens available');
  const target = screens.find((d) => d.id === displayId) || screens.find((d) => d.primary) || screens[0];
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: target.sourceId,
        maxWidth: Math.min(target.width, 3840),
        maxHeight: Math.min(target.height, 2160),
        maxFrameRate: 30,
      },
    },
  });
  if (session !== s) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('session ended');
  }
  const track = stream.getVideoTracks()[0];
  await s.tx.sender.replaceTrack(track);
  s.stream?.getTracks().forEach((t) => t.stop());
  s.stream = stream;
  s.displayId = target.id;
  await applyQuality(s);
  return screens.map(({ id, label, width, height, primary }) => ({ id, label, width, height, primary }));
}

async function applyQuality(s) {
  const q = QUALITY[s.quality];
  const track = s.stream?.getVideoTracks()[0];
  if (!track) return;
  try {
    track.contentHint = q.hint;
    const params = s.tx.sender.getParameters();
    if (!params.encodings || !params.encodings.length) return;
    params.encodings[0].maxBitrate = q.bitrate;
    params.encodings[0].maxFramerate = q.fps;
    params.encodings[0].scaleResolutionDownBy = q.scale;
    params.degradationPreference = q.degrade;
    await s.tx.sender.setParameters(params);
  } catch (e) {
    log('quality not applied:', e.message);
  }
}

/* ───────────── files ───────────── */
function onFileData(s, data) {
  if (session !== s || !s.authed) return;
  if (typeof data === 'string') {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.t === 'start' && typeof msg.id === 'string') {
      s.rxFile = msg.id;
      T.file({ op: 'start', id: msg.id, name: String(msg.name || 'file'), size: Number(msg.size) });
    } else if (msg.t === 'end' && msg.id === s.rxFile) {
      s.rxFile = null;
      T.file({ op: 'end', id: msg.id });
    }
  } else if (s.rxFile) {
    T.file({ op: 'chunk', id: s.rxFile, data });
  }
}

T.onFileResult((r) => session?.authed && ctrl(session, { t: 'file-result', id: r.id, ok: r.ok, savedAs: r.savedAs, error: r.error }));

async function pullFile(s) {
  if (s.pulling) return;
  s.pulling = true;
  let picked = null;
  try {
    picked = await T.pullPick();
    if (!picked.ok) return ctrl(s, { t: 'pull-result', ok: false, error: picked.error });
    if (picked.size > MAX_FILE_BYTES) return ctrl(s, { t: 'pull-result', ok: false, error: 'file is larger than 2 GB' });
    const ch = s.file;
    ch.send(JSON.stringify({ t: 'start', id: picked.id, name: picked.name, size: picked.size }));
    let offset = 0;
    while (offset < picked.size) {
      if (session !== s || ch.readyState !== 'open') throw new Error('session ended');
      if (ch.bufferedAmount > 1024 * 1024) {
        await new Promise((res) => { ch.onbufferedamountlow = () => { ch.onbufferedamountlow = null; res(); }; });
        continue;
      }
      const chunk = await T.pullRead(picked.id, offset, FILE_CHUNK);
      if (!chunk || !chunk.byteLength) throw new Error('file changed while reading');
      ch.send(chunk);
      offset += chunk.byteLength;
    }
    ch.send(JSON.stringify({ t: 'end', id: picked.id }));
    ctrl(s, { t: 'pull-result', ok: true });
  } catch (e) {
    if (picked?.ok && s.file.readyState === 'open') s.file.send(JSON.stringify({ t: 'abort', id: picked.id }));
    ctrl(s, { t: 'pull-result', ok: false, error: e.message });
  } finally {
    if (picked?.ok) T.pullClose(picked.id);
    s.pulling = false;
  }
}

/* ───────────── teardown ───────────── */
function endSession(reason, notifyServer = true) {
  const s = session;
  if (!s) return;
  session = null;
  s.timers.forEach(clearTimeout);
  clearTimeout(s.dropTimer);
  try { ctrl(s, { t: 'bye', reason }); } catch {}
  if (notifyServer) send({ type: 'session-end', sessionId: s.id, reason });
  s.stream?.getTracks().forEach((t) => t.stop());
  setTimeout(() => { try { s.pc.close(); } catch {} }, 150);
  if (s.consenting) T.cancelConfirm();
  if (s.authed) T.setSession(null);
  // Support credentials are single use: rotate after any real session or repeated wrong guesses.
  if (s.kind === 'support' && (s.authed || supportFailures >= 5)) {
    newSupport().then(() => send({ type: 'new-code' }));
  }
}

T.onEndSession(() => endSession('host_ended'));
T.onNewCode(() => {
  if (session) return;
  newSupport().then(() => send({ type: 'new-code' }));
});
T.onTicketRequest((reqId) => {
  if (!send({ type: 'viewer-ticket', reqId })) T.ticket(reqId, null);
});
T.onConfigRefresh(async () => { cfg = await T.getConfig(); });
T.onClipboard((text) => session?.authed && ctrl(session, { t: 'clip', text }));
window.addEventListener('beforeunload', () => endSession('host_ended'));

cfg = await T.getConfig();
connect();
