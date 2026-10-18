import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// A relative DATA_DIR is anchored to the project so the server and the CLI always
// agree; an absolute one is taken as given, including Windows drive paths.
const DATA = process.env.DATA_DIR || 'data';
export const DATA_DIR = isAbsolute(DATA) ? DATA : join(ROOT, DATA);
export const DB_FILE = join(DATA_DIR, 'devchat.db');

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MARKUP = 20;
const AUDIT_KEEP = 3000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash    TEXT NOT NULL,
  pass_salt    TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'user',
  status       TEXT NOT NULL DEFAULT 'active',
  api_key_enc  TEXT,
  api_key_hint TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model             TEXT NOT NULL,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  actual_cost       REAL NOT NULL DEFAULT 0,
  billed_cost       REAL NOT NULL DEFAULT 0,
  estimate_cost     REAL NOT NULL DEFAULT 0,
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  ok                INTEGER NOT NULL DEFAULT 1,
  error             TEXT,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_guard (
  key          TEXT PRIMARY KEY,
  fails        INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT,
  kind       TEXT NOT NULL,
  ip         TEXT,
  detail     TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_time ON usage_log(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_events_time ON auth_events(created_at);
`;

// node:sqlite rejects undefined and booleans, so every write goes through this.
function p(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

export class Store {
  constructor(file = DB_FILE) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // WAL survives a killed process mid-write, which matters because a stream
    // can be aborted at any moment.
    this.db.prepare('PRAGMA journal_mode = WAL').get();
    this.db.prepare('PRAGMA foreign_keys = ON').get();
    // `npm run admin` writes while the server holds the same file; without this
    // a colliding write throws SQLITE_BUSY instead of waiting a moment.
    this.db.prepare('PRAGMA busy_timeout = 5000').get();
    this.db.exec(SCHEMA);
    if (this.getSetting('markup_percent') === null) {
      this.setSetting('markup_percent', String(DEFAULT_MARKUP));
    }
  }

  close() {
    this.db.close();
  }

  // ---------------------------------------------------------------- users

  createUser({ username, passHash, passSalt, role = 'user' }) {
    const res = this.db
      .prepare(
        `INSERT INTO users (username, pass_hash, pass_salt, role, status, created_at)
         VALUES (?, ?, ?, ?, 'active', ?)`
      )
      .run(username, passHash, passSalt, role, Date.now());
    return Number(res.lastInsertRowid);
  }

  getUserByName(username) {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
  }

  getUserById(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
  }

  countUsers() {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM users').get();
    return Number(row?.n || 0);
  }

  countAdmins() {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'")
      .get();
    return Number(row?.n || 0);
  }

  listUsers() {
    return this.db
      .prepare(
        `SELECT u.id, u.username, u.role, u.status, u.api_key_hint, u.created_at, u.last_seen_at,
                (SELECT COUNT(*) FROM sessions s
                  WHERE s.user_id = u.id AND s.expires_at > ?) AS sessions,
                g.fails AS guard_fails, g.locked_until AS locked_until,
                COUNT(g2.id) AS requests,
                COALESCE(SUM(g2.prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(g2.completion_tokens), 0) AS completion_tokens,
                COALESCE(ROUND(SUM(g2.actual_cost), 4), 0) AS actual_cost,
                COALESCE(ROUND(SUM(g2.billed_cost), 4), 0) AS billed_cost
         FROM users u
         LEFT JOIN usage_log g2 ON g2.user_id = u.id
         LEFT JOIN login_guard g ON g.key = 'user:' || lower(u.username)
         GROUP BY u.id
         ORDER BY u.id`
      )
      .all(Date.now());
  }

  setUserStatus(id, status) {
    this.db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id);
    // Sessions are left in place on purpose: every protected route rejects a
    // non-active account, so the cookie is inert, and re-enabling restores the
    // user's login instead of silently signing them out. Keeping the session
    // also lets /api/me report "disabled" rather than "not signed in".
  }

  setUserRole(id, role) {
    this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  }

  setUserPassword(id, passHash, passSalt) {
    this.db.prepare('UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?').run(passHash, passSalt, id);
    this.deleteUserSessions(id);
  }

  setUserApiKey(id, apiKeyEnc, apiKeyHint) {
    this.db
      .prepare('UPDATE users SET api_key_enc = ?, api_key_hint = ? WHERE id = ?')
      .run(p(apiKeyEnc), p(apiKeyHint), id);
  }

  touchUser(id) {
    this.db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), id);
  }

  deleteUser(id) {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  // ------------------------------------------------------------- sessions

  createSession(tokenHash, userId, ttlMs = SESSION_TTL_MS) {
    const now = Date.now();
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(tokenHash, userId, now, now + ttlMs);
  }

  getSession(tokenHash) {
    const now = Date.now();
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    return (
      this.db
        .prepare(
          // Both tables have created_at, and a duplicate column name would let
          // the later one silently overwrite the earlier in the result row — so
          // the session timestamp, which drives admin step-up, is aliased.
          `SELECT s.token_hash, s.created_at AS session_created_at, s.expires_at,
                  u.id, u.username, u.role, u.status,
                  u.api_key_enc, u.api_key_hint, u.created_at AS user_created_at, u.last_seen_at
           FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ? AND s.expires_at > ?`
        )
        .get(tokenHash, now) || null
    );
  }

  deleteSession(tokenHash) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteUserSessions(userId) {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  countSessions(userId) {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(userId);
    return Number(row?.n || 0);
  }

  // ------------------------------------------------------------ login guard

  getLoginGuard(key) {
    return this.db.prepare('SELECT * FROM login_guard WHERE key = ?').get(key) || null;
  }

  setUpLoginGuard(key, { fails, lockedUntil }) {
    this.db
      .prepare(
        `INSERT INTO login_guard (key, fails, locked_until, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET fails = excluded.fails,
                                        locked_until = excluded.locked_until,
                                        updated_at = excluded.updated_at`
      )
      .run(key, fails, lockedUntil || 0, Date.now());
  }

  clearLoginGuard(key) {
    const res = this.db.prepare('DELETE FROM login_guard WHERE key = ?').run(key);
    return Number(res.changes) > 0;
  }

  // Every guard row, active lock or not: the admin panel should show an account
  // with 4 failed attempts before it locks, not only after.
  listLoginGuards() {
    return this.db
      .prepare(
        `SELECT g.key, g.fails, g.locked_until, g.updated_at,
                u.username, u.role, u.status
         FROM login_guard g
         LEFT JOIN users u ON 'user:' || lower(u.username) = g.key
         ORDER BY g.locked_until DESC, g.updated_at DESC`
      )
      .all();
  }

  // ------------------------------------------------------------- auth events

  logAuthEvent({ username, kind, ip = null, detail = null }) {
    // Lowercased because usernames are COLLATE NOCASE and the step-up check has
    // to match an event written from the typed name against the stored one.
    this.db
      .prepare('INSERT INTO auth_events (username, kind, ip, detail, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(p(username ? String(username).toLowerCase() : null), kind, p(ip), p(detail), Date.now());
    // Append-only audit trail: keep the newest AUDIT_KEEP rows and drop the rest,
    // so a brute-force attempt cannot grow the database without bound.
    this.db
      .prepare(
        `DELETE FROM auth_events WHERE id NOT IN
           (SELECT id FROM auth_events ORDER BY id DESC LIMIT ?)`
      )
      .run(AUDIT_KEEP);
  }

  recentAuthEvents(limit = 40) {
    return this.db
      .prepare('SELECT * FROM auth_events ORDER BY id DESC LIMIT ?')
      .all(limit);
  }

  lastAuthEventAt(username, kinds) {
    const list = Array.isArray(kinds) ? kinds : [kinds];
    if (!list.length) return 0;
    const row = this.db
      .prepare(
        `SELECT created_at FROM auth_events
         WHERE username = ? AND kind IN (${list.map(() => '?').join(',')})
         ORDER BY id DESC LIMIT 1`
      )
      .get(String(username).toLowerCase(), ...list);
    return row ? Number(row.created_at) : 0;
  }

  // ---------------------------------------------------------------- usage

  logUsage(row) {
    const res = this.db
      .prepare(
        `INSERT INTO usage_log
           (user_id, model, prompt_tokens, completion_tokens, actual_cost, billed_cost,
            estimate_cost, duration_ms, ok, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.userId,
        row.model,
        p(row.promptTokens) || 0,
        p(row.completionTokens) || 0,
        p(row.actualCost) || 0,
        p(row.billedCost) || 0,
        p(row.estimateCost) || 0,
        p(row.durationMs) || 0,
        row.ok ? 1 : 0,
        p(row.error),
        Date.now()
      );
    return Number(res.lastInsertRowid);
  }

  usageTotals(sinceMs) {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS requests,
                  COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                  COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                  COALESCE(ROUND(SUM(actual_cost), 4), 0) AS actual_cost,
                  COALESCE(ROUND(SUM(billed_cost), 4), 0) AS billed_cost,
                  COALESCE(ROUND(SUM(estimate_cost), 4), 0) AS estimate_cost,
                  COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS failed
           FROM usage_log WHERE created_at >= ?`
        )
        .get(sinceMs) || {}
    );
  }

  usageByUser(sinceMs) {
    return this.db
      .prepare(
        `SELECT u.id AS user_id, u.username, u.role, u.status,
                COUNT(g.id) AS requests,
                COALESCE(SUM(g.prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(g.completion_tokens), 0) AS completion_tokens,
                COALESCE(ROUND(SUM(g.actual_cost), 4), 0) AS actual_cost,
                COALESCE(ROUND(SUM(g.billed_cost), 4), 0) AS billed_cost,
                COALESCE(SUM(CASE WHEN g.ok = 0 THEN 1 ELSE 0 END), 0) AS failed
         FROM users u LEFT JOIN usage_log g ON g.user_id = u.id AND g.created_at >= ?
         GROUP BY u.id ORDER BY billed_cost DESC, requests DESC`
      )
      .all(sinceMs);
  }

  usageByModel(sinceMs) {
    return this.db
      .prepare(
        `SELECT model, COUNT(*) AS requests,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                COALESCE(ROUND(SUM(actual_cost), 4), 0) AS actual_cost,
                COALESCE(ROUND(SUM(billed_cost), 4), 0) AS billed_cost
         FROM usage_log WHERE created_at >= ?
         GROUP BY model ORDER BY billed_cost DESC LIMIT 25`
      )
      .all(sinceMs);
  }

  usageByDay(sinceMs) {
    // strftime with 'unixepoch' keeps bucketing in SQLite instead of JS.
    return this.db
      .prepare(
        `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day,
                COUNT(*) AS requests,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                COALESCE(ROUND(SUM(actual_cost), 4), 0) AS actual_cost,
                COALESCE(ROUND(SUM(billed_cost), 4), 0) AS billed_cost
         FROM usage_log WHERE created_at >= ?
         GROUP BY day ORDER BY day`
      )
      .all(sinceMs);
  }

  recentUsage(limit = 40) {
    return this.db
      .prepare(
        `SELECT g.id, g.model, g.prompt_tokens, g.completion_tokens, g.actual_cost,
                g.billed_cost, g.estimate_cost, g.duration_ms, g.ok, g.error, g.created_at,
                u.username
         FROM usage_log g JOIN users u ON u.id = g.user_id
         ORDER BY g.id DESC LIMIT ?`
      )
      .all(limit);
  }

  // ------------------------------------------------------------- settings

  getSetting(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  }

  setSetting(key, value) {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, String(value));
  }

  getMarkupPercent() {
    const raw = Number(this.getSetting('markup_percent', String(DEFAULT_MARKUP)));
    return Number.isFinite(raw) ? raw : DEFAULT_MARKUP;
  }

  setMarkupPercent(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1000) throw new Error('Markup must be between 0 and 1000 percent');
    this.setSetting('markup_percent', String(Math.round(n * 100) / 100));
    return this.getMarkupPercent();
  }
}
