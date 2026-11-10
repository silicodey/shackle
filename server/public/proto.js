// Shared by the web viewer and the host app (host/src/renderer/proto.js is an identical copy).
//
// End-to-end session authentication. The signaling server introduces the two peers but is not
// trusted with access: the viewer must prove knowledge of the host's password directly to the
// host over the WebRTC data channel. The proof is bound to both DTLS certificate fingerprints,
// so a server (or anyone else) relaying or re-terminating the connection cannot reuse it.

export const PROTO_VERSION = 1;
export const PBKDF2_ITERATIONS = 200_000;
export const FILE_CHUNK = 16 * 1024;
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

const enc = new TextEncoder();

export function b64(bytes) {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

export function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomB64(n = 16) {
  return b64(crypto.getRandomValues(new Uint8Array(n)));
}

/** Derives the 32-byte session key from a password. Returns base64. */
export async function deriveKey(password, saltB64, iterations = PBKDF2_ITERATIONS) {
  const material = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations },
    material,
    256,
  );
  return b64(bits);
}

/** The DTLS certificate fingerprint advertised in an SDP blob. */
export function fingerprintOf(sdp) {
  const m = /^a=fingerprint:(\S+)\s+([0-9A-Fa-f:]+)\s*$/m.exec(sdp || '');
  if (!m) throw new Error('No DTLS fingerprint in session description');
  return `${m[1].toLowerCase()} ${m[2].toUpperCase()}`;
}

/** HMAC-SHA256(key, role|nonce|hostFp|viewerFp) as base64. role is "viewer" or "host". */
export async function makeProof(keyB64, role, nonce, hostFp, viewerFp) {
  const key = await crypto.subtle.importKey('raw', unb64(keyB64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${role}|${nonce}|${hostFp}|${viewerFp}`));
  return b64(mac);
}

/** Constant-time comparison of two base64 strings. */
export function sameProof(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// One-time support passwords: unambiguous characters only, typed without regard to case/spacing.
const SUPPORT_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function newSupportPassword(len = 8) {
  const out = [];
  const max = 256 - (256 % SUPPORT_ALPHABET.length);
  while (out.length < len) {
    const [v] = crypto.getRandomValues(new Uint8Array(1));
    if (v < max) out.push(SUPPORT_ALPHABET[v % SUPPORT_ALPHABET.length]);
  }
  return out.join('');
}
export const normalizeSupportPassword = (s) => String(s || '').toLowerCase().replace(/[\s-]/g, '');

export const formatCode = (code) => String(code || '').replace(/(\d{3})(?=\d)/g, '$1 ');
