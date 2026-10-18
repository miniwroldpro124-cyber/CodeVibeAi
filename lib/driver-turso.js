// Hosted libSQL over plain HTTPS — the Turso "pipeline" API. No npm dependency,
// because the whole thing is one POST per statement set.
//
// Two properties of this transport shape everything below it:
//   * Every request is a fresh connection. Nothing carries over, so session
//     pragmas (journal_mode, busy_timeout, foreign_keys) are never sent here —
//     they would be no-ops at best.
//   * Integers cross the wire as decimal strings, both ways. Decoding them back
//     to numbers is not cosmetic: `locked_until > Date.now()` against a string
//     silently compares wrong.

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export function createTursoDriver({ url, token, timeoutMs = 10_000 }) {
  const base = httpUrl(url);
  if (!token) throw new Error('TURSO_TOKEN is required when TURSO_URL is set');

  async function pipeline(requests) {
    let res;
    try {
      res = await fetch(`${base}/v2/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ baton: null, requests: [...requests, { type: 'close' }] }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      throw new Error(`Cannot reach the hosted database (${err.message})`);
    }
    if (!res.ok) {
      throw new Error(`Hosted database replied ${res.status}: ${await brief(res)}`);
    }
    const payload = await res.json().catch(() => null);
    if (!payload || !Array.isArray(payload.results)) {
      throw new Error('Hosted database returned a response this build does not understand');
    }
    return payload.results;
  }

  // A SQL failure arrives inside a 200 as {type:"error"} rather than as an HTTP
  // status, so every entry has to be inspected before its result is used.
  function unwrap(entry) {
    if (entry && entry.type === 'error') {
      const err = entry.error || {};
      const failure = new Error(err.message || 'Hosted database rejected the statement');
      failure.code = err.code || null;
      throw failure;
    }
    const response = entry && entry.response;
    if (!response || response.type !== 'execute' || !response.result) {
      throw new Error('Hosted database returned an unexpected entry');
    }
    return response.result;
  }

  function execute(sql, params, wantRows) {
    const stmt = { sql, want_rows: wantRows !== false };
    if (params && params.length) stmt.args = params.map(encodeParam);
    return stmt;
  }

  return {
    kind: 'turso',
    location: `${base.replace(/^https:\/\//, '')} (hosted)`,

    async exec(sql) {
      await pipeline([{ type: 'execute', stmt: execute(sql, null, false) }]);
    },

    async all(sql, params) {
      return readRows(unwrap((await pipeline([{ type: 'execute', stmt: execute(sql, params) }]))[0]));
    },

    async get(sql, params) {
      const rows = readRows(unwrap((await pipeline([{ type: 'execute', stmt: execute(sql, params) }]))[0]));
      return rows[0] || null;
    },

    async run(sql, params) {
      const result = unwrap((await pipeline([{ type: 'execute', stmt: execute(sql, params, false) }]))[0]);
      return {
        changes: Number(result.affected_row_count || 0),
        lastInsertRowid: Number(result.last_insert_rowid || 0)
      };
    },

    // One round trip for the whole group, sent as N plain execute requests rather
    // than a {type:"batch"} frame. The pipeline array is what this transport
    // documents; the shape of a batch's nested per-statement results is not, and
    // signing in goes through here — a wrong guess would take the site down
    // instead of losing a row.
    //
    // The trade: the statements run in order but each commits on its own, so a
    // later failure leaves the earlier writes behind. Call sites are ordered so
    // the half that survives is the harmless one — see setUserPassword in db.js.
    async batch(statements) {
      const list = statements || [];
      if (!list.length) return;
      const results = await pipeline(
        list.map((s) => ({ type: 'execute', stmt: execute(s.sql, s.params, false) }))
      );
      list.forEach((s, i) => unwrap(results[i]));
    },

    async close() {
      // Nothing to release: each pipeline opened and closed its own stream.
    }
  };
}

function readRows(result) {
  if (!result) return [];
  const rows = result.rows;
  if (!Array.isArray(rows) || !rows.length) return [];
  const columns = Array.isArray(result.cols) ? result.cols.map((c) => c.name) : null;
  if (!columns) throw new Error('Hosted database returned rows without column names');
  return rows.map((row) => {
    const out = {};
    columns.forEach((name, i) => {
      out[name] = decodeValue(row[i]);
    });
    return out;
  });
}

function decodeValue(value) {
  if (value === null || value === undefined) return null;
  // Tolerate a server that sends a bare primitive rather than a typed object.
  if (typeof value !== 'object') return value;
  switch (value.type) {
    case 'null':
      return null;
    case 'integer': {
      const n = Number(value.value);
      // Beyond the safe range a Number would silently round; leave it alone.
      return Number.isFinite(n) && Math.abs(n) <= MAX_SAFE ? n : value.value;
    }
    case 'float':
      return value.value === null || value.value === undefined ? null : Number(value.value);
    case 'text':
      return value.value;
    case 'blob':
      return Buffer.from(value.base64 || '', 'base64');
    default:
      return value.value !== undefined ? value.value : null;
  }
}

function encodeParam(value) {
  if (value === null || value === undefined) return { type: 'null' };
  if (typeof value === 'boolean') return { type: 'integer', value: value ? '1' : '0' };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { type: 'null' };
    return Number.isInteger(value)
      ? { type: 'integer', value: String(value) }
      : { type: 'float', value };
  }
  if (typeof value === 'bigint') return { type: 'integer', value: value.toString() };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { type: 'blob', base64: Buffer.from(value).toString('base64') };
  }
  return { type: 'text', value: String(value) };
}

// libsql:// and turso:// URLs identify the same host; only the scheme differs.
function httpUrl(raw) {
  const trimmed = String(raw || '').trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('TURSO_URL is empty');
  const withHttps = trimmed.replace(/^libsql:\/\//i, 'https://').replace(/^turso:\/\//i, 'https://');
  let parsed;
  try {
    parsed = new URL(withHttps);
  } catch {
    throw new Error(`TURSO_URL is not a valid database URL: ${trimmed.replace(/\/\/[^@]*@/, '//')}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('TURSO_URL must be an https (or libsql) database URL');
  }
  return parsed.origin + parsed.pathname.replace(/\/$/, '');
}

async function brief(res) {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return res.statusText;
  }
}
