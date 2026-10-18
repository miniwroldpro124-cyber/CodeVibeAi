// Deterrent, not a wall. Anything that runs in the browser can be undone in the
// browser, so the point here is to make casual inspection annoying and to leave a
// record in the admin audit list. The protection that matters is already on the
// server: API keys never reach the page, the chat proxy whitelists its parameters,
// and charges are read from the upstream reply rather than from anything the
// client claims.
//
// Modes, set on the <script> tag: "warn" (default) shows a banner and masks the
// sensitive numbers; "strict" additionally blanks the page and probes the console;
// "off" does nothing. Anyone who legitimately needs DevTools — you — can turn this
// off permanently with localStorage.setItem('devchat.guard', 'off').
(() => {
  if (localStorage.getItem('devchat.guard') === 'off') return;

  const tag = document.currentScript || document.querySelector('script[data-mode]');
  const mode = tag?.dataset.mode === 'strict' ? 'strict' : 'warn';

  const root = document.documentElement;
  const reported = new Set();
  let banner = null;
  let bannerShown = false;
  let dismissed = false;
  let open = false;

  function report(kind, detail) {
    if (reported.has(kind)) return;
    reported.add(kind);
    // Reads config.js rather than Auth, because a guard report must still go out
    // when the rest of the app has failed to load.
    const cfg = window.DEVCHAT || { root: '', remote: false, tokenKey: 'devchat.token.v1' };
    const headers = { 'Content-Type': 'application/json' };
    try {
      const token = localStorage.getItem(cfg.tokenKey);
      if (cfg.remote && token) headers.Authorization = `Bearer ${token}`;
    } catch {
      /* private mode: the event is dropped, which is the same as no session */
    }
    try {
      fetch(`${cfg.root}/api/guard/event`, {
        method: 'POST',
        credentials: cfg.remote ? 'omit' : 'same-origin',
        headers,
        body: JSON.stringify({ kind, detail: String(detail || '').slice(0, 120) })
      }).catch(() => {});
    } catch {
      /* the page cannot reach itself; nothing else to do */
    }
  }

  const TEXT = {
    warn: 'Developer tools are open. The API key hint is blurred until you close them.',
    strict: 'Developer tools are open, so this page is locked. Close them to continue.'
  };

  function buildBanner() {
    if (banner?.isConnected) return;
    banner = document.createElement('div');
    banner.className = 'guard-banner';
    banner.id = 'devchatGuard';
    banner.setAttribute('role', 'status');

    const label = document.createElement('span');
    label.className = 'guard-text';
    label.textContent = TEXT[mode];

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'guard-close';
    close.textContent = 'Dismiss';
    close.addEventListener('click', () => {
      dismissed = true;
      banner?.remove();
      banner = null;
    });

    banner.append(label, close);
    document.body.appendChild(banner);
    bannerShown = true;
  }

  function setOpen(next, reason) {
    open = next;
    root.classList.toggle('inspector-open', next);
    if (mode === 'strict') root.classList.toggle('inspector-locked', next);
    if (!next) {
      banner?.remove();
      banner = null;
      return;
    }
    report('devtools_open', reason);
    if (!dismissed) buildBanner();
  }

  // DevTools docked inside the window steals that many pixels. A separate DevTools
  // window cannot be seen this way, and a phone browser has a permanent height gap,
  // so the check only runs at desktop widths rather than crying wolf on mobile.
  function inspectorBySize() {
    if (window.innerWidth < 700) return false;
    const widthGap = window.outerWidth - window.innerWidth;
    const heightGap = window.outerHeight - window.innerHeight;
    return widthGap > 170 || heightGap > 170;
  }

  function automationMarks() {
    const driverGlobal = Object.getOwnPropertyNames(window).find((name) =>
      /^(\$cdc_|cdc_|__driver|__selenium|__webdriver|__playwright|__nightmare|callPhantom|_phantom)/.test(name));
    if (driverGlobal) return `window.${driverGlobal}`;
    if (document.querySelector('[id^="$cdc"], [name^="$cdc"], [data-driver]')) return 'injected driver attribute';
    if (navigator.webdriver) return 'navigator.webdriver';
    return '';
  }

  // A getter only fires when something actually serialises the object, which an
  // open console does. It writes noise into the console while tools are up, so it
  // stays behind strict mode.
  function consoleProbe() {
    if (mode !== 'strict') return false;
    let tripped = false;
    const bait = {};
    Object.defineProperty(bait, 'id', {
      get() {
        tripped = true;
        return 'devchat';
      }
    });
    console.log(bait);
    return tripped;
  }

  function tick() {
    const automation = automationMarks();
    if (automation) {
      root.classList.add('automation-detected');
      report('automation_detected', automation);
    }

    const next = inspectorBySize() || consoleProbe();
    if (next !== open) {
      setOpen(next, 'size or console probe');
      return;
    }
    if (!open || dismissed) return;
    // Still open: re-arm the banner, and treat a missing one as tampering.
    if (bannerShown && !banner?.isConnected) report('guard_removed', 'banner removed from the page');
    buildBanner();
  }

  function onKeyDown(event) {
    const key = String(event.key || '').toLowerCase();
    const combo = event.ctrlKey || event.metaKey;
    const devtools = key === 'f12' || (combo && event.shiftKey && (key === 'i' || key === 'j' || key === 'c'));
    const viewSource = combo && (key === 'u' || (event.shiftKey && key === 's'));
    if (!devtools && !viewSource) return;
    event.preventDefault();
    event.stopPropagation();
    if (mode === 'strict') setOpen(true, 'shortcut blocked');
  }
  document.addEventListener('keydown', onKeyDown, true);

  // Right-click stays available in fields and on selected text, because pasting an
  // API key and copying a snippet are the whole point of this site.
  document.addEventListener('contextmenu', (event) => {
    const node = event.target;
    const editable = node instanceof Element
      && node.closest('input, textarea, select, [contenteditable="true"]');
    if (editable) return;
    if (String(window.getSelection() || '').length > 0) return;
    event.preventDefault();
  }, true);

  tick();
  setInterval(tick, 900);
})();
