/* Shared session + sign-in overlay. Loaded before app.js / pricing.js / admin.js. */
window.Auth = (() => {
  'use strict';

  const state = {
    user: null,
    disabled: false,
    apiError: '',
    // Replaced by the server's number on the first /api answer. Zero until then:
    // an assumed margin would be shown as a price before anything is known.
    markupPercent: 0,
    priceBookSize: 0,
    oauth: [],
    ready: false
  };
  const listeners = new Set();

  const CFG = window.DEVCHAT || { root: '', remote: false, tokenKey: 'devchat.token.v1' };
  const API_ROOT = CFG.root;
  const REMOTE = CFG.remote;
  const TOKEN_KEY = CFG.tokenKey;

  function readToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || '';
    } catch {
      return '';
    }
  }

  function writeToken(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* private mode: nothing to clear, and the cookie path still works locally */
    }
  }

  function apiUrl(path) {
    return API_ROOT + path;
  }

  // A key held for this tab and nothing more: one module variable, never in
  // localStorage, never in a cookie, never in a URL, never in the chat history
  // the page keeps on disk. Reloading the page forgets it, which is the point.
  // The server accepts it in a request header and uses it for that call only.
  let sessionKey = '';
  const KEY_SHAPE = /^sk-[A-Za-z0-9_-]{16,}$/;

  // A split deployment cannot hand a finished sign-in over as a cookie — page and
  // API are different sites there, and Safari drops third-party cookies — so the
  // callback returns the session in the URL fragment instead. A fragment is never
  // sent to the server, so it stays out of access logs, and this wipes it from the
  // address bar the moment it has been read.
  function takeFragmentToken() {
    const mark = '#devchat_oauth=';
    if (!location.hash.startsWith(mark)) return;
    writeToken(decodeURIComponent(location.hash.slice(mark.length)));
    history.replaceState(null, '', location.pathname + location.search);
  }

  // The callback only ever redirects back with one of these fixed words, so a
  // provider cannot put its own sentence in front of the user.
  const OAUTH_NOTICES = {
    cancelled: 'That sign-in was cancelled.',
    incomplete: 'The provider sent back an incomplete answer. Try again.',
    tampered: 'That sign-in did not start in this browser. Try again.',
    expired: 'That sign-in took too long. Try again.',
    mismatch: 'That sign-in was started somewhere else. Try again.',
    provider: 'The provider refused the sign-in. Try again, or use your password.',
    disabled: 'This account has been disabled. Ask an administrator to re-enable it.'
  };
  let oauthNotice = '';

  function takeOauthNotice() {
    const params = new URLSearchParams(location.search);
    const reason = params.get('oauth');
    if (!reason) return;
    params.delete('oauth');
    const query = params.toString();
    history.replaceState(null, '', location.pathname + (query ? `?${query}` : ''));
    oauthNotice = OAUTH_NOTICES[reason] || 'Sign-in did not complete. Try again.';
  }

  function authHeaders(extra) {
    const headers = Object.assign({}, extra);
    const token = REMOTE ? readToken() : '';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (sessionKey) headers['X-DevChat-Key'] = sessionKey;
    return headers;
  }

  // True when the pasted value has the shape of a provider key. Nothing else is
  // checked here: only the provider can say whether the key works, and asking it
  // costs the key owner money.
  function setSessionKey(value) {
    const plain = String(value || '').trim();
    if (!KEY_SHAPE.test(plain)) return false;
    sessionKey = plain;
    return true;
  }

  function clearSessionKey() {
    sessionKey = '';
  }

  async function api(path, { method = 'GET', body, signal } = {}) {
    const init = {
      method,
      signal,
      credentials: REMOTE ? 'omit' : 'same-origin',
      headers: authHeaders()
    };
    if (method !== 'GET' && method !== 'HEAD') {
      // The server rejects a mutating request without a JSON content type,
      // which is also what makes a cross-site form post unable to forge one.
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body === undefined ? {} : body);
    }
    let res;
    try {
      res = await fetch(apiUrl(path), init);
    } catch (err) {
      // A CSP-blocked and a CORS-blocked request both surface as an opaque
      // TypeError, so name the two things it could actually be.
      return {
        ok: false,
        status: 0,
        data: {
          error: REMOTE
            ? `Cannot reach ${API_ROOT}. Check that the backend is running and that its `
              + `ALLOWED_ORIGINS lists ${location.origin}.`
            : `Cannot reach the server: ${err.message}`
        }
      };
    }
    const text = await res.text().catch(() => '');
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    const envelope = data && typeof data === 'object' && typeof data.error === 'string';
    if (!res.ok && !envelope) {
      data = { error: describeFailure(res, path) };
    }
    // The server only returns a token when it saw a cross-origin request; the
    // cookie path leaves it out and nothing here changes.
    if (data && data.token) writeToken(data.token);
    return { ok: res.ok, status: res.status, data: data || {} };
  }

  /**
   * The same call for a route that answers with a file instead of JSON — spoken
   * audio is bytes, and api() above would try to parse them as text. Resolved in
   * the same envelope shape so Auth.guard(res) works on it unchanged; on a failure
   * the body is read as JSON for the server's own error message.
   */
  async function apiBinary(path, { method = 'POST', body, signal } = {}) {
    let res;
    try {
      res = await fetch(apiUrl(path), {
        method,
        signal,
        credentials: REMOTE ? 'omit' : 'same-origin',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body === undefined ? {} : body)
      });
    } catch (err) {
      return { ok: false, status: 0, blob: null, data: { error: `Cannot reach the server: ${err.message}` } };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let data = null;
      try { data = JSON.parse(text); } catch { /* a plain-text or HTML refusal */ }
      const envelope = data && typeof data === 'object' && typeof data.error === 'string';
      return {
        ok: false,
        status: res.status,
        blob: null,
        data: envelope ? data : { error: describeFailure(res, path) }
      };
    }
    return { ok: true, status: res.status, blob: await res.blob(), data: {} };
  }

  // A CDN, a static host or a rewrite that never reached the API all answer with
  // their own error page — and not every one of them is HTML. Rendering that as
  // "Request failed (404)" throws away the only diagnosis the user can act on, so
  // anything that is not our own {error} envelope gets explained instead.
  function describeFailure(res, path) {
    const where = (API_ROOT || location.origin) + path;
    if (res.status === 404 || res.status === 405) {
      return `No DevChat API is answering at ${where}. That address is a static host, so it can `
        + 'serve the page but not the accounts, keys or chat. Run the Node server somewhere with '
        + 'a disk, put its address in DEVCHAT_API in public/config.js, and add this page’s origin '
        + 'to that server’s ALLOWED_ORIGINS.';
    }
    if (!/json/i.test(res.headers.get('content-type') || '')) {
      return `The server replied ${res.status} with a page instead of JSON — ${where} is not the DevChat API.`;
    }
    return `Request failed (${res.status})`;
  }

  function emit() {
    for (const fn of listeners) {
      try {
        fn(state.user);
      } catch (err) {
        console.error('[auth] listener failed', err);
      }
    }
  }

  function onSession(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  async function refresh() {
    const res = await api('/api/me');
    // /api/me answers 200 even when nobody is signed in. Only these three
    // signatures mean "that address is not a DevChat API" — a 500 from a real API
    // is a server fault, and labelling it as a missing server hides the cause.
    state.apiError = [0, 404, 405].includes(res.status)
      ? res.data.error || `Request failed (${res.status})`
      : '';
    state.user = res.data.user || null;
    // A token the server no longer knows about would be replayed on every request
    // for as long as the tab stayed open.
    if (REMOTE && res.ok && !res.data.user) writeToken('');
    state.disabled = Boolean(res.data.disabled);
    state.markupPercent = Number(res.data.markupPercent) || 0;
    state.priceBookSize = Number(res.data.priceBookSize) || 0;
    state.oauth = Array.isArray(res.data.oauth) ? res.data.oauth.filter((p) => p === 'google' || p === 'github') : [];
    state.ready = true;
    return state.user;
  }

  /* ------------------------------------------------------------------ markup */

  const OVERLAY_HTML = `
<div class="ov-card" role="dialog" aria-modal="true" aria-labelledby="ovTitle">
  <div class="ov-logo" aria-hidden="true">
    <img src="/logo-mark.jpg" alt="" width="52" height="52">
  </div>

  <div class="ov-pane" data-pane="auth">
    <h1 id="ovTitle">Sign in to DevChat</h1>
    <p class="ov-sub">Your chats, your model list and your spend all live behind an account.</p>
    <p class="ov-notice" data-oauth-notice hidden></p>

    <div class="ov-oauth" data-oauth hidden>
      <div class="ov-providers" data-oauth-buttons></div>
      <p class="ov-note ov-privnote">
        Only a name, an address and an avatar come back from the provider. Your <code>sk-</code> key
        is still yours to paste, and still nothing else can read it.
      </p>
      <p class="ov-or"><span>or use a username</span></p>
    </div>

    <div class="ov-tabs" role="tablist">
      <button type="button" class="ov-tab is-on" data-mode="login" role="tab">Sign in</button>
      <button type="button" class="ov-tab" data-mode="register" role="tab">Create account</button>
    </div>

    <form class="ov-form" data-form="auth" novalidate>
      <label class="ov-field">
        <span>Username</span>
        <input name="username" autocomplete="username" autocapitalize="none" spellcheck="false"
               minlength="3" maxlength="32" required placeholder="3-32 characters">
      </label>
      <label class="ov-field">
        <span>Password</span>
        <input name="password" type="password" autocomplete="current-password" minlength="8" required
               placeholder="At least 8 characters">
      </label>
      <p class="ov-error" data-error hidden></p>
      <button type="submit" class="ov-submit">
        <span data-submit-label>Sign in</span>
      </button>
    </form>

    <p class="ov-note">Open sign-up. No email, no invite code.</p>
  </div>

  <div class="ov-pane" data-pane="key" hidden>
    <h1>Add your API key</h1>
    <p class="ov-sub">
      DevChat never pays for your tokens. Every request is signed with <b>your</b> key, so you are
      billed directly by the provider at the ckey.vn list price.
    </p>
    <form class="ov-form" data-form="key" novalidate>
      <label class="ov-field">
        <span>API key &mdash; this tab only, unless you save it</span>
        <input name="apiKey" type="password" autocomplete="off" autocapitalize="none"
               spellcheck="false" placeholder="sk-xxxxxxxxxxxxxxxx" required>
      </label>
      <p class="ov-error" data-error hidden></p>
      <button type="submit" class="ov-submit" data-mode="session">
        <span data-submit-label>Use for this tab only</span>
      </button>
      <button type="submit" class="ov-link" data-mode="save">
        <span data-submit-label>Save it on the server</span>
      </button>
      <button type="button" class="ov-link" data-act="key-later">Skip for now</button>
    </form>
    <p class="ov-note">
      <b>This tab only</b> keeps the key in this page&rsquo;s memory and sends it once per
      request. Nothing is written to storage, and reloading the page asks you again.
      <br>
      <b>Save on the server</b> is the advanced choice: encrypted with AES-256-GCM, bound to
      your account, shown back only as <code>sk-&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;62a6</code>. Saving
      sends one 1-token test request to verify it, which costs the provider&rsquo;s minimum
      charge (about 2&nbsp;&#8363;) on your key.
    </p>
  </div>

  <div class="ov-pane" data-pane="offline" hidden>
    <h1>No server behind this page</h1>
    <p class="ov-sub" data-offline-detail></p>
    <p class="ov-note">
      This is only the interface. Accounts, encrypted keys and chat history live in the Node
      server, which cannot run on a static host — it needs a machine with a disk. See
      <b>Deploying it</b> in the README, then point <code>DEVCHAT_API</code> at it.
    </p>
    <button type="button" class="ov-submit" data-act="retry"><span data-submit-label>Try again</span></button>
  </div>

  <div class="ov-pane" data-pane="disabled" hidden>
    <h1>Account disabled</h1>
    <p class="ov-sub">An administrator has disabled this account. Ask them to re-enable it.</p>
    <button type="button" class="ov-submit" data-act="signout">Sign out</button>
  </div>

  <footer class="ov-foot">
    <a href="/pricing.html">Pricing calculator</a>
    <span class="ov-sep">&middot;</span>
    <button type="button" class="ov-link" data-act="signout">Sign out</button>
  </footer>
</div>`;

  let overlayEl = null;
  let mode = 'login';
  let afterAuth = null;

  // Both marks are the providers' own published shapes, drawn inline because a
  // logo fetched from the provider would be a third party on the login screen —
  // and a request that tells them somebody is about to sign in.
  const PROVIDER_MARKS = {
    google: `<svg viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 4.18C12.43 13.24 17.88 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.28-3.14.76-4.59l-7.98-4.18C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.55 10.78l7.98-4.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.12 0-11.57-3.74-13.47-9.06l-7.98 4.18C6.51 42.62 14.62 48 24 48z"/>
    </svg>`,
    github: `<svg viewBox="0 0 16 16" aria-hidden="true">
      <path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
    </svg>`
  };

  const PROVIDER_LABELS = { google: 'Continue with Google', github: 'Continue with GitHub' };
  const PROVIDER_NAMES = { google: 'Google', github: 'GitHub' };

  function renderOauth() {
    const el = ensureOverlay();
    const box = el.querySelector('[data-oauth]');
    const buttons = el.querySelector('[data-oauth-buttons]');
    buttons.textContent = '';
    // Whatever the server says it offers, a name with no mark here would render a
    // button that navigates to a route which does not exist.
    const offered = state.oauth.filter((provider) => PROVIDER_MARKS[provider]);
    box.hidden = offered.length === 0;
    for (const provider of offered) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ov-provider';
      button.dataset.oauthProvider = provider;
      button.innerHTML = `<span class="ov-mark">${PROVIDER_MARKS[provider]}</span>`
        + `<span data-provider-label>${PROVIDER_LABELS[provider]}</span>`;
      buttons.append(button);
    }
  }

  function ensureOverlay() {
    if (overlayEl) return overlayEl;
    overlayEl = document.createElement('div');
    overlayEl.className = 'ov';
    overlayEl.id = 'authOverlay';
    overlayEl.hidden = true;
    overlayEl.innerHTML = OVERLAY_HTML;
    document.body.appendChild(overlayEl);
    wireOverlay();
    return overlayEl;
  }

  function pane(name) {
    const el = ensureOverlay();
    for (const p of el.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== name;
    if (name === 'auth') {
      renderOauth();
      // A failed callback lands on the plain page, so the reason has to turn up in
      // the pane that appears next — which is this one. It gets its own line rather
      // than the form's error box, because a later showSignIn() from any 401 (the
      // model list loading right after this) wipes that box.
      if (oauthNotice) {
        const note = el.querySelector('[data-oauth-notice]');
        note.textContent = oauthNotice;
        note.hidden = false;
        oauthNotice = '';
      }
    }
    const foot = el.querySelector('.ov-foot');
    // Sign-out is meaningless without a session, and so is a pricing link when
    // the page cannot reach the server that prices anything.
    foot.hidden = name === 'auth' || name === 'offline';
    return el;
  }

  function setError(scope, message) {
    const box = scope.querySelector('[data-error]');
    if (!box) return;
    box.textContent = message || '';
    box.hidden = !message;
  }

  // `target` is the button that was pressed, when a form has more than one. The
  // other button keeps its own label so a wait does not look like it belongs to
  // the choice you did not make.
  function busy(scope, on, label, target) {
    const form = scope.closest('form') || scope;
    const btn = (target || form).querySelector('[data-submit-label]');
    const submit = target || form.querySelector('.ov-submit');
    if (btn) btn.textContent = on ? 'Working…' : label;
    if (submit) submit.disabled = on;
    for (const input of form.querySelectorAll('input')) input.disabled = on;
  }

  function setMode(next) {
    mode = next;
    const el = ensureOverlay();
    for (const tab of el.querySelectorAll('.ov-tab')) tab.classList.toggle('is-on', tab.dataset.mode === mode);
    const form = el.querySelector('[data-form="auth"]');
    const label = el.querySelector('[data-form="auth"] [data-submit-label]');
    const heading = el.querySelector('[data-pane="auth"] h1');
    const password = form.querySelector('input[name="password"]');
    if (mode === 'register') {
      label.textContent = 'Create account';
      heading.textContent = 'Create your account';
      password.setAttribute('autocomplete', 'new-password');
    } else {
      label.textContent = 'Sign in';
      heading.textContent = 'Sign in to DevChat';
      password.setAttribute('autocomplete', 'current-password');
    }
    setError(form, '');
  }

  function wireOverlay() {
    const el = overlayEl;

    for (const tab of el.querySelectorAll('.ov-tab')) {
      tab.addEventListener('click', () => setMode(tab.dataset.mode));
    }

    el.querySelector('[data-form="auth"]').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const username = form.username.value.trim();
      const password = form.password.value;
      if (!username || !password) return setError(form, 'Enter both a username and a password.');

      const path = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
      busy(form, true, mode === 'register' ? 'Create account' : 'Sign in');
      setError(form, '');
      const res = await api(path, { method: 'POST', body: { username, password } });
      busy(form, false, mode === 'register' ? 'Create account' : 'Sign in');

      if (!res.ok) {
        setError(form, res.data.error || `Request failed (${res.status})`);
        return;
      }
      form.password.value = '';
      // A new session in this tab gets a new key. Leaving the old one attached
      // would spend somebody else's credit against the account you just opened.
      clearSessionKey();
      state.user = res.data.user;
      state.apiError = '';
      state.disabled = false;
      state.markupPercent = Number(res.data.markupPercent) || state.markupPercent;
      hide();
      emit();
      const done = afterAuth;
      afterAuth = null;
      if (done) done(state.user);
    });

    el.querySelector('[data-form="key"]').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const apiKey = form.apiKey.value.trim();
      if (!apiKey) return setError(form, 'Paste your key first.');
      if (!/^sk-/.test(apiKey)) return setError(form, 'Provider keys start with "sk-".');

      // Enter presses the first button, and the first button is the one that keeps
      // the key in this tab. Saving to the server always takes a deliberate click.
      const pressed = event.submitter || form.querySelector('[data-mode="session"]');
      const save = pressed.dataset.mode === 'save';

      if (!save) {
        if (!setSessionKey(apiKey)) {
          return setError(form, 'That key is too short, or has a character a provider key does not use.');
        }
        form.apiKey.value = '';
        hide();
        emit();
        const done = afterAuth;
        afterAuth = null;
        if (done) done(state.user, { sessionKey: true });
        return;
      }

      busy(form, true, 'Save it on the server', pressed);
      setError(form, '');
      const res = await api('/api/key', { method: 'POST', body: { apiKey } });
      busy(form, false, 'Save it on the server', pressed);

      if (!res.ok) {
        setError(form, res.data.error || `Could not save that key (${res.status})`);
        return;
      }
      form.apiKey.value = '';
      // Saving replaces whatever this tab was holding: two keys, one silent about
      // which paid, is worse than one.
      clearSessionKey();
      state.user = res.data.user;
      if (res.data.warning) console.warn('[key]', res.data.warning);
      hide();
      emit();
      const done = afterAuth;
      afterAuth = null;
      if (done) done(state.user, { warning: res.data.warning || null });
    });

    el.addEventListener('click', (event) => {
      const provider = event.target.closest('[data-oauth-provider]');
      if (provider) {
        // A top-level navigation, not a fetch: the provider has to show its own
        // page in the browser, and nothing about the token ever passes through
        // JavaScript on the way back.
        for (const button of el.querySelectorAll('[data-oauth-provider]')) button.disabled = true;
        provider.dataset.busy = 'on';
        const label = provider.querySelector('[data-provider-label]');
        // A handover to another site looks identical to a dead button for the second
        // it takes, so the one you pressed says what it is doing.
        if (label) label.textContent = `Opening ${PROVIDER_NAMES[provider.dataset.oauthProvider]}…`;
        setError(el.querySelector('[data-form="auth"]'), '');
        el.querySelector('[data-oauth-notice]').hidden = true;
        location.assign(apiUrl(`/api/auth/oauth/${provider.dataset.oauthProvider}`));
        return;
      }
      const trigger = event.target.closest('[data-act]');
      if (!trigger) return;
      if (trigger.dataset.act === 'retry') {
        boot().catch(() => {});
        return;
      }
      if (trigger.dataset.act === 'signout') signOut();
      if (trigger.dataset.act === 'key-later') {
        hide();
        const done = afterAuth;
        afterAuth = null;
        if (done) done(state.user, { skippedKey: true });
      }
    });
  }

  function show(nextPane, callback) {
    const el = pane(nextPane);
    afterAuth = callback || null;
    el.hidden = false;
    document.documentElement.classList.add('ov-open');
    const focusTarget = el.querySelector(`[data-pane="${nextPane}"]:not([hidden]) input`);
    if (focusTarget) setTimeout(() => focusTarget.focus(), 30);
    return el;
  }

  function hide() {
    if (!overlayEl) return;
    overlayEl.hidden = true;
    document.documentElement.classList.remove('ov-open');
  }

  function showSignIn(callback) {
    setMode('login');
    show('auth', callback);
  }

  function showKeyGate(callback) {
    show('key', callback);
  }

  function showDisabled() {
    show('disabled');
  }

  function showOffline(message) {
    const el = show('offline');
    el.querySelector('[data-offline-detail]').textContent = message || '';
  }

  async function signOut() {
    await api('/api/auth/logout', { method: 'POST' });
    writeToken('');
    clearSessionKey();
    state.user = null;
    state.disabled = false;
    hide();
    emit();
    showSignIn();
  }

  /**
   * Resolves the session and shows whatever gate is missing. Emits once, so a
   * page only needs an onSession listener to know when to render — the same
   * listener then handles sign-in, sign-out and an expired session.
   */
  async function boot({ requireKey = false } = {}) {
    takeFragmentToken();
    takeOauthNotice();
    await refresh();

    if (state.apiError && !state.user) {
      showOffline(state.apiError);
      return null;
    }
    if (state.disabled) {
      showDisabled();
      return null;
    }
    if (!state.user) {
      showSignIn(() => {
        if (requireKey && !state.user?.hasKey) showKeyGate();
      });
      return null;
    }

    emit();
    if (requireKey && !state.user.hasKey) showKeyGate();
    return state.user;
  }

  /**
   * Turns a 401/403/428 from any call into the right gate, so no screen has to
   * grow its own "session expired" handling. Returns false when it intervened.
   */
  function guard(res) {
    if (res.status === 401) {
      state.user = null;
      emit();
      showSignIn();
      return false;
    }
    if (res.status === 403 && /disabled/i.test(res.data?.error || '')) {
      state.disabled = true;
      showDisabled();
      return false;
    }
    if (res.status === 428) {
      if (state.user) state.user.hasKey = false;
      showKeyGate();
      return false;
    }
    return true;
  }

  return {
    api,
    apiBinary,
    apiUrl,
    authHeaders,
    boot,
    guard,
    refresh,
    onSession,
    showSignIn,
    showKeyGate,
    hide,
    signOut,
    setSessionKey,
    clearSessionKey,
    get user() {
      return state.user;
    },
    get signedIn() {
      return Boolean(state.user);
    },
    get hasKey() {
      return Boolean(sessionKey || state.user?.hasKey);
    },
    // Which of the two keys the page is holding. Nothing here reads the key back
    // out — the value itself never leaves this module except in a request header.
    get keyMode() {
      if (sessionKey) return 'session';
      return state.user?.hasKey ? 'vault' : 'none';
    },
    get isAdmin() {
      return state.user?.role === 'admin';
    },
    get markupPercent() {
      return state.markupPercent;
    }
  };
})();
