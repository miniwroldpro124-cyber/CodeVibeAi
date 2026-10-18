export class HttpError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    // A machine-readable reason, so the client can react (step-up password
    // prompt) without matching on the human-readable message.
    this.code = code;
  }
}

export function sendJson(res, status, payload) {
  if (res.writableEnded || res.headersSent) return;
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

export function sendText(res, status, text) {
  if (res.writableEnded || res.headersSent) return;
  const body = Buffer.from(text);
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

export function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((done, fail) => {
    // Refusing on Content-Length happens before a single byte is buffered, which
    // matters because destroying the request socket also kills the 413 reply —
    // the client would see a hung connection instead of an error.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.on('error', () => {});
      req.resume();
      fail(new HttpError(413, 'Request body too large'));
      return;
    }

    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        req.pause();
        fail(new HttpError(413, 'Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) done(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', fail);
  });
}

export async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'Request body must be a JSON object');
    }
    return parsed;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'Request body must be valid JSON');
  }
}

export function setCookies(res, cookies) {
  const list = (Array.isArray(cookies) ? cookies : [cookies]).filter(Boolean);
  if (!list.length) return;
  const existing = res.getHeader('Set-Cookie');
  const merged = existing ? (Array.isArray(existing) ? existing : [existing]).concat(list) : list;
  res.setHeader('Set-Cookie', merged);
}

export function clientIp(req) {
  return req.socket?.remoteAddress || 'unknown';
}

// A tiny fixed-window limiter. Login and signup are the only endpoints worth
// throttling, and an in-memory map is enough for a single-process app.
const buckets = new Map();

export function rateLimit(bucket, limit, windowMs) {
  const now = Date.now();
  if (buckets.size > 5000) {
    for (const [key, rec] of buckets) if (now > rec.resetAt) buckets.delete(key);
  }
  const key = bucket;
  const rec = buckets.get(key);
  if (!rec || now > rec.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  rec.count += 1;
  if (rec.count > limit) {
    return { ok: false, retryAfter: Math.ceil((rec.resetAt - now) / 1000) };
  }
  return { ok: true, retryAfter: 0 };
}
