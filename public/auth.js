/* Shared session + sign-in overlay. Loaded before app.js / pricing.js / admin.js. */
window.Auth = (() => {
  'use strict';

  const state = {
    user: null,
    disabled: false,
    markupPercent: 20,
    priceBookSize: 0,
    ready: false
  };
  const listeners = new Set();

  async function api(path, { method = 'GET', body, signal } = {}) {
    const init = { method, credentials: 'same-origin', signal };
    if (method !== 'GET' && method !== 'HEAD') {
      // The server rejects a mutating request without a JSON content type,
      // which is also what makes a cross-site form post unable to forge one.
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body === undefined ? {} : body);
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch (err) {
      return { ok: false, status: 0, data: { error: `Cannot reach the server: ${err.message}` } };
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data: data || {} };
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
    state.user = res.data.user || null;
    state.disabled = Boolean(res.data.disabled);
    state.markupPercent = Number(res.data.markupPercent) || 0;
    state.priceBookSize = Number(res.data.priceBookSize) || 0;
    state.ready = true;
    return state.user;
  }

  /* ------------------------------------------------------------------ markup */

  const OVERLAY_HTML = `
<div class="ov-card" role="dialog" aria-modal="true" aria-labelledby="ovTitle">
  <div class="ov-logo" aria-hidden="true">
    <svg viewBox="0 0 32 32"><path d="M12 10l-6 6 6 6M20 10l6 6-6 6"/></svg>
  </div>

  <div class="ov-pane" data-pane="auth">
    <h1 id="ovTitle">Sign in to DevChat</h1>
    <p class="ov-sub">Your chats, your model list and your spend all live behind an account.</p>

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
        <span>API key</span>
        <input name="apiKey" type="password" autocomplete="new-password" autocapitalize="none"
               spellcheck="false" placeholder="sk-xxxxxxxxxxxxxxxx" required>
      </label>
      <p class="ov-error" data-error hidden></p>
      <button type="submit" class="ov-submit"><span data-submit-label>Save key</span></button>
      <button type="button" class="ov-link" data-act="key-later">Skip for now</button>
    </form>
    <p class="ov-note">
      Stored encrypted (AES-256-GCM) and shown only as <code>sk-b27&bull;&bull;&bull;&bull;62a6</code>.
      Saving sends one 1-token test request to verify it, which costs the provider's minimum
      charge (about 2&nbsp;&#8363;) on your key.
    </p>
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
    const foot = el.querySelector('.ov-foot');
    // Sign-out is meaningless when there is no session.
    foot.hidden = name === 'auth';
    return el;
  }

  function setError(scope, message) {
    const box = scope.querySelector('[data-error]');
    if (!box) return;
    box.textContent = message || '';
    box.hidden = !message;
  }

  function busy(scope, on, label) {
    const btn = scope.querySelector('[data-submit-label]');
    const form = scope.closest('form') || scope;
    const submit = form.querySelector('.ov-submit');
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
      state.user = res.data.user;
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

      busy(form, true, 'Save key');
      setError(form, '');
      const res = await api('/api/key', { method: 'POST', body: { apiKey } });
      busy(form, false, 'Save key');

      if (!res.ok) {
        setError(form, res.data.error || `Could not save that key (${res.status})`);
        return;
      }
      form.apiKey.value = '';
      state.user = res.data.user;
      if (res.data.warning) console.warn('[key]', res.data.warning);
      hide();
      emit();
      const done = afterAuth;
      afterAuth = null;
      if (done) done(state.user, { warning: res.data.warning || null });
    });

    el.addEventListener('click', (event) => {
      const trigger = event.target.closest('[data-act]');
      if (!trigger) return;
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

  async function signOut() {
    await api('/api/auth/logout', { method: 'POST' });
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
    await refresh();

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
    boot,
    guard,
    refresh,
    onSession,
    showSignIn,
    showKeyGate,
    hide,
    signOut,
    get user() {
      return state.user;
    },
    get signedIn() {
      return Boolean(state.user);
    },
    get hasKey() {
      return Boolean(state.user?.hasKey);
    },
    get isAdmin() {
      return state.user?.role === 'admin';
    },
    get markupPercent() {
      return state.markupPercent;
    }
  };
})();
