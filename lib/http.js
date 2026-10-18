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

// A media reply is bytes the browser must not try to parse as text, and it is
// specific to the caller who paid for it, so nothing about it may be cached.
export function sendBytes(res, status, buffer, contentType) {
  if (res.writableEnded || res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store'
  });
  res.end(buffer);
}

// A request refused for what it did not send leaves its socket half-read, and
// Node keeps a connection open when something is still listening for its body.
// The flag is how the reader tells the router to answer with Connection: close,
// so the client gets its error and the socket is released instead of left hanging.
const markClose = (err) => {
  err.closeConnection = true;
  return err;
};

export function readBody(req, limit = 2 * 1024 * 1024) {
  // A body that arrives one byte per second holds the request — and everything
  // waiting behind it — open indefinitely. The window is generous because a real
  // 4 MB chat payload on a bad mobile link is slow, not malicious; the ceiling
  // exists to stop a slowloris POST from tying up a worker forever.
  const timeoutMs = Number(process.env.BODY_TIMEOUT_MS) || 60_000;
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
    let settled = false;
    let timer = null;

    // One path out of the reader, so a late 'error' after a timeout or an oversized
    // chunk cannot settle the same promise twice.
    const stop = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) fail(error);
      else done(value);
    };

    timer = setTimeout(() => {
      // Paused, not destroyed: the 408 still has to reach the client. The socket
      // then has to be closed on purpose, because pausing is exactly what leaves it
      // half-read and waiting for the rest of a body that is never coming.
      req.pause();
      stop(markClose(new HttpError(408, 'Request body did not arrive in time')));
    }, timeoutMs);
    timer.unref();

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        req.pause();
        stop(markClose(new HttpError(413, 'Request body too large')));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => stop(null, Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => stop(err));
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

// Behind a proxy every request arrives from the proxy's address, which would
// collapse all visitors into one login rate-limit bucket — one person's bad
// passwords would lock the whole service out. TRUST_PROXY=1 is only safe when
// something you control really did set X-Forwarded-For, because a client can
// otherwise pick its own IP and dodge the limiter.
export function clientIp(req) {
  if (String(process.env.TRUST_PROXY || '').trim() === '1') {
    const first = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (first) return first.slice(0, 64);
  }
  return req.socket?.remoteAddress || 'unknown';
}

// The socket idle timer in server.js is what kills a slowloris, but it would also
// reap a chat that goes silent while the model thinks. The long routes clear it for
// their own socket; Node re-arms keepAliveTimeout when the response finishes.
export function clearIdleTimeout(req) {
  req.socket?.setTimeout?.(0);
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
