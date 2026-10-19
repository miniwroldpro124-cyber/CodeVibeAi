// Vercel entry point: one Node function answers every /api/* route, so the page
// and its API share a single origin — no CORS, the HttpOnly session cookie works,
// and the token is never handed to JavaScript. vercel.json rewrites /api/:path*
// here; see README for the environment variables this expects.
//
// It needs a hosted database. A Vercel function gets no disk that survives to the
// next request, so SQLite in data/ cannot hold accounts or encrypted API keys.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hostedConfigured, loadEnv, visibleTursoVars } from '../lib/env.js';
import { applySecurityHeaders } from '../lib/security.js';
import { sendJson } from '../lib/http.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(ROOT);

// Vercel always fronts a function with its own proxy, so without this every
// visitor shares one login rate-limit bucket and a single person's bad passwords
// locks the whole site out.
if (process.env.TRUST_PROXY === undefined) process.env.TRUST_PROXY = '1';

const API_BASE = (process.env.XAH_API_BASE || 'https://api.xah.io/v1').replace(/\/$/, '');
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'deepseek-v4.1-flash';

// Module scope lives across warm invocations of the same instance, so the schema
// is created once per instance rather than once per request.
let ready = null;

function boot() {
  if (ready) return ready;
  ready = start().catch((err) => {
    // Do not let one failed cold start poison the instance: drop the promise so
    // the next invocation retries, and let this one answer with a real message.
    ready = null;
    throw err;
  });
  return ready;
}

async function start() {
  if (!hostedConfigured()) {
    // Naming what the function can actually see separates the two ways this
    // fails: nothing injected, or injected under a name this build ignores.
    const seen = visibleTursoVars();
    throw new Error(
      'This function has nowhere to keep accounts: no hosted database is configured, and Vercel '
        + 'gives a request no disk that outlives it. Create a free Turso database — Vercel '
        + 'Marketplace → Turso Cloud, or turso.tech — then add TURSO_URL, TURSO_TOKEN and '
        + 'MASTER_KEY to the project environment variables and redeploy. '
        + `Variables this deployment can see: ${seen.length ? seen.join(', ') : 'none'}.`
    );
  }
  const { Store } = await import('../lib/db.js');
  const { assertMasterKey, bootstrapAdmin } = await import('../lib/auth.js');
  const { createApi } = await import('../lib/routes.js');
  // Before connecting: a deployment with the database but no MASTER_KEY has to say
  // so in its own words here, rather than masking it as a 500 on the first key save.
  assertMasterKey();
  const store = await Store.open();
  await bootstrapAdmin(store);
  if (process.env.AUTO_PRUNE === '1') {
    try {
      await store.pruneInactiveUsers({
        inactiveDays: Number(process.env.PRUNE_INACTIVE_DAYS) || 7,
        dataDays: Number(process.env.PRUNE_DATA_DAYS) || 3,
        apply: true
      });
    } catch (err) {
      console.error('[prune] failed:', err);
    }
  }
  return createApi({ store, env: { apiBase: API_BASE, defaultModel: DEFAULT_MODEL } });
}

// A rewrite hands the function the destination URL, so the route the browser asked
// for survives only as the captured ":path*" segments — a string for one segment,
// an array for several. `vercel dev` keeps the original path in req.url instead.
function pathnameOf(req) {
  const captured = req.query ? req.query.path : undefined;
  const tail = Array.isArray(captured) ? captured.join('/') : String(captured ?? '');
  if (tail) return `/api/${tail.replace(/^\/+/, '')}`;
  const fromUrl = String(req.url || '/').split('?')[0];
  return fromUrl.startsWith('/api/') ? fromUrl : '/api/index';
}

// The query string is dropped by the same rewrite, and an OAuth callback is
// nothing *but* a query string: `?code=…&state=…`. Read it from req.url when the
// platform kept it there, and otherwise rebuild it from the parsed `req.query`
// minus the `path` capture, so a handler never sees a request that arrived with
// its parameters silently missing.
function searchOf(req) {
  const raw = String(req.url || '');
  const at = raw.indexOf('?');
  if (at >= 0 && raw.length > at + 1) return raw.slice(at);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query || {})) {
    if (key === 'path') continue;
    for (const one of Array.isArray(value) ? value : [value]) params.append(key, String(one));
  }
  const built = params.toString();
  return built ? `?${built}` : '';
}

export default async function handler(req, res) {
  applySecurityHeaders(res);

  let handleApi;
  try {
    handleApi = await boot();
  } catch (err) {
    console.error('[api] cold start failed:', err);
    sendJson(res, 503, { error: err instanceof Error ? err.message : 'DevChat API is unavailable.' });
    return;
  }

  const url = new URL(pathnameOf(req) + searchOf(req), `http://${req.headers.host || 'localhost'}`);
  try {
    if (!(await handleApi(req, res, url))) sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    // handleApi traps its own route errors; getting here means the response
    // object itself misbehaved, which must still not surface internals.
    console.error(`[api] ${req.method} ${url.pathname}:`, err);
    sendJson(res, 500, { error: 'Internal server error' });
  }
}
