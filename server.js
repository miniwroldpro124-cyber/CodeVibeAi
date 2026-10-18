import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store, DATA_DIR } from './lib/db.js';
import { bootstrapAdmin } from './lib/auth.js';
import { createApi } from './lib/routes.js';
import { sendText } from './lib/http.js';
import { applySecurityHeaders } from './lib/security.js';
import { loadEnv } from './lib/env.js';
import { reachableUrls } from './lib/net.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PUBLIC_ROOT = resolve(join(ROOT, 'public'));

loadEnv(ROOT);

const API_BASE = (process.env.XAH_API_BASE || 'https://api.xah.io/v1').replace(/\/$/, '');
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'deepseek-v4.1-flash';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

const store = new Store();
bootstrapAdmin(store);
const handleApi = createApi({
  store,
  env: { apiBase: API_BASE, defaultModel: DEFAULT_MODEL }
});

function serveStatic(req, res, pathname) {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let filePath = resolve(join(PUBLIC_ROOT, relative === sep ? 'index.html' : relative));
  if (filePath !== PUBLIC_ROOT && !filePath.startsWith(PUBLIC_ROOT + sep)) {
    return sendText(res, 403, 'Forbidden');
  }

  stat(filePath)
    .then((info) => {
      if (info.isDirectory()) filePath = join(filePath, 'index.html');
      return stat(filePath);
    })
    .then((info) => {
      if (!info.isFile()) return sendText(res, 404, 'Not found');
      const ext = extname(filePath).toLowerCase();
      // no-cache means "revalidate"; the ETag makes that a cheap 304 instead of
      // silently serving a stale app.js after an edit.
      const etag = `W/"${info.size.toString(16)}-${Math.round(info.mtimeMs).toString(16)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
        return res.end();
      }
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': info.size,
        ETag: etag,
        'Cache-Control': 'no-cache'
      });
      createReadStream(filePath).pipe(res);
    })
    .catch(() => sendText(res, 404, 'Not found'));
}

const server = createServer((req, res) => {
  applySecurityHeaders(res);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  handleApi(req, res, url)
    .then((handled) => {
      if (handled) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed');
      serveStatic(req, res, url.pathname);
    })
    .catch((err) => {
      console.error('[server]', err);
      if (!res.headersSent) sendText(res, 500, 'Internal server error');
      else res.end();
    });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use by another process.`);
    console.error('  Stop that process, or set a different PORT in .env, then start again.\n');
    process.exit(1);
  }
  throw err;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
    // Do not hang forever on a live SSE connection.
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

server.listen(PORT, HOST, () => {
  const urls = reachableUrls(HOST, PORT);
  console.log('');
  console.log('  DevChat');
  console.log(`   this computer   ${urls.local.join('   ')}`);
  for (const item of urls.lan) console.log(`   other devices   ${item.url}   (${item.name})`);
  console.log(`   admin panel     ${urls.local[0]}/admin.html`);
  console.log(`   upstream        ${API_BASE}`);
  console.log(`   data            ${DATA_DIR}`);
  console.log(`   billing         each user's own sk- key, encrypted at rest`);
  console.log(`   markup          +${store.getMarkupPercent()}% on the ckey.vn list price`);
  if (HOST === '0.0.0.0') {
    console.log('');
    console.log('   Listening on every interface: anyone on this network can register and chat');
    console.log('   with their own key. Share the LAN URL above, and run "npm run host" to see');
    console.log('   all URLs plus the firewall command.');
  }
  console.log('');
  console.log('   Admin help:  npm run admin      Ctrl+C to stop');
  console.log('');
});
