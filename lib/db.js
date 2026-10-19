import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostedToken, hostedUrl } from './env.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// A relative DATA_DIR is anchored to the project so the server and the CLI always
// agree; an absolute one is taken as given, including Windows drive paths.
const DATA = process.env.DATA_DIR || 'data';
export const DATA_DIR = isAbsolute(DATA) ? DATA : join(ROOT, DATA);
export const DB_FILE = join(DATA_DIR, 'devchat.db');

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MARKUP = 20;
const AUDIT_KEEP = 3000;
const WINDOW_KEEP_MS = 24 * 60 * 60 * 1000;

// One statement per entry: a hosted driver executes these over HTTP, where a
// multi-statement script is not always accepted.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
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
)`,
  `CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS usage_log (
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
)`,
  `CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS login_guard (
  key          TEXT PRIMARY KEY,
  fails        INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS auth_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT,
  kind       TEXT NOT NULL,
  ip         TEXT,
  detail     TEXT,
  created_at INTEGER NOT NULL
)`,
  // One row per (provider, account id) the person proved they own. The id, not the
  // email, is the key: an address can be released and re-registered by someone
  // else, a Google `sub` or a GitHub `id` cannot.
  `CREATE TABLE IF NOT EXISTS identities (
  provider      TEXT NOT NULL,
  subject       TEXT NOT NULL,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email         TEXT,
  login         TEXT,
  name          TEXT,
  avatar        TEXT,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER,
  PRIMARY KEY (provider, subject)
)`,
  // The only throttle state: one fixed-window hit counter per address or account.
  // It is a table rather than process memory because a hosted app runs in many
  // short-lived functions, and a budget that resets on every cold start is not a
  // budget. Additive, and safe to drop — the app simply counts nothing.
  `CREATE TABLE IF NOT EXISTS throttle_window (
  bucket       TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  window_ms    INTEGER NOT NULL,
  hits         INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
)`,
  'CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_log(user_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_usage_time ON usage_log(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_auth_events_time ON auth_events(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id)'
];

// node:sqlite rejects undefined and booleans, so every write goes through this.
function p(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

// The database is chosen by the environment, never by the caller: a laptop with
// no configuration keeps the file it has always used, and a host with no disk
// points TURSO_URL at a database that outlives the process. The accepted names
// live in lib/env.js because the master-key guard has to agree with them.
export async function createDriver() {
  const url = hostedUrl();
  if (url) {
    const { createTursoDriver } = await import('./driver-turso.js');
    return createTursoDriver({
      url,
      token: hostedToken(),
      timeoutMs: Number(process.env.TURSO_TIMEOUT_MS) || 10_000
    });
  }
  mkdirSync(DATA_DIR, { recursive: true });
  const { createLocalDriver } = await import('./driver-local.js');
  return createLocalDriver(DB_FILE);
}

export class Store {
  constructor(driver) {
    this.d = driver;
  }

  static async open() {
    const store = new Store(await createDriver());
    await store.initSchema();
    return store;
  }

  // Safe to run repeatedly: every statement is CREATE ... IF NOT EXISTS, so a
  // warm instance, a restart and a freshly created database all take this path.
  async initSchema() {
    for (const statement of SCHEMA) await this.d.exec(statement);
    // Windows older than a day are dead counters, and a flood is exactly what
    // fills this table with rows nothing will ever read again. A cold start is the
    // cheapest place to clear them, because it happens on its own.
    await this.d.run('DELETE FROM throttle_window WHERE updated_at < ?', [Date.now() - WINDOW_KEEP_MS]);
    if ((await this.getSetting('markup_percent')) === null) {
      await this.setSetting('markup_percent', String(DEFAULT_MARKUP));
    }
  }

  get location() {
    return this.d.location;
  }

  close() {
    return this.d.close();
  }

  // ---------------------------------------------------------------- users

  async createUser({ username, passHash, passSalt, role = 'user' }) {
    const res = await this.d.run(
      `INSERT INTO users (username, pass_hash, pass_salt, role, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
      [username, passHash, passSalt, role, Date.now()]
    );
    return Number(res.lastInsertRowid);
  }

  async getUserByName(username) {
    return this.d.get('SELECT * FROM users WHERE username = ?', [username]);
  }

  async getUserById(id) {
    return this.d.get('SELECT * FROM users WHERE id = ?', [id]);
  }

  async countUsers() {
    const row = await this.d.get('SELECT COUNT(*) AS n FROM users');
    return Number(row?.n || 0);
  }

  async countAdmins() {
    const row = await this.d.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'");
    return Number(row?.n || 0);
  }

  async listUsers() {
    return this.d.all(
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
       ORDER BY u.id`,
      [Date.now()]
    );
  }

  async setUserStatus(id, status) {
    await this.d.run('UPDATE users SET status = ? WHERE id = ?', [status, id]);
    // Sessions are left in place on purpose: every protected route rejects a
    // non-active account, so the cookie is inert, and re-enabling restores the
    // user's login instead of silently signing them out. Keeping the session
    // also lets /api/me report "disabled" rather than "not signed in".
  }

  async setUserRole(id, role) {
    await this.d.run('UPDATE users SET role = ? WHERE id = ?', [role, id]);
  }

  async setUserPassword(id, passHash, passSalt) {
    // Sessions first, hash second. A hosted batch commits each statement on its
    // own, so if the pair splits, the surviving half must be the safe one: killing
    // the cookie and then failing the update signs the user out (they retry with
    // the old password), whereas the reverse would leave a stolen cookie valid
    // after the password it was issued under had changed.
    await this.d.batch([
      { sql: 'DELETE FROM sessions WHERE user_id = ?', params: [id] },
      { sql: 'UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?', params: [passHash, passSalt, id] }
    ]);
  }

  async setUserApiKey(id, apiKeyEnc, apiKeyHint) {
    await this.d.run('UPDATE users SET api_key_enc = ?, api_key_hint = ? WHERE id = ?', [
      p(apiKeyEnc),
      p(apiKeyHint),
      id
    ]);
  }

  async touchUser(id) {
    await this.d.run('UPDATE users SET last_seen_at = ? WHERE id = ?', [Date.now(), id]);
  }

  async deleteUser(id) {
    await this.d.run('DELETE FROM users WHERE id = ?', [id]);
  }

  // -------------------------------------------------------------- identities

  async getIdentity(provider, subject) {
    return this.d.get('SELECT * FROM identities WHERE provider = ? AND subject = ?', [provider, subject]);
  }

  async deleteIdentity(provider, subject) {
    await this.d.run('DELETE FROM identities WHERE provider = ? AND subject = ?', [provider, subject]);
  }

  async createIdentity({ provider, subject, userId, email = '', login = '', name = '', avatar = '' }) {
    await this.d.run(
      `INSERT INTO identities (provider, subject, user_id, email, login, name, avatar, created_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [provider, subject, userId, p(email), p(login), p(name), p(avatar), Date.now(), Date.now()]
    );
  }

  async touchIdentity(provider, subject) {
    await this.d.run('UPDATE identities SET last_login_at = ? WHERE provider = ? AND subject = ?', [
      Date.now(),
      provider,
      subject
    ]);
  }

  async listIdentities(userId) {
    return this.d.all(
      'SELECT provider, subject, email, login, name, avatar, created_at, last_login_at FROM identities WHERE user_id = ? ORDER BY provider',
      [userId]
    );
  }

  // ------------------------------------------------------------- sessions

  async createSession(tokenHash, userId, ttlMs = SESSION_TTL_MS) {
    const now = Date.now();
    // Signed in once per browser, so this is also where expired rows get swept.
    // Reading is guarded by expires_at, so the sweep is cleanup, not correctness.
    await this.d.batch([
      {
        sql: 'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
        params: [tokenHash, userId, now, now + ttlMs]
      },
      { sql: 'DELETE FROM sessions WHERE expires_at <= ?', params: [now] }
    ]);
  }

  async getSession(tokenHash) {
    // One statement, not a batch: every authenticated request lands here, and a
    // hosted database charges a round trip per group. Both tables have created_at,
    // and a duplicate column name would let the later one silently overwrite the
    // earlier in the result row — so each timestamp is aliased.
    return this.d.get(
      `SELECT s.token_hash, s.created_at AS session_created_at, s.expires_at,
              u.id, u.username, u.role, u.status,
              u.api_key_enc, u.api_key_hint, u.created_at AS user_created_at, u.last_seen_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
      [tokenHash, Date.now()]
    );
  }

  async deleteSession(tokenHash) {
    await this.d.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
  }

  async deleteUserSessions(userId) {
    await this.d.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  }

  async countSessions(userId) {
    const row = await this.d.get('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', [userId]);
    return Number(row?.n || 0);
  }

  // ------------------------------------------------------------ login guard

  async getLoginGuard(key) {
    return this.d.get('SELECT * FROM login_guard WHERE key = ?', [key]);
  }

  async setUpLoginGuard(key, { fails, lockedUntil }) {
    await this.d.run(
      `INSERT INTO login_guard (key, fails, locked_until, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET fails = excluded.fails,
                                      locked_until = excluded.locked_until,
                                      updated_at = excluded.updated_at`,
      [key, fails, lockedUntil || 0, Date.now()]
    );
  }

  async clearLoginGuard(key) {
    const res = await this.d.run('DELETE FROM login_guard WHERE key = ?', [key]);
    return Number(res.changes) > 0;
  }

  // Every guard row, active lock or not: the admin panel should show an account
  // with 4 failed attempts before it locks, not only after.
  async listLoginGuards() {
    return this.d.all(
      `SELECT g.key, g.fails, g.locked_until, g.updated_at,
              u.username, u.role, u.status
       FROM login_guard g
       LEFT JOIN users u ON 'user:' || lower(u.username) = g.key
       ORDER BY g.locked_until DESC, g.updated_at DESC`
    );
  }

  // ------------------------------------------------------------- auth events

  async logAuthEvent({ username, kind, ip = null, detail = null }) {
    // Lowercased because usernames are COLLATE NOCASE and the step-up check has
    // to match an event written from the typed name against the stored one.
    await this.d.batch([
      {
        sql: 'INSERT INTO auth_events (username, kind, ip, detail, created_at) VALUES (?, ?, ?, ?, ?)',
        params: [p(username ? String(username).toLowerCase() : null), kind, p(ip), p(detail), Date.now()]
      },
      {
        // Append-only audit trail: keep the newest AUDIT_KEEP rows and drop the
        // rest, so a brute-force attempt cannot grow the database without bound.
        sql: `DELETE FROM auth_events WHERE id NOT IN
                (SELECT id FROM auth_events ORDER BY id DESC LIMIT ?)`,
        params: [AUDIT_KEEP]
      }
    ]);
  }

  async recentAuthEvents(limit = 40) {
    return this.d.all('SELECT * FROM auth_events ORDER BY id DESC LIMIT ?', [limit]);
  }

  async lastAuthEventAt(username, kinds) {
    const list = Array.isArray(kinds) ? kinds : [kinds];
    if (!list.length) return 0;
    const row = await this.d.get(
      `SELECT created_at FROM auth_events
       WHERE username = ? AND kind IN (${list.map(() => '?').join(',')})
       ORDER BY id DESC LIMIT 1`,
      [String(username).toLowerCase(), ...list]
    );
    return row ? Number(row.created_at) : 0;
  }

  // ---------------------------------------------------------------- throttling

  // One round trip for the counter and its value: the statement writes the row and
  // hands the new number back. A stored window_start that differs from the caller's
  // means the window has rolled over, so the write is 1 and not an increment — the
  // CASE does in one statement what would otherwise be a read, a decision and a
  // second round trip over the network. Every right-hand side is evaluated against
  // the row as it was, so assigning window_start here does not hide the old value
  // from the comparison, and leaving it out would mean a rolled window never
  // accumulates anything.
  async bumpWindow(bucket, windowStart, windowMs) {
    return this.d.get(
      `INSERT INTO throttle_window (bucket, window_start, window_ms, hits, updated_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(bucket) DO UPDATE SET
         window_start = excluded.window_start,
         hits = CASE WHEN throttle_window.window_start = excluded.window_start
                     THEN throttle_window.hits + 1 ELSE 1 END,
         window_ms = excluded.window_ms,
         updated_at = excluded.updated_at
       RETURNING hits, window_start, window_ms`,
      [bucket, windowStart, windowMs, Date.now()]
    );
  }

  // ---------------------------------------------------------------- usage

  async logUsage(row) {
    const res = await this.d.run(
      `INSERT INTO usage_log
         (user_id, model, prompt_tokens, completion_tokens, actual_cost, billed_cost,
          estimate_cost, duration_ms, ok, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
      ]
    );
    return Number(res.lastInsertRowid);
  }

  // What one account has already spent and sent since a moment in time. This is the
  // durable budget: usage_log already holds a row for every chat, picture and video
  // the account ran, so the ceiling costs one read on the (user_id, created_at)
  // index and nothing new has to be written to keep it honest.
  async spendSince(userId, sinceMs) {
    const row = await this.d.get(
      `SELECT COUNT(*) AS requests, COALESCE(ROUND(SUM(billed_cost), 4), 0) AS billed
       FROM usage_log WHERE user_id = ? AND created_at >= ?`,
      [userId, sinceMs]
    );
    return { requests: Number(row?.requests || 0), billed: Number(row?.billed || 0) };
  }

  async usageTotals(sinceMs) {
    return (
      (await this.d.get(
        `SELECT COUNT(*) AS requests,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                COALESCE(ROUND(SUM(actual_cost), 4), 0) AS actual_cost,
                COALESCE(ROUND(SUM(billed_cost), 4), 0) AS billed_cost,
                COALESCE(ROUND(SUM(estimate_cost), 4), 0) AS estimate_cost,
                COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS failed
         FROM usage_log WHERE created_at >= ?`,
        [sinceMs]
      )) || {}
    );
  }

  async usageByUser(sinceMs) {
    return this.d.all(
      `SELECT u.id AS user_id, u.username, u.role, u.status,
              COUNT(g.id) AS requests,
              COALESCE(SUM(g.prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(g.completion_tokens), 0) AS completion_tokens,
              COALESCE(ROUND(SUM(g.actual_cost), 4), 0) AS actual_cost,
              COALESCE(ROUND(SUM(g.billed_cost), 4), 0) AS billed_cost,
              COALESCE(SUM(CASE WHEN g.ok = 0 THEN 1 ELSE 0 END), 0) AS failed
       FROM users u LEFT JOIN usage_log g ON g.user_id = u.id AND g.created_at >= ?
       GROUP BY u.id ORDER BY billed_cost DESC, requests DESC`,
      [sinceMs]
    );
  }

  async usageByModel(sinceMs) {
    return this.d.all(
      `SELECT model, COUNT(*) AS requests,
              COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
              COALESCE(ROUND(SUM(actual_cost), 4), 0) AS actual_cost,
              COALESCE(ROUND(SUM(billed_cost), 4), 0) AS billed_cost
       FROM usage_log WHERE created_at >= ?
       GROUP BY model ORDER BY billed_cost DESC LIMIT 25`,
      [sinceMs]
    );
  }

  async usageByDay(sinceMs) {
    // strftime with 'unixepoch' keeps bucketing in SQLite instead of JS.
    return this.d.all(
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day,
              COUNT(*) AS requests,
              COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
              COALESCE(ROUND(SUM(actual_cost), 4), 0) AS actual_cost,
              COALESCE(ROUND(SUM(billed_cost), 4), 0) AS billed_cost
       FROM usage_log WHERE created_at >= ?
       GROUP BY day ORDER BY day`,
      [sinceMs]
    );
  }

  async recentUsage(limit = 40) {
    return this.d.all(
      `SELECT g.id, g.model, g.prompt_tokens, g.completion_tokens, g.actual_cost,
              g.billed_cost, g.estimate_cost, g.duration_ms, g.ok, g.error, g.created_at,
              u.username
       FROM usage_log g JOIN users u ON u.id = g.user_id
       ORDER BY g.id DESC LIMIT ?`,
      [limit]
    );
  }

  // ------------------------------------------------------------- settings

  async getSetting(key, fallback = null) {
    const row = await this.d.get('SELECT value FROM settings WHERE key = ?', [key]);
    return row ? row.value : fallback;
  }

  async setSetting(key, value) {
    await this.d.run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, String(value)]
    );
  }

  async getMarkupPercent() {
    const raw = Number(await this.getSetting('markup_percent', String(DEFAULT_MARKUP)));
    return Number.isFinite(raw) ? raw : DEFAULT_MARKUP;
  }

  async setMarkupPercent(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1000) throw new Error('Markup must be between 0 and 1000 percent');
    await this.setSetting('markup_percent', String(Math.round(n * 100) / 100));
    return this.getMarkupPercent();
  }

  async pruneInactiveUsers({ inactiveDays = 7, dataDays = 3, apply = false } = {}) {
    const now = Date.now();
    const inactiveCutoff = now - inactiveDays * 24 * 60 * 60 * 1000;
    const dataCutoff = now - dataDays * 24 * 60 * 60 * 1000;
    const candidates = await this.d.all(
      `SELECT id, username, role, status, last_seen_at, created_at
       FROM users
       WHERE role <> 'admin'
         AND COALESCE(last_seen_at, created_at, 0) < ?`,
      [inactiveCutoff]
    );
    if (!apply) {
      return {
        apply: false,
        inactiveDays,
        dataDays,
        inactiveUsers: candidates.map((u) => ({ id: u.id, username: u.username, lastSeenAt: u.last_seen_at })),
        oldUsageRows: await this.countOlderThan('usage_log', dataCutoff),
        oldAuthEvents: await this.countOlderThan('auth_events', dataCutoff)
      };
    }
    for (const user of candidates) await this.deleteUser(user.id);
    await this.d.run('DELETE FROM usage_log WHERE created_at < ?', [dataCutoff]);
    await this.d.run('DELETE FROM auth_events WHERE created_at < ?', [dataCutoff]);
    await this.d.run('DELETE FROM throttle_window WHERE updated_at < ?', [dataCutoff]);
    return {
      apply: true,
      deletedUsers: candidates.length,
      deletedUsernames: candidates.map((u) => u.username),
      dataCutoff
    };
  }

  async countOlderThan(table, cutoff) {
    const row = await this.d.get(`SELECT COUNT(*) AS n FROM ${table} WHERE created_at < ?`, [cutoff]);
    return Number(row?.n || 0);
  }
}
