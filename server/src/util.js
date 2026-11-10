import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export const now = () => Date.now();
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/* ---------- passwords (scrypt) ---------- */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, n, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64');
    const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { ...SCRYPT, N: Number(n) });
    return crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/* ---------- TOTP (RFC 6238, SHA-1, 30 s, 6 digits) ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpCode(secret, time = Date.now(), stepOffset = 0) {
  const counter = Math.floor(time / 30000) + stepOffset;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = mac[mac.length - 1] & 15;
  const bin = ((mac[off] & 127) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

export function verifyTotp(secret, code) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  return [-1, 0, 1].some((o) => safeEqual(totpCode(secret, Date.now(), o), c));
}

export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

/* ---------- TURN REST credentials (coturn use-auth-secret) ---------- */
export function turnCredentials(secret, ttlSeconds = 6 * 3600, label = 'shackle') {
  const username = `${Math.floor(Date.now() / 1000) + ttlSeconds}:${label}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

/* ---------- fixed-window rate limiter ---------- */
export class RateLimiter {
  constructor() {
    this.map = new Map();
    setInterval(() => this.sweep(), 60_000).unref();
  }
  /** returns true when the action is allowed */
  hit(key, limit, windowMs) {
    const t = Date.now();
    let e = this.map.get(key);
    if (!e || e.reset < t) {
      e = { count: 0, reset: t + windowMs };
      this.map.set(key, e);
    }
    e.count += 1;
    return e.count <= limit;
  }
  clear(key) {
    this.map.delete(key);
  }
  sweep() {
    const t = Date.now();
    for (const [k, e] of this.map) if (e.reset < t) this.map.delete(k);
  }
}

export function randomDigits(n) {
  let s = String(crypto.randomInt(1, 10));
  while (s.length < n) s += String(crypto.randomInt(0, 10));
  return s;
}

export const isEmail = (s) => typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
export const cleanName = (s, fallback = 'Computer') =>
  (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) : '') || fallback;
