/* Which API this page talks to. Edit DEVCHAT_API and nothing else.

   ''  →  the server that delivered the page. That is `npm start` and `npm run host`,
          and it keeps using the HttpOnly session cookie.

   For the split deployment — this folder on Vercel, the API on another host — put the
   backend origin here. The same origin must also appear in that server's
   ALLOWED_ORIGINS and in the Content-Security-Policy in vercel.json, or the browser
   silently refuses every request. */
const DEVCHAT_API = '';

(() => {
  const root = String(DEVCHAT_API || '').replace(/\/+$/, '');
  window.DEVCHAT = {
    root,
    // Across origins the session cannot be a cookie: a value set by the API host is
    // third-party storage, which Safari refuses. It becomes a bearer header instead.
    remote: root !== '' && root !== location.origin,
    tokenKey: 'devchat.token.v1'
  };
})();
