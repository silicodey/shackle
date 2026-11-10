import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { base32Encode, base32Decode, totpCode, verifyTotp, hashPassword, verifyPassword, turnCredentials, RateLimiter, randomDigits } from '../src/util.js';

test('TOTP matches the RFC 6238 SHA-1 test vectors', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totpCode(secret, 59_000), '287082');
  assert.equal(totpCode(secret, 1111111109_000), '081804');
  assert.equal(totpCode(secret, 20000000000_000), '353130');
  assert.ok(verifyTotp(secret, totpCode(secret)));
  assert.ok(!verifyTotp(secret, '000000') || totpCode(secret) === '000000');
});

test('base32 round-trips', () => {
  const buf = crypto.randomBytes(20);
  assert.deepEqual(base32Decode(base32Encode(buf)), buf);
});

test('password hashing verifies and rejects', async () => {
  const h = await hashPassword('correct horse battery');
  assert.ok(await verifyPassword('correct horse battery', h));
  assert.ok(!(await verifyPassword('wrong', h)));
  assert.ok(!(await verifyPassword('x', 'garbage')));
});

test('TURN credentials follow the coturn REST format', () => {
  const { username, credential } = turnCredentials('s3cret', 60, 'x');
  assert.match(username, /^\d+:x$/);
  assert.equal(credential, crypto.createHmac('sha1', 's3cret').update(username).digest('base64'));
});

test('rate limiter blocks after the limit', () => {
  const r = new RateLimiter();
  assert.ok(r.hit('k', 2, 1000));
  assert.ok(r.hit('k', 2, 1000));
  assert.ok(!r.hit('k', 2, 1000));
});

test('device ids are nine digits', () => {
  for (let i = 0; i < 200; i++) assert.match(randomDigits(9), /^[1-9]\d{8}$/);
});

test('host and web copies of the session protocol are identical', () => {
  const a = fs.readFileSync(new URL('../public/proto.js', import.meta.url), 'utf8');
  const b = fs.readFileSync(new URL('../../host/src/renderer/proto.js', import.meta.url), 'utf8');
  assert.equal(a, b);
});
