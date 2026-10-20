// What the browser is told it may run, load and frame. This is the part of
// "anti-extension" that genuinely works: with no inline script or style on the
// pages, script-src and style-src can stay at 'self', which refuses bookmarklets,
// javascript: URLs and injected <script>/<style> tags. A real browser extension's
// content script runs outside this policy and cannot be blocked from the server.
//
// One policy per kind of document, because the pages do not need the same reach.
// The media studio is the only place that displays a picture or clip hosted by the
// provider, so it is the only page that opens img-src and media-src to https:. The
// chat page needs https: for one feature — the wallpaper address typed into the
// Look panel — and model output never reaches it: remote images in an answer are
// rewritten into links before they can be fetched. Every other document is tighter.
//
// `blob:` is deliberately absent from every img-src. A picture read off the
// visitor's own disk goes through FileReader.readAsDataURL before it reaches an
// <img>, in the studio and in the look panel alike, because a CSP-refused image
// fires no error event: the load hangs and the file picker looks broken.
const SHARED = {
  'default-src': "'self'",
  'script-src': "'self'",
  'style-src': "'self'",
  'font-src': "'self'",
  // The app only ever talks to its own API; nothing may exfiltrate to a remote host.
  'connect-src': "'self'",
  'object-src': "'none'",
  'base-uri': "'none'",
  'form-action': "'self'",
  'frame-ancestors': "'none'"
};

const DOC = {
  app: {
    'img-src': "'self' data: https:",
    'media-src': "'none'"
  },
  studio: {
    'img-src': "'self' data: https:",
    'media-src': "'self' blob: data: https:"
  },
  page: {
    'img-src': "'self' data:",
    'media-src': "'none'"
  },
  // JSON and SSE only. A reply that is not a document needs nothing loadable, so
  // every directive is closed rather than narrowed.
  api: {
    'default-src': "'none'",
    'script-src': "'none'",
    'style-src': "'none'",
    'font-src': "'none'",
    'img-src': "'none'",
    'media-src': "'none'",
    'connect-src': "'none'",
    'object-src': "'none'",
    'base-uri': "'none'",
    'form-action': "'none'",
    'frame-ancestors': "'none'"
  }
};

function policy(kind) {
  const directives = kind === 'api' ? DOC.api : { ...SHARED, ...DOC[kind] };
  return Object.entries(directives)
    .map(([name, value]) => `${name} ${value}`)
    .join('; ');
}

export const POLICIES = {
  app: policy('app'),
  studio: policy('studio'),
  page: policy('page'),
  api: policy('api')
};

// The chat page is the site: `/` serves it, and the file name is the same document.
const BY_PATH = new Map([
  ['/studio.html', 'studio'],
  ['/index.html', 'app']
]);

// Called with the path of the request, so a page gets its own policy and anything
// unrecognised — coder, pricing, admin, a picture, a script, a 404 — gets the
// tightest document rather than the widest one. A policy on a script or an image
// response is ignored by the browser anyway: the document that loaded it governs.
export function policyKind(pathname) {
  const path = String(pathname || '/').split('?')[0];
  if (path === '/api' || path.startsWith('/api/')) return 'api';
  if (path === '/' || path === '') return 'app';
  return BY_PATH.get(path) || 'page';
}

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  // Doubles frame-ancestors for browsers and proxies that still honour the old header.
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  // None of these features is used, so deny them all: injected code cannot reach a
  // camera, a microphone or a payment sheet through this page. Clipboard *write* is
  // left available, because copying a code block out of an answer is the point of
  // the site.
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), interest-cohort=()'
};

export function securityHeaders(kind) {
  return { 'Content-Security-Policy': POLICIES[kind], ...SECURITY_HEADERS };
}

export function applySecurityHeaders(res, pathname = '/') {
  const headers = securityHeaders(policyKind(pathname));
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
}
