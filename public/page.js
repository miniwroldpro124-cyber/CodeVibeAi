/* Shared helpers for the standalone pages (pricing.html, admin.html). */
window.Page = (() => {
  'use strict';

  const PREF_KEY = 'devchat.prefs.v1';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const vndFmt = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 });
  const intFmt = new Intl.NumberFormat('en-US');

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function vnd(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return `${vndFmt.format(n)} ₫`;
  }

  function int(value) {
    const n = Number(value);
    return Number.isFinite(n) ? intFmt.format(Math.round(n)) : '—';
  }

  function readPrefs() {
    try {
      return JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    } catch {
      return {};
    }
  }

  /* Theme is shared with the chat app through the same localStorage key, so
     flipping it here stays flipped there. With nothing stored, both follow the
     operating system, which is what the inline boot script in each page does. */
  function initTheme(button) {
    const prefs = readPrefs();
    const current = () => prefs.theme
      || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const apply = () => {
      const theme = current();
      document.documentElement.dataset.theme = theme;
      if (button) button.textContent = theme === 'dark' ? 'Dark' : 'Light';
    };
    apply();
    if (!button) return;
    button.addEventListener('click', () => {
      prefs.theme = current() === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
      apply();
    });
  }

  /* Both pages link to the admin panel, which only an admin may open. */
  function initNav(user) {
    const link = $('#adminLink');
    if (link) link.hidden = user?.role !== 'admin';
  }

  function relTime(ts) {
    const n = Number(ts);
    if (!n) return 'never';
    const secs = Math.round((Date.now() - n) / 1000);
    if (secs < 60) return 'just now';
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return `${Math.floor(secs / 86400)}d ago`;
  }

  /* navigator.clipboard only exists on a secure origin, and the host script serves
     the LAN over plain http, so the textarea path is what makes Copy work there. */
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(String(text));
      return true;
    } catch {
      /* fall through to the legacy path */
    }
    const area = document.createElement('textarea');
    area.value = String(text);
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '0';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }

  function flash(button, label) {
    const original = button.textContent;
    button.textContent = label;
    button.classList.add('done');
    clearTimeout(button._flash);
    button._flash = setTimeout(() => {
      button.textContent = original;
      button.classList.remove('done');
    }, 1400);
  }

  return { $, $$, esc, vnd, int, relTime, initTheme, initNav, copy, flash, prefs: readPrefs };
})();
