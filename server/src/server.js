// Shackle server: accounts, device registry, WebRTC signaling and the web client.
// Media never passes through this process. It only introduces the two peers.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { openDb } from './db.js';
import {
  now, randomToken, sha256, safeEqual, hashPassword, verifyPassword, verifyTotp, newTotpSecret,
  turnCredentials, RateLimiter, randomDigits, isEmail, cleanName,
} from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '1.0.0';

const cfg = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '0.0.0.0',
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  trustProxy: process.env.TRUST_PROXY === '1',
  stunUrls: (process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302').split(',').map((s) => s.trim()).filter(Boolean),
  turnUrls: (process.env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean),
  turnSecret: process.env.TURN_SECRET || '',
  sessionDays: 30,
  // Optional, for hosts without persistent storage (free tiers): see README "Free hosting".
  ownerEmail: (process.env.OWNER_EMAIL || '').trim(),
  ownerPassword: process.env.OWNER_PASSWORD || '',
  secretKey: process.env.SECRET_KEY || '',
};

const { s } = openDb(cfg.dataDir);
const limiter = new RateLimiter();
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const COOKIE = 'shackle_sid';

/* ------------------------------------------------------------------ */
/* first-run setup code                                                */
/* ------------------------------------------------------------------ */
function needsSetup() {
  return s.userCount.get().n === 0;
}
// Storage-less hosting: recreate the owner account from the environment on every fresh start.
if (needsSetup() && cfg.ownerEmail && cfg.ownerPassword) {
  if (!isEmail(cfg.ownerEmail) || cfg.ownerPassword.length < 10) {
    console.error('OWNER_EMAIL must be an email address and OWNER_PASSWORD at least 10 characters. Ignoring both.');
  } else {
    s.userInsert.run(cfg.ownerEmail, await hashPassword(cfg.ownerPassword), now());
    console.log(`Owner account ${cfg.ownerEmail} created from OWNER_EMAIL / OWNER_PASSWORD.`);
  }
}

// With SECRET_KEY set, device tokens are signed and self-describing, so an enrolled computer can
// re-register itself after the database has been wiped.
function signDeviceToken(id, email, name, platform) {
  const body = Buffer.from(JSON.stringify({ u: email, n: name, p: platform })).toString('base64url');
  const mac = crypto.createHmac('sha256', cfg.secretKey).update(`v1.${id}.${body}`).digest('base64url');
  return `v1.${id}.${body}.${mac}`;
}
function readDeviceToken(token) {
  if (!cfg.secretKey) return null;
  const parts = String(token).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const mac = crypto.createHmac('sha256', cfg.secretKey).update(`v1.${parts[1]}.${parts[2]}`).digest('base64url');
  if (!safeEqual(mac, parts[3])) return null;
  try {
    const d = JSON.parse(Buffer.from(parts[2], 'base64url').toString('utf8'));
    return { id: parts[1], email: String(d.u), name: cleanName(d.n), platform: String(d.p) };
  } catch {
    return null;
  }
}

if (needsSetup()) {
  let code = s.metaGet.get('setup_code')?.value;
  if (!code) {
    code = randomToken(9);
    s.metaSet.run('setup_code', code);
  }
  console.log('\n==============================================================');
  console.log(' Shackle first-run setup');
  console.log(` Open the web client and enter this setup code:  ${code}`);
  console.log('==============================================================\n');
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */
function clientIp(req) {
  if (cfg.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function isSecure(req) {
  if (req.socket.encrypted) return true;
  return cfg.trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function expectedOrigins(req) {
  const list = [];
  if (cfg.publicUrl) list.push(cfg.publicUrl);
  const host = req.headers.host;
  if (host) list.push(`http://${host}`, `https://${host}`);
  return list;
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  return expectedOrigins(req).includes(origin);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const row = s.sessGet.get(sha256(token));
  if (!row || row.expires_at < now()) return null;
  const user = s.userById.get(row.user_id);
  return user ? { user, tokenHash: row.token_hash } : null;
}

function setSessionCookie(req, res, userId) {
  const token = randomToken(32);
  const maxAge = cfg.sessionDays * 86400;
  s.sessInsert.run(sha256(token), userId, now(), now() + maxAge * 1000);
  const flags = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
  if (isSecure(req)) flags.push('Secure');
  res.setHeader('Set-Cookie', flags.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

function audit(userId, event, detail = '') {
  try {
    s.auditInsert.run(now(), userId ?? null, event, String(detail).slice(0, 300));
  } catch (e) {
    console.error('audit failed', e.message);
  }
}

function iceServers(label) {
  const list = [];
  if (cfg.stunUrls.length) list.push({ urls: cfg.stunUrls });
  if (cfg.turnUrls.length && cfg.turnSecret) {
    list.push({ urls: cfg.turnUrls, ...turnCredentials(cfg.turnSecret, 6 * 3600, label) });
  }
  return list;
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      return reject(Object.assign(new Error('json required'), { status: 415 }));
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('object expected');
        resolve(v);
      } catch {
        reject(Object.assign(new Error('bad json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const fail = (status, error) => Object.assign(new Error(error), { status, expose: true });

/** Checks email + password (+ TOTP when enabled). Throws an exposable error on failure. */
async function authenticate(req, body) {
  const ip = clientIp(req);
  const email = String(body.email || '').trim();
  if (!limiter.hit(`login:${ip}`, 30, 15 * 60_000) || !limiter.hit(`login:${email.toLowerCase()}`, 10, 15 * 60_000)) {
    throw fail(429, 'too_many_attempts');
  }
  const user = isEmail(email) ? s.userByEmail.get(email) : null;
  // Always run a hash so response time does not reveal whether the account exists.
  const ok = await verifyPassword(String(body.password || ''), user?.pass_hash || DUMMY_HASH);
  if (!user || !ok) {
    audit(user?.id, 'login_failed', ip);
    throw fail(401, 'invalid_credentials');
  }
  if (user.totp_enabled) {
    if (!body.totp) throw fail(401, 'totp_required');
    if (!verifyTotp(user.totp_secret, body.totp)) {
      audit(user.id, 'login_failed_2fa', ip);
      throw fail(401, 'invalid_totp');
    }
  }
  limiter.clear(`login:${email.toLowerCase()}`);
  return user;
}

const DUMMY_HASH = await hashPassword(randomToken(12));

function validPassword(p) {
  return typeof p === 'string' && p.length >= 10 && p.length <= 200;
}

/* ------------------------------------------------------------------ */
/* HTTP API                                                            */
/* ------------------------------------------------------------------ */
async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const mutating = req.method !== 'GET';

  if (route === 'GET /api/state') {
    const sess = sessionUser(req);
    return send(res, 200, {
      version: VERSION,
      needsSetup: needsSetup(),
      user: sess ? { email: sess.user.email, totpEnabled: !!sess.user.totp_enabled } : null,
    });
  }

  // Device enrollment is called by the host app, not a browser: no cookie, no Origin.
  if (route === 'POST /api/enroll') {
    const body = await readJson(req);
    const user = await authenticate(req, body);
    let id;
    do id = randomDigits(9); while (s.devGet.get(id));
    const name = cleanName(body.name);
    const platform = ['win32', 'darwin', 'linux'].includes(body.platform) ? body.platform : 'unknown';
    const token = cfg.secretKey ? signDeviceToken(id, user.email, name, platform) : randomToken(32);
    s.devInsert.run(id, user.id, name, platform, sha256(token), now());
    audit(user.id, 'device_enrolled', `${name} (${id})`);
    return send(res, 200, { deviceId: id, deviceToken: token, account: user.email });
  }

  // Everything below is browser-facing: cookie auth, so require a same-origin request.
  if (mutating && !originAllowed(req)) throw fail(403, 'bad_origin');

  if (route === 'POST /api/setup') {
    if (!needsSetup()) throw fail(409, 'already_set_up');
    if (!limiter.hit(`setup:${clientIp(req)}`, 10, 15 * 60_000)) throw fail(429, 'too_many_attempts');
    const body = await readJson(req);
    const code = s.metaGet.get('setup_code')?.value;
    if (!code || !safeEqual(String(body.code || '').trim(), code)) throw fail(403, 'invalid_setup_code');
    if (!isEmail(body.email)) throw fail(400, 'invalid_email');
    if (!validPassword(body.password)) throw fail(400, 'weak_password');
    const info = s.userInsert.run(body.email.trim(), await hashPassword(body.password), now());
    s.metaDel.run('setup_code');
    audit(Number(info.lastInsertRowid), 'account_created', clientIp(req));
    setSessionCookie(req, res, Number(info.lastInsertRowid));
    return send(res, 200, { ok: true });
  }

  if (route === 'POST /api/login') {
    const body = await readJson(req);
    const user = await authenticate(req, body);
    setSessionCookie(req, res, user.id);
    audit(user.id, 'login', clientIp(req));
    return send(res, 200, { ok: true });
  }

  const sess = sessionUser(req);
  if (!sess) throw fail(401, 'not_signed_in');
  const { user } = sess;

  if (route === 'POST /api/logout') {
    s.sessDel.run(sess.tokenHash);
    clearSessionCookie(res);
    return send(res, 200, { ok: true });
  }

  if (route === 'POST /api/password') {
    const body = await readJson(req);
    if (!limiter.hit(`pw:${user.id}`, 10, 15 * 60_000)) throw fail(429, 'too_many_attempts');
    if (!(await verifyPassword(String(body.current || ''), user.pass_hash))) throw fail(401, 'invalid_credentials');
    if (!validPassword(body.next)) throw fail(400, 'weak_password');
    s.userSetPass.run(await hashPassword(body.next), user.id);
    s.sessDelUserExcept.run(user.id, sess.tokenHash);
    audit(user.id, 'password_changed');
    return send(res, 200, { ok: true });
  }

  if (route === 'POST /api/totp/begin') {
    if (user.totp_enabled) throw fail(409, 'already_enabled');
    const secret = newTotpSecret();
    s.userSetTotp.run(secret, 0, user.id);
    const label = encodeURIComponent(`Shackle:${user.email}`);
    return send(res, 200, { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=Shackle` });
  }

  if (route === 'POST /api/totp/enable') {
    const body = await readJson(req);
    if (user.totp_enabled) throw fail(409, 'already_enabled');
    if (!user.totp_secret || !verifyTotp(user.totp_secret, body.code)) throw fail(400, 'invalid_totp');
    s.userSetTotp.run(user.totp_secret, 1, user.id);
    audit(user.id, '2fa_enabled');
    return send(res, 200, { ok: true });
  }

  if (route === 'POST /api/totp/disable') {
    const body = await readJson(req);
    if (!limiter.hit(`pw:${user.id}`, 10, 15 * 60_000)) throw fail(429, 'too_many_attempts');
    if (!(await verifyPassword(String(body.password || ''), user.pass_hash))) throw fail(401, 'invalid_credentials');
    s.userSetTotp.run(null, 0, user.id);
    audit(user.id, '2fa_disabled');
    return send(res, 200, { ok: true });
  }

  if (route === 'GET /api/devices') {
    const devices = s.devList.all(user.id).map((d) => ({
      id: d.id, name: d.name, platform: d.platform, lastSeen: d.last_seen,
      online: deviceHosts.has(d.id), busy: !!deviceHosts.get(d.id)?.sessionId,
    }));
    return send(res, 200, { devices });
  }

  const dev = url.pathname.match(/^\/api\/devices\/(\d{9})$/);
  if (dev && req.method === 'PATCH') {
    const body = await readJson(req);
    const r = s.devRename.run(cleanName(body.name), dev[1], user.id);
    if (!r.changes) throw fail(404, 'not_found');
    return send(res, 200, { ok: true });
  }
  if (dev && req.method === 'DELETE') {
    const r = s.devDelete.run(dev[1], user.id);
    if (!r.changes) throw fail(404, 'not_found');
    audit(user.id, 'device_removed', dev[1]);
    const host = deviceHosts.get(dev[1]);
    if (host) {
      deviceHosts.delete(dev[1]);
      if (host.sessionId) endSession(host.sessionId, 'device_removed');
      host.deviceId = null;
      host.userId = null;
      wsSend(host.ws, { type: 'unenrolled' });
    }
    return send(res, 200, { ok: true });
  }

  if (route === 'GET /api/audit') {
    return send(res, 200, { events: s.auditList.all(user.id) });
  }

  throw fail(404, 'not_found');
}

/* ------------------------------------------------------------------ */
/* static files                                                        */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; " +
    "connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'forbidden' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (isSecure(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return send(res, 400, { error: 'bad_request' });
  }
  try {
    if (url.pathname === '/healthz') return send(res, 200, { ok: true, version: VERSION });
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method_not_allowed' });
    return serveStatic(req, res, url);
  } catch (e) {
    if (!e.expose && !e.status) console.error('request failed:', e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.expose || e.status ? e.message : 'server_error' });
  }
});

/* ------------------------------------------------------------------ */
/* signaling                                                           */
/* ------------------------------------------------------------------ */
/** @typedef {{ws: import('ws').WebSocket, id: string, ip: string, deviceId: string|null, userId: number|null,
 *   code: string|null, name: string, platform: string, sessionId: string|null, ready: boolean}} HostConn */

/** @type {Map<string, HostConn>} */ const deviceHosts = new Map();
/** @type {Map<string, HostConn>} */ const codeHosts = new Map();
/** @type {Map<string, {id: string, host: HostConn, viewer: any, kind: string, startedAt: number, accepted: boolean}>} */
const sessions = new Map();
const hostsPerIp = new Map();

function wsSend(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function newSupportCode(host) {
  if (host.code) codeHosts.delete(host.code);
  let code;
  do code = randomDigits(9); while (codeHosts.has(code));
  host.code = code;
  codeHosts.set(code, host);
  return code;
}

function endSession(sessionId, reason, from) {
  const sess = sessions.get(sessionId);
  if (!sess) return;
  sessions.delete(sessionId);
  sess.host.sessionId = null;
  sess.viewer.sessionId = null;
  if (from !== 'host') wsSend(sess.host.ws, { type: 'session-end', sessionId, reason });
  if (from !== 'viewer') wsSend(sess.viewer.ws, { type: 'session-end', sessionId, reason });
  if (sess.accepted) {
    const secs = Math.round((now() - sess.startedAt) / 1000);
    audit(sess.viewer.userId, 'session_ended', `${sess.host.name} · ${secs}s · ${reason}`);
  }
}

function handleHostMessage(host, msg) {
  switch (msg.type) {
    case 'hello': {
      if (host.ready) return;
      host.name = cleanName(msg.name);
      host.platform = ['win32', 'darwin', 'linux'].includes(msg.platform) ? msg.platform : 'unknown';
      let deviceOk = false;
      let deviceError = null;
      if (msg.deviceId && msg.token) {
        let row = s.devGet.get(String(msg.deviceId));
        if (!row) {
          // Database was reset: accept a validly signed token and restore the device record.
          const t = readDeviceToken(msg.token);
          const owner = t && t.id === String(msg.deviceId) && /^\d{9}$/.test(t.id) ? s.userByEmail.get(t.email) : null;
          if (owner) {
            s.devInsert.run(t.id, owner.id, t.name, t.platform, sha256(String(msg.token)), now());
            row = s.devGet.get(t.id);
          }
        }
        if (row && safeEqual(row.token_hash, sha256(String(msg.token)))) {
          const prev = deviceHosts.get(row.id);
          if (prev && prev !== host) {
            if (prev.sessionId) endSession(prev.sessionId, 'host_replaced');
            prev.deviceId = null;
            prev.ws.close(4001, 'replaced');
          }
          host.deviceId = row.id;
          host.userId = row.user_id;
          host.name = row.name;
          deviceHosts.set(row.id, host);
          s.devSeen.run(now(), row.id);
          deviceOk = true;
        } else {
          deviceError = 'unknown_device';
        }
      }
      host.ready = true;
      wsSend(host.ws, {
        type: 'registered', code: newSupportCode(host), deviceOk, deviceError,
        name: host.name, ice: iceServers('host'), version: VERSION,
      });
      return;
    }
    case 'ping':
      return wsSend(host.ws, { type: 'pong' });
    case 'new-code':
      if (host.ready && !host.sessionId) wsSend(host.ws, { type: 'code', code: newSupportCode(host) });
      return;
    case 'session-response': {
      const sess = sessions.get(String(msg.sessionId));
      if (!sess || sess.host !== host || sess.accepted) return;
      if (msg.accept) {
        sess.accepted = true;
        sess.startedAt = now();
        audit(sess.viewer.userId, 'session_started', `${host.name} · ${sess.kind}`);
        wsSend(sess.viewer.ws, { type: 'accepted', sessionId: sess.id });
      } else {
        wsSend(sess.viewer.ws, { type: 'rejected', sessionId: sess.id, reason: String(msg.reason || 'declined').slice(0, 40) });
        endSession(sess.id, 'declined', 'viewer');
      }
      return;
    }
    case 'signal': {
      const sess = sessions.get(String(msg.sessionId));
      if (sess && sess.host === host && sess.accepted) wsSend(sess.viewer.ws, { type: 'signal', sessionId: sess.id, data: msg.data });
      return;
    }
    case 'session-end': {
      const sess = sessions.get(String(msg.sessionId));
      if (sess && sess.host === host) endSession(sess.id, String(msg.reason || 'host_ended').slice(0, 40), 'host');
      return;
    }
    default:
  }
}

function handleViewerMessage(viewer, msg) {
  switch (msg.type) {
    case 'connect': {
      if (viewer.sessionId) return wsSend(viewer.ws, { type: 'error', code: 'already_in_session' });
      let host = null;
      let kind = 'unattended';
      if (msg.deviceId) {
        const row = s.devGet.get(String(msg.deviceId));
        if (!row || row.user_id !== viewer.userId) return wsSend(viewer.ws, { type: 'error', code: 'not_found' });
        host = deviceHosts.get(row.id);
        if (!host) return wsSend(viewer.ws, { type: 'error', code: 'offline' });
      } else {
        kind = 'support';
        if (!limiter.hit(`code:${viewer.userId}`, 30, 10 * 60_000)) return wsSend(viewer.ws, { type: 'error', code: 'too_many_attempts' });
        host = codeHosts.get(String(msg.code || '').replace(/\D/g, ''));
        if (!host) return wsSend(viewer.ws, { type: 'error', code: 'not_found' });
      }
      if (host.sessionId) return wsSend(viewer.ws, { type: 'error', code: 'busy' });
      const id = randomToken(12);
      sessions.set(id, { id, host, viewer, kind, startedAt: now(), accepted: false });
      host.sessionId = id;
      viewer.sessionId = id;
      wsSend(host.ws, { type: 'session-request', sessionId: id, kind, viewer: viewer.email, ice: iceServers('host') });
      wsSend(viewer.ws, {
        type: 'connecting', sessionId: id, kind, hostName: host.name, platform: host.platform, ice: iceServers('viewer'),
      });
      return;
    }
    case 'signal': {
      const sess = sessions.get(String(msg.sessionId));
      if (sess && sess.viewer === viewer && sess.accepted) wsSend(sess.host.ws, { type: 'signal', sessionId: sess.id, data: msg.data });
      return;
    }
    case 'session-end': {
      const sess = sessions.get(String(msg.sessionId));
      if (sess && sess.viewer === viewer) endSession(sess.id, 'viewer_ended', 'viewer');
      return;
    }
    default:
  }
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

server.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return socket.destroy();
  }
  if (url.pathname !== '/ws') return socket.destroy();
  const role = url.searchParams.get('role');
  const ip = clientIp(req);
  const deny = (status) => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  if (role === 'viewer') {
    // Browser connection: cookie auth, so the Origin must be ours.
    if (!originAllowed(req)) return deny('403 Forbidden');
    const sess = sessionUser(req);
    if (!sess) return deny('401 Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => {
      const viewer = { ws, userId: sess.user.id, email: sess.user.email, sessionId: null, alive: true };
      attach(ws, viewer, handleViewerMessage, () => {
        if (viewer.sessionId) endSession(viewer.sessionId, 'viewer_disconnected', 'viewer');
      });
    });
  } else if (role === 'host') {
    const count = hostsPerIp.get(ip) || 0;
    if (count >= 50) return deny('429 Too Many Requests');
    wss.handleUpgrade(req, socket, head, (ws) => {
      hostsPerIp.set(ip, (hostsPerIp.get(ip) || 0) + 1);
      /** @type {HostConn} */
      const host = { ws, id: randomToken(6), ip, deviceId: null, userId: null, code: null, name: 'Computer', platform: 'unknown', sessionId: null, ready: false, alive: true };
      const helloTimer = setTimeout(() => !host.ready && ws.close(4000, 'hello timeout'), 10_000);
      attach(ws, host, handleHostMessage, () => {
        clearTimeout(helloTimer);
        const n = (hostsPerIp.get(ip) || 1) - 1;
        if (n <= 0) hostsPerIp.delete(ip); else hostsPerIp.set(ip, n);
        if (host.sessionId) endSession(host.sessionId, 'host_disconnected', 'host');
        if (host.code && codeHosts.get(host.code) === host) codeHosts.delete(host.code);
        if (host.deviceId && deviceHosts.get(host.deviceId) === host) {
          deviceHosts.delete(host.deviceId);
          s.devSeen.run(now(), host.deviceId);
        }
      });
    });
  } else {
    deny('400 Bad Request');
  }
});

function attach(ws, conn, handler, onClose) {
  ws.on('pong', () => { conn.alive = true; });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    if (!limiter.hit(`ws:${conn.id || conn.userId}:${conn.ip || ''}`, 600, 10_000)) return ws.close(4008, 'rate limit');
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    try {
      handler(conn, msg);
    } catch (e) {
      console.error('ws handler failed:', e);
    }
  });
  ws.on('close', onClose);
  ws.on('error', () => {});
  ws._conn = conn;
}

setInterval(() => {
  for (const ws of wss.clients) {
    const conn = ws._conn;
    if (!conn) continue;
    if (!conn.alive) { ws.terminate(); continue; }
    conn.alive = false;
    ws.ping();
  }
}, 30_000).unref();

setInterval(() => {
  s.sessPurge.run(now());
  s.auditTrim.run();
  // Drop session requests that were never answered.
  for (const sess of sessions.values()) {
    if (!sess.accepted && now() - sess.startedAt > 90_000) endSession(sess.id, 'timeout');
  }
}, 30_000).unref();

server.listen(cfg.port, cfg.host, () => {
  console.log(`Shackle server ${VERSION} listening on http://${cfg.host}:${cfg.port}`);
  if (!cfg.turnUrls.length) console.log('Note: no TURN relay configured. Connections across strict NATs may fail (see README).');
});

function shutdown() {
  for (const ws of wss.clients) ws.close(1001, 'server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
