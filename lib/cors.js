// The split deployment: the page is served by one host (Vercel) and this API by
// another. Every request then carries an Origin that can never match Host, so
// neither the CORS reply nor the CSRF check can assume same-origin. Both consult
// ALLOWED_ORIGINS — a comma-separated list of exact page origins.

// Read lazily: server.js calls loadEnv() after the import graph has already been
// evaluated, so process.env is still missing .env values at module scope.
let cached;
function allowedOrigins() {
  if (!cached) {
    cached = new Set(
      String(process.env.ALLOWED_ORIGINS || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    );
  }
  return cached;
}

export function requestOrigin(req) {
  try {
    return new URL(String(req.headers.origin)).origin.toLowerCase();
  } catch {
    return null;
  }
}

// Compared by host, not origin: a TLS-terminating proxy forwards the request over
// plain HTTP, so the browser's https:// scheme will never match what we see.
export function isCrossOrigin(req) {
  const origin = requestOrigin(req);
  if (!origin) return false;
  try {
    return new URL(origin).host !== String(req.headers.host || '');
  } catch {
    return false;
  }
}

// A missing Origin is not a CSRF risk: only a browser sends it, and no browser
// lets a page forge one. Native callers and health checks arrive without it.
export function originAllowed(req) {
  const origin = requestOrigin(req);
  if (!origin || !isCrossOrigin(req)) return true;
  return allowedOrigins().has(origin);
}

export function applyCors(req, res) {
  const origin = requestOrigin(req);
  if (!origin || !isCrossOrigin(req) || !allowedOrigins().has(origin)) return;
  // Deliberately no Access-Control-Allow-Credentials: across origins the session
  // rides in the Authorization header, so nothing ambient is ever sent.
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
}

export function handlePreflight(req, res) {
  const origin = requestOrigin(req);
  if (origin && allowedOrigins().has(origin)) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Max-Age': '600',
      'Vary': 'Origin',
      'Content-Length': '0'
    });
  } else {
    res.writeHead(405, { 'Content-Length': '0' });
  }
  res.end();
  return true;
}
