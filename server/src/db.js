import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'tether.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pass_hash TEXT NOT NULL,
      totp_secret TEXT,
      totp_enabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen INTEGER
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      user_id INTEGER,
      event TEXT NOT NULL,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS audit_user ON audit(user_id, id DESC);
  `);

  const q = (sql) => db.prepare(sql);
  const s = {
    metaGet: q('SELECT value FROM meta WHERE key = ?'),
    metaSet: q('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    metaDel: q('DELETE FROM meta WHERE key = ?'),
    userCount: q('SELECT COUNT(*) AS n FROM users'),
    userByEmail: q('SELECT * FROM users WHERE email = ?'),
    userById: q('SELECT * FROM users WHERE id = ?'),
    userInsert: q('INSERT INTO users(email, pass_hash, created_at) VALUES(?, ?, ?)'),
    userSetPass: q('UPDATE users SET pass_hash = ? WHERE id = ?'),
    userSetTotp: q('UPDATE users SET totp_secret = ?, totp_enabled = ? WHERE id = ?'),
    sessInsert: q('INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES(?, ?, ?, ?)'),
    sessGet: q('SELECT * FROM sessions WHERE token_hash = ?'),
    sessDel: q('DELETE FROM sessions WHERE token_hash = ?'),
    sessDelUserExcept: q('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
    sessPurge: q('DELETE FROM sessions WHERE expires_at < ?'),
    devInsert: q('INSERT INTO devices(id, user_id, name, platform, token_hash, created_at) VALUES(?, ?, ?, ?, ?, ?)'),
    devGet: q('SELECT * FROM devices WHERE id = ?'),
    devList: q('SELECT id, name, platform, created_at, last_seen FROM devices WHERE user_id = ? ORDER BY name COLLATE NOCASE'),
    devRename: q('UPDATE devices SET name = ? WHERE id = ? AND user_id = ?'),
    devDelete: q('DELETE FROM devices WHERE id = ? AND user_id = ?'),
    devSeen: q('UPDATE devices SET last_seen = ? WHERE id = ?'),
    auditInsert: q('INSERT INTO audit(ts, user_id, event, detail) VALUES(?, ?, ?, ?)'),
    auditList: q('SELECT ts, event, detail FROM audit WHERE user_id = ? ORDER BY id DESC LIMIT 100'),
    auditTrim: q('DELETE FROM audit WHERE id < (SELECT MAX(id) FROM audit) - 5000'),
  };
  return { db, s };
}
