// What the browser is told it may run, load and frame. This is the part of
// "anti-extension" that genuinely works: with no inline script or style on the
// pages, script-src and style-src can stay at 'self', which refuses bookmarklets,
// javascript: URLs and injected <script>/<style> tags. A real browser extension's
// content script runs outside this policy and cannot be blocked from the server,
// so everything client-side below is a deterrent, not a wall.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  // The app only ever talks to its own API; nothing may exfiltrate to a remote host.
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

export const SECURITY_HEADERS = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  // Doubles frame-ancestors for browsers and proxies that still honour the old header.
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  // None of these features is used, so deny them all: injected code cannot reach a
  // camera, a microphone or a payment sheet through this page.
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), interest-cohort=()'
};

export function applySecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}
