// The file-backed driver: the same node:sqlite database the app has always used.
//
// It is loaded with a dynamic import and only when no hosted database is
// configured, because `node:sqlite` is missing on older Node runtimes — a
// deployed function that talks to a hosted database must not fail to boot just
// because this module was imported.
export async function createLocalDriver(file) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.prepare('PRAGMA journal_mode = WAL').get();
  db.prepare('PRAGMA foreign_keys = ON').get();
  // `npm run admin` writes while the server holds the same file; without this a
  // colliding write throws SQLITE_BUSY instead of waiting a moment.
  db.prepare('PRAGMA busy_timeout = 5000').get();

  // node:sqlite rejects undefined and booleans, so both are coerced here rather
  // than at every call site.
  const args = (params) => (params || []).map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

  return {
    kind: 'sqlite',
    location: file,
    async exec(script) {
      db.exec(script);
    },
    async all(sql, params) {
      return db.prepare(sql).all(...args(params));
    },
    async get(sql, params) {
      return db.prepare(sql).get(...args(params)) || null;
    },
    async run(sql, params) {
      const res = db.prepare(sql).run(...args(params));
      return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
    },
    // The group contract shared with the hosted driver: statements run in order
    // and nothing is read back — a caller that wants rows uses all()/get(). This
    // driver additionally wraps the group in one transaction; the hosted one
    // commits each statement alone, so no call site may depend on rollback.
    async batch(statements) {
      const list = statements || [];
      if (!list.length) return;
      if (list.length < 2) {
        db.prepare(list[0].sql).run(...args(list[0].params));
        return;
      }
      db.exec('BEGIN');
      try {
        for (const statement of list) db.prepare(statement.sql).run(...args(statement.params));
        db.exec('COMMIT');
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* the transaction is already gone */
        }
        throw err;
      }
    },
    async close() {
      db.close();
    }
  };
}
