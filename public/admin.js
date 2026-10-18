(() => {
  'use strict';

  const { $, $$, esc, vnd, int, relTime, initTheme } = window.Page;

  const els = {
    stats: $('#stats'),
    spark: $('#spark'),
    sparkLabels: $('#sparkLabels'),
    rangeLabel: $('#rangeLabel'),
    userRows: $('#userRows'),
    userCount: $('#userCount'),
    userQ: $('#userQ'),
    byUserRows: $('#byUserRows'),
    byModelRows: $('#byModelRows'),
    recentRows: $('#recentRows'),
    secStats: $('#secStats'),
    guardRows: $('#guardRows'),
    eventRows: $('#eventRows'),
    markup: $('#markup'),
    markupNum: $('#markupNum'),
    markupVal: $('#markupVal'),
    markupMsg: $('#markupMsg')
  };

  const state = {
    days: 30,
    markupPercent: 20,
    users: [],
    userQuery: '',
    me: null,
    security: null
  };

  // Every account/role mutation asks for the admin password again unless the
  // browser signed in recently, so a stolen or forgotten cookie cannot edit
  // users on its own. The server replies 401 + reauth_required; we prompt once
  // and repeat the same request with confirmPassword.
  async function post(path, body, label, method = 'POST') {
    let res = await Auth.api(path, { method, body });
    if (res.status === 401 && res.data.code === 'reauth_required') {
      const password = prompt(
        `Confirm your admin password to ${label || 'apply this change'}.` +
          '\n\nThis only asks when your sign-in is more than a few minutes old.'
      );
      if (password === null) return { ok: false, cancelled: true, status: 0, data: {} };
      res = await Auth.api(path, { method, body: { ...body, confirmPassword: password } });
      if (res.status === 401 && res.data.code === 'bad_password') say('That password is not correct.', false);
    }
    return res;
  }

  function say(html, ok = true) {
    els.markupMsg.innerHTML = html;
    els.markupMsg.hidden = false;
    els.markupMsg.style.borderLeftColor = ok ? 'var(--accent)' : 'var(--danger)';
    clearTimeout(say.timer);
    say.timer = setTimeout(() => { els.markupMsg.hidden = true; }, 5000);
  }

  /* --------------------------------------------------------------- overview */

  function stat(value, label, accent = false) {
    return `<div class="stat${accent ? ' accent' : ''}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
  }

  function renderStats(data) {
    const t = data.totals || {};
    const requests = Number(t.requests) || 0;
    const actual = Number(t.actual_cost) || 0;
    const billed = Number(t.billed_cost) || 0;
    const tokens = (Number(t.prompt_tokens) || 0) + (Number(t.completion_tokens) || 0);
    const failed = Number(t.failed) || 0;
    const margin = billed - actual;
    const avg = requests ? actual / requests : 0;

    els.stats.innerHTML = [
      stat(vnd(billed), `Billed (+${data.markupPercent}%)`, true),
      stat(vnd(actual), 'Actual provider cost'),
      stat(vnd(margin), 'Markup margin'),
      stat(int(requests), 'Requests'),
      stat(int(tokens), 'Tokens'),
      stat(int(data.userCount), `Users · ${int(data.adminCount)} admin`),
      stat(vnd(avg), 'Avg / request'),
      stat(failed ? int(failed) : '0', 'Failed', Boolean(failed))
    ].join('');
  }

  function renderSpark(byDay) {
    const days = Array.isArray(byDay) ? byDay : [];
    if (!days.length) {
      els.spark.innerHTML = '';
      els.sparkLabels.innerHTML = '<span>No requests in this range yet.</span><span></span>';
      return;
    }
    const max = Math.max(...days.map((d) => Number(d.billed_cost) || 0), 0.0001);
    // The height goes on through the CSSOM rather than a style="…" attribute:
    // the page ships a Content-Security-Policy that rejects inline styles.
    els.spark.innerHTML = days.map((d) => {
      const pct = Math.max(2, Math.round(((Number(d.billed_cost) || 0) / max) * 100));
      return `<i data-h="${pct}" title="${esc(d.day)} — ${int(d.requests)} req, ${esc(vnd(d.billed_cost))}"></i>`;
    }).join('');
    for (const bar of els.spark.children) bar.style.height = `${bar.dataset.h}%`;
    els.sparkLabels.innerHTML = `<span>${esc(days[0].day)}</span><span>${esc(days[days.length - 1].day)}</span>`;
  }

  function emptyRow(cols, message) {
    return `<tr class="empty-row"><td colspan="${cols}">${esc(message)}</td></tr>`;
  }

  function renderByUser(rows) {
    if (!rows.length) {
      els.byUserRows.innerHTML = emptyRow(7, 'No usage recorded in this range.');
      return;
    }
    els.byUserRows.innerHTML = rows.map((r) => `
      <tr>
        <td class="mono">${esc(r.username)}${r.status !== 'active' ? ' <span class="pill off">off</span>' : ''}</td>
        <td class="num">${int(r.requests)}</td>
        <td class="num">${int(r.failed)}</td>
        <td class="num">${int(r.prompt_tokens)}</td>
        <td class="num">${int(r.completion_tokens)}</td>
        <td class="num">${esc(vnd(r.actual_cost))}</td>
        <td class="num">${esc(vnd(r.billed_cost))}</td>
      </tr>`).join('');
  }

  function renderByModel(rows) {
    if (!rows.length) {
      els.byModelRows.innerHTML = emptyRow(6, 'No usage recorded in this range.');
      return;
    }
    els.byModelRows.innerHTML = rows.map((r) => `
      <tr>
        <td class="mono">${esc(r.model)}</td>
        <td class="num">${int(r.requests)}</td>
        <td class="num">${int(r.prompt_tokens)}</td>
        <td class="num">${int(r.completion_tokens)}</td>
        <td class="num">${esc(vnd(r.actual_cost))}</td>
        <td class="num">${esc(vnd(r.billed_cost))}</td>
      </tr>`).join('');
  }

  function renderRecent(rows) {
    if (!rows.length) {
      els.recentRows.innerHTML = emptyRow(9, 'No requests yet.');
      return;
    }
    els.recentRows.innerHTML = rows.map((r) => `
      <tr>
        <td class="mono" title="${esc(new Date(r.created_at).toLocaleString())}">${esc(relTime(r.created_at))}</td>
        <td class="mono">${esc(r.username)}</td>
        <td class="mono">${esc(r.model)}</td>
        <td class="num">${int((Number(r.prompt_tokens) || 0) + (Number(r.completion_tokens) || 0))}</td>
        <td class="num">${esc(vnd(r.actual_cost))}</td>
        <td class="num">${esc(vnd(r.billed_cost))}</td>
        <td class="num">${esc(vnd(r.estimate_cost))}</td>
        <td class="num">${r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
        <td>${r.ok ? '<span class="pill ok">ok</span>' : `<span class="pill off" title="${esc(r.error || '')}">failed</span>`}</td>
      </tr>`).join('');
  }

  /* ------------------------------------------------------------------ users */

  function renderUsers() {
    const q = state.userQuery.trim().toLowerCase();
    const rows = state.users.filter((u) => !q || u.username.toLowerCase().includes(q));
    els.userCount.textContent = `${int(rows.length)} of ${int(state.users.length)} users`;

    if (!rows.length) {
      els.userRows.innerHTML = emptyRow(11, 'No user matches that filter.');
      return;
    }

    els.userRows.innerHTML = rows.map((u) => {
      const self = u.id === state.me?.id;
      const active = u.status === 'active';
      const admin = u.role === 'admin';
      const tokens = (Number(u.prompt_tokens) || 0) + (Number(u.completion_tokens) || 0);
      const locked = Number(u.locked_until) > Date.now();
      return `
      <tr>
        <td class="mono">${esc(u.username)}${self ? ' <span class="pill dim">you</span>' : ''}</td>
        <td>${admin ? '<span class="pill ok">admin</span>' : '<span class="pill dim">user</span>'}</td>
        <td>${active ? '<span class="pill ok">active</span>' : '<span class="pill off">disabled</span>'}</td>
        <td class="mono" data-guard="secret">${u.api_key_hint ? esc(u.api_key_hint) : '<span class="pill dim">none</span>'}</td>
        <td class="num">${int(u.requests)}</td>
        <td class="num">${int(tokens)}</td>
        <td class="num">${esc(vnd(u.actual_cost))}</td>
        <td class="num">${esc(vnd(u.billed_cost))}</td>
        <td class="mono">${esc(relTime(u.last_seen_at))}</td>
        <td class="mono">${int(u.sessions || 0)}${locked ? ' <span class="pill off" title="Locked by failed sign-ins">locked</span>' : ''}</td>
        <td>
          <div class="row-actions">
            ${Number(u.sessions) > 0 ? `<button class="mini-btn" data-act="sessions" data-id="${u.id}" data-name="${esc(u.username)}">Sign out</button>` : ''}
            ${self ? '' : `
              <button class="mini-btn" data-act="status" data-id="${u.id}" data-name="${esc(u.username)}" data-next="${active ? 'disabled' : 'active'}">${active ? 'Disable' : 'Enable'}</button>
              <button class="mini-btn" data-act="role" data-id="${u.id}" data-name="${esc(u.username)}" data-next="${admin ? 'user' : 'admin'}">${admin ? 'Demote' : 'Promote'}</button>
              <button class="mini-btn" data-act="password" data-id="${u.id}" data-name="${esc(u.username)}" data-role="${esc(u.role)}">Password</button>
              <button class="mini-btn danger" data-act="delete" data-id="${u.id}" data-name="${esc(u.username)}">Delete</button>
            `}
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  async function loadUsers() {
    const res = await Auth.api('/api/admin/users');
    if (!res.ok) {
      if (!Auth.guard(res)) return;
      els.userRows.innerHTML = emptyRow(10, res.data.error || 'Could not load users');
      return;
    }
    state.users = res.data.users || [];
    const markup = Number(res.data.markupPercent);
    if (Number.isFinite(markup)) state.markupPercent = markup;
    renderUsers();
  }

  async function loadOverview() {
    const res = await Auth.api(`/api/admin/overview?days=${state.days}`);
    if (!res.ok) {
      if (!Auth.guard(res)) return;
      els.stats.innerHTML = stat('—', res.data.error || 'Could not load');
      return;
    }
    const data = res.data;
    els.rangeLabel.textContent = data.days >= 1 && data.days < 2 ? 'Last 24 hours' : `Last ${data.days} days`;
    renderStats(data);
    renderSpark(data.byDay);
    renderByUser(data.byUser || []);
    renderByModel(data.byModel || []);
    renderRecent(data.recent || []);
    setMarkup(Number(data.markupPercent) || 0);
  }

  /* ----------------------------------------------------------------- markup */

  function setMarkup(value) {
    state.markupPercent = value;
    els.markup.max = String(Math.max(200, Math.ceil(value)));
    els.markup.value = String(value);
    els.markupNum.value = String(value);
    els.markupVal.textContent = String(value);
  }

  async function saveMarkup() {
    const value = Number(els.markupNum.value);
    if (!Number.isFinite(value) || value < 0 || value > 1000) {
      return say('Markup must be between 0 and 1000 percent.', false);
    }
    const res = await post('/api/admin/settings', { markupPercent: value }, 'change the markup');
    if (res.cancelled) return;
    if (!res.ok) {
      if (Auth.guard(res)) say(esc(res.data.error || 'Could not save'), false);
      return;
    }
    setMarkup(Number(res.data.markupPercent));
    say(`Markup is now <b>+${esc(res.data.markupPercent)}%</b>. Every cost shown on this site updates immediately.`);
    loadOverview();
    loadSecurity();
  }

  /* -------------------------------------------------------------- row actions */

  async function act(trigger) {
    const id = trigger.dataset.id;
    const name = trigger.dataset.name;

    if (trigger.dataset.act === 'status') {
      const next = trigger.dataset.next;
      if (next === 'disabled' && !confirm(`Disable ${name}? They are signed out immediately and cannot sign back in until enabled.`)) return;
      const res = await post(`/api/admin/users/${id}/status`, { status: next }, `set ${name} to ${next}`);
      if (!finish(res, `${name} is now ${next}.`)) return;
    }

    if (trigger.dataset.act === 'role') {
      const next = trigger.dataset.next;
      if (next === 'admin' && !confirm(`Give ${name} full admin rights?`)) return;
      if (next === 'user' && !confirm(`Remove admin rights from ${name}?`)) return;
      const res = await post(`/api/admin/users/${id}/role`, { role: next }, `change ${name}'s role`);
      if (!finish(res, `${name} is now ${next === 'admin' ? 'an admin' : 'a regular user'}.`)) return;
    }

    if (trigger.dataset.act === 'sessions') {
      const self = Number(id) === state.me?.id;
      if (!confirm(self ? 'Sign out every other device for your own account? This browser stays signed in.'
        : `Sign ${name} out of every device?`)) return;
      const res = await post(`/api/admin/users/${id}/sessions`, {}, `sign ${name} out`);
      if (!finish(res, self ? 'Other sessions were revoked.' : `${name} was signed out everywhere.`)) return;
    }

    if (trigger.dataset.act === 'password') {
      // Resets sign the user out everywhere, so a random value they cannot see
      // is worse than useless — the admin has to hand it over out of band.
      const admin = trigger.dataset.role === 'admin';
      const next = prompt(
        `New password for ${name}${admin ? ' (administrator: 12+ characters, with a letter and a number)' : ' (8-200 characters)'}.\nThey will be signed out on every device.`
      );
      if (next === null) return;
      const min = admin ? 12 : 8;
      if (next.length < min) return say(`Password must be at least ${min} characters.`, false);
      const res = await post(`/api/admin/users/${id}/password`, { password: next }, `reset ${name}'s password`);
      if (!finish(res, `Password reset for ${name}; their sessions were revoked.`)) return;
    }

    if (trigger.dataset.act === 'delete') {
      if (!confirm(`Delete ${name} permanently? Their chats' usage rows and stored API key go too.`)) return;
      const res = await post(`/api/admin/users/${id}`, {}, `delete ${name}`, 'DELETE');
      if (!finish(res, `${name} was deleted.`)) return;
    }

    if (trigger.dataset.act === 'unlock') {
      const res = await post('/api/admin/unlock', { username: name }, `unlock ${name}`);
      if (!finish(res, `Sign-in lock for ${name} cleared.`)) return;
    }
  }

  function finish(res, message) {
    if (res.cancelled) return false;
    if (!res.ok) {
      if (Auth.guard(res)) say(esc(res.data.error || `Failed (${res.status})`), false);
      return false;
    }
    say(esc(message));
    loadUsers();
    loadOverview();
    loadSecurity();
    return true;
  }

  /* ---------------------------------------------------------------- security */

  function renderSecurity(data) {
    const guards = data.guards || [];
    const lockedNow = guards.filter((g) => g.lockedSeconds > 0);
    const admins = data.admins || [];
    const p = data.policy || {};

    els.secStats.innerHTML = [
      stat(int(admins.length), `Administrator(s) · ${int(p.adminSessionHours || 12)}h sessions`, true),
      stat(int(lockedNow.length), 'Locked right now', Boolean(lockedNow.length)),
      stat(int(guards.length), 'Accounts with failed tries'),
      stat(`${p.adminPasswordChars || 12}+ chars`, 'Admin password policy'),
      stat(`${p.reauthMinutes || 10} min`, `Step-up window (${p.reauth || 'sensitive'})`),
      stat(int((data.events || []).length), 'Audit events shown')
    ].join('');

    if (!guards.length) {
      els.guardRows.innerHTML = emptyRow(6, 'No failed sign-in attempts recorded.');
    } else {
      els.guardRows.innerHTML = guards.map((g) => `
        <tr>
          <td class="mono">${esc(g.username)}${g.knownUser ? '' : ' <span class="pill dim">unknown</span>'}</td>
          <td>${g.role === 'admin' ? '<span class="pill ok">admin</span>' : `<span class="pill dim">${esc(g.role || '—')}</span>`}</td>
          <td class="num">${int(g.fails)}</td>
          <td class="mono">${g.lockedSeconds
            ? `<span class="pill off">locked ${esc(fmtMins(g.lockedSeconds))}</span>`
            : '<span class="pill dim">open</span>'}</td>
          <td class="mono">${esc(relTime(g.lastAttemptAt))}</td>
          <td>
            <div class="row-actions">
              <button class="mini-btn" data-act="unlock" data-name="${esc(g.username)}">Unlock</button>
            </div>
          </td>
        </tr>`).join('');
    }

    const events = data.events || [];
    if (!events.length) {
      els.eventRows.innerHTML = emptyRow(5, 'Nothing recorded yet. Sign-ins, locks, role changes and password resets all appear here.');
    } else {
      els.eventRows.innerHTML = events.map((e) => `
        <tr>
          <td class="mono" title="${esc(new Date(e.created_at).toLocaleString())}">${esc(relTime(e.created_at))}</td>
          <td class="mono">${esc(e.username || '—')}</td>
          <td>${eventPill(e.kind)}</td>
          <td class="mono">${esc(e.ip || '—')}</td>
          <td>${esc(e.detail || '')}</td>
        </tr>`).join('');
    }
  }

  const EVENT_KINDS = {
    login_ok: ['ok', 'signed in'],
    login_fail: ['off', 'wrong password'],
    admin_locked: ['off', 'locked'],
    login_unknown: ['dim', 'unknown name'],
    login_disabled: ['off', 'disabled try'],
    unlocked: ['ok', 'unlocked'],
    signup: ['ok', 'sign-up'],
    logout: ['dim', 'signed out'],
    password_change: ['ok', 'password changed'],
    password_current_fail: ['off', 'old password wrong'],
    reauth_fail: ['off', 'step-up failed'],
    admin_reauth: ['ok', 'step-up ok'],
    admin_role: ['dim', 'role changed'],
    admin_status: ['dim', 'status changed'],
    admin_reset_password: ['off', 'password reset by admin'],
    admin_delete_user: ['off', 'user deleted'],
    admin_revoke_sessions: ['dim', 'sessions revoked'],
    admin_markup: ['dim', 'markup changed'],
    admin_unlock: ['ok', 'unlocked by admin'],
    cli_password_reset: ['off', 'reset from CLI'],
    devtools_open: ['off', 'devtools opened'],
    automation_detected: ['off', 'automation detected'],
    guard_removed: ['off', 'guard tampered'],
    // The provider name arrives in the detail column, so the pill stays short.
    oauth_begin: ['dim', 'provider sign-in started'],
    oauth_login: ['ok', 'signed in with a provider'],
    oauth_signup: ['ok', 'account created by a provider'],
    oauth_cancel: ['dim', 'provider sign-in cancelled'],
    oauth_fail: ['off', 'provider exchange failed'],
    oauth_disabled: ['off', 'disabled provider account']
  };

  function eventPill(kind) {
    const [tone, label] = EVENT_KINDS[kind] || ['dim', kind];
    return `<span class="pill ${tone}">${esc(label)}</span>`;
  }

  function fmtMins(seconds) {
    const m = Math.ceil(seconds / 60);
    return m >= 60 ? `${Math.round(m / 60)} h` : `${m} min`;
  }

  async function loadSecurity() {
    const res = await Auth.api('/api/admin/security');
    if (!res.ok) {
      if (Auth.guard(res)) els.guardRows.innerHTML = emptyRow(6, res.data.error || 'Could not load');
      return;
    }
    state.security = res.data;
    renderSecurity(res.data);
  }

  /* ------------------------------------------------------------------ events */

  function bind() {
    initTheme($('#themeBtn'));

    els.markup.addEventListener('input', () => {
      els.markupVal.textContent = els.markup.value;
      els.markupNum.value = els.markup.value;
    });
    els.markupNum.addEventListener('input', () => {
      els.markupVal.textContent = els.markupNum.value;
      els.markup.value = els.markupNum.value;
    });
    $('#markupSave').addEventListener('click', saveMarkup);
    $('#markupReset').addEventListener('click', () => {
      setMarkup(state.markupPercent);
      els.markupMsg.hidden = true;
    });

    for (const btn of $$('[data-days]')) {
      btn.addEventListener('click', () => {
        state.days = Number(btn.dataset.days);
        for (const other of $$('[data-days]')) other.classList.toggle('is-on', other === btn);
        loadOverview();
      });
    }
    $('[data-days="30"]').classList.add('is-on');
    $('#refreshBtn').addEventListener('click', () => {
      loadOverview();
      loadUsers();
      loadSecurity();
    });

    els.userQ.addEventListener('input', () => {
      state.userQuery = els.userQ.value;
      renderUsers();
    });

    els.userRows.addEventListener('click', (event) => {
      const trigger = event.target.closest('[data-act]');
      if (trigger) act(trigger);
    });
    els.guardRows.addEventListener('click', (event) => {
      const trigger = event.target.closest('[data-act]');
      if (trigger) act(trigger);
    });
  }

  function deny(message) {
    $('.page-body').innerHTML = `
      <section class="card">
        <h2>Admin only</h2>
        <p class="card-sub">${esc(message)}</p>
        <div class="btn-row"><a class="btn btn-primary" href="/">Back to chat</a></div>
      </section>`;
  }

  async function boot() {
    bind();
    Auth.onSession((user) => {
      if (user && user.role !== 'admin') deny('Your account does not have administrator rights.');
    });

    const user = await Auth.boot();
    state.me = user;
    if (!user) return;
    if (user.role !== 'admin') return deny('Your account does not have administrator rights.');

    await Promise.all([loadOverview(), loadUsers(), loadSecurity()]);
  }

  boot();
})();
