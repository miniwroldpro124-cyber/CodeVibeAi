(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const CHAT_PREFIX = 'devchat.chats.v1';
  const PREF_KEY = 'devchat.prefs.v1';
  // Only an id is kept here, and only to parse the right history before the
  // session answers. Nothing from it is drawn until the server confirms the user.
  const LAST_USER_KEY = 'devchat.lastuser.v1';
  const MAX_ATTACH_BYTES = 250 * 1024;
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const SPLIT_BYTES = 100 * 1024;
  // Covers both a model that never answers and one that stalls mid-stream.
  const IDLE_TIMEOUT_MS = 90000;

  const SVG = {
    copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h8"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6.5"/></svg>',
    download: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14"/></svg>',
    stack: '<svg viewBox="0 0 24 24"><path d="M12 3l8 4.5-8 4.5-8-4.5L12 3z"/><path d="M4 12l8 4.5 8-4.5M4 16.5L12 21l8-4.5"/></svg>',
    refresh: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 10-1.9 5.4"/><path d="M20 4.5V11h-6.2"/></svg>',
    warn: '<svg viewBox="0 0 24 24"><path d="M12 4l9 16H3l9-16z"/><path d="M12 10v4.2M12 17.2h.01"/></svg>',
    chev: '<svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
    spark: '<svg viewBox="0 0 24 24"><path d="M9.5 7l-5 5 5 5M14.5 7l5 5-5 5"/></svg>',
    zip: '<svg viewBox="0 0 24 24"><path d="M4 8h16v12H4z"/><path d="M4 8l2-4h12l2 4"/><path d="M12 12v4M10 14h4"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>'
  };

  const EXT_BY_LANG = {
    javascript: 'js', typescript: 'ts', tsx: 'tsx', jsx: 'jsx', node: 'js',
    python: 'py', py: 'py', bash: 'sh', shell: 'sh', sh: 'sh', zsh: 'sh', console: 'sh',
    ruby: 'rb', rust: 'rs', golang: 'go', csharp: 'cs', 'c++': 'cpp', c: 'c',
    html: 'html', xml: 'xml', css: 'css', scss: 'scss', json: 'json', yaml: 'yml',
    yml: 'yml', sql: 'sql', java: 'java', kotlin: 'kt', swift: 'swift', php: 'php',
    dockerfile: 'dockerfile', makefile: 'makefile', markdown: 'md', md: 'md',
    diff: 'diff', ini: 'ini', toml: 'toml', text: 'txt', plaintext: 'txt', powershell: 'ps1'
  };

  const CURATED = [
    'deepseek-v4.1-flash', 'glm-5.3', 'kimi-k3', 'qwen3.8-27b',
    'claude-sonnet-4.6', 'claude-opus-4.8', 'gpt-6-astra', 'gpt-6-luna', 'gemini-2.5-flash-lite'
  ];

  const FAMILIES = [
    ['all', /./], ['claude', /claude/i], ['gpt', /gpt|openai|o[1-9]-/i], ['gemini', /gemini|nano-banana/i],
    ['deepseek', /deepseek/i], ['qwen', /qwen/i], ['kimi', /kimi/i], ['glm', /glm/i],
    ['llama', /llama/i], ['mistral', /mistral|mixtral/i], ['grok', /grok/i], ['free', /^free$/i]
  ];

  const SUGGESTIONS = [
    ['Explain this error', 'Paste a stack trace and get the root cause plus a fix'],
    ['Write a function', 'Describe the behaviour, get typed, tested code'],
    ['Refactor my code', 'Make it cleaner without changing what it does'],
    ['Review this diff', 'Spot bugs, leaks and edge cases before you ship']
  ];

  /* ---------------- state ---------------- */

  const state = {
    user: null,
    conversations: [],
    activeId: null,
    models: [],
    modelQuery: '',
    modelFamily: 'all',
    streaming: false,
    controller: null,
    attachments: []
  };

  const prefs = {
    model: 'deepseek-v4.1-flash',
    theme: matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
    systemPrompt: '',
    temperature: 0.7,
    maxTokens: '',
    // 'auto' lets the send decide how much thinking the question is worth; the
    // other values are sent to the provider as they are.
    effort: 'auto',
    // Rewrite the prompt before sending it — one small request on the user's key.
    refine: false,
    // When on, an attachment over 100 KB is sent as consecutive parts instead of
    // one giant message.
    splitBig: false,
    collapsed: false
  };

  function readStore(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  Object.assign(prefs, readStore(PREF_KEY, {}));

  // Chats are namespaced per account, so two people sharing a browser never
  // see each other's conversations.
  function chatsKey() {
    return state.user ? `${CHAT_PREFIX}:u${state.user.id}` : null;
  }

  function loadChats() {
    const key = chatsKey();
    let stored = key ? readStore(key, null) : null;
    if (stored === null) {
      // The first account to sign in on this browser adopts whatever history
      // predates accounts, then the shared key is dropped.
      const legacy = readStore(CHAT_PREFIX, null);
      if (Array.isArray(legacy)) {
        stored = legacy;
        try {
          localStorage.removeItem(CHAT_PREFIX);
        } catch { /* ignore */ }
      }
    }
    state.conversations = Array.isArray(stored) ? stored : [];
    // A reload mid-stream would otherwise leave a caret spinning forever.
    for (const conv of state.conversations) {
      for (const msg of conv.messages || []) {
        msg.thinking = false;
        if (!msg.content && !msg.reasoning && !msg.error) msg.error = 'Interrupted before any output arrived.';
      }
    }
    state.activeId = state.conversations[0]?.id || null;
  }

  let saveTimer = null;
  function saveChats() {
    const key = chatsKey();
    // Never write before we know whose history this is.
    if (!key) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        // Picture data URLs are display-only; keeping them would fill the quota
        // after a couple of screenshots. The text that travelled is kept.
        localStorage.setItem(key, JSON.stringify(state.conversations, (k, v) => (k === 'images' ? undefined : v)));
      } catch {
        toast('Storage full — older chats were not saved', true);
      }
    }, 400);
  }
  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
  }

  /* ---------------- dom refs ---------------- */

  const appEl = $('#app');
  const messagesEl = $('#messages');
  const emptyEl = $('#emptyState');
  const inputEl = $('#promptInput');
  const sendBtn = $('#sendBtn');
  const stopBtn = $('#stopBtn');
  const statusEl = $('#statusText');
  const costChip = $('#costChip');
  const convListEl = $('#convList');
  const modelBtn = $('#modelBtn');
  const modelNameEl = $('#modelName');
  const modelPanel = $('#modelPanel');
  const modelListEl = $('#modelList');
  const modelFiltersEl = $('#modelFilters');
  const acctBtn = $('#acctBtn');
  const acctMenu = $('#acctMenu');
  const acctNameEl = $('#acctName');
  const acctAvatarEl = $('#acctAvatar');
  const acctRoleEl = $('#acctRole');
  const acctKeyHintEl = $('#acctKeyHint');
  const keyHintEl = $('#keyHint');
  const keyEditBtn = $('#keyEditBtn');
  const keyRemoveBtn = $('#keyRemoveBtn');

  const streamInner = document.createElement('div');
  streamInner.className = 'messages-inner';
  messagesEl.appendChild(streamInner);

  // Whether the tail should follow the answer as it grows. Reading the list
  // height to work this out forced a layout pass on every paint, which is what
  // made a long thread stutter; the position only changes when someone scrolls.
  let followTail = true;
  function trackFollow() {
    followTail = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 140;
    syncRail();
  }
  messagesEl.addEventListener('scroll', trackFollow, { passive: true });

  // Prompt rail: one mark per turn you sent, and the strip itself drags.
  const rail = document.createElement('div');
  rail.className = 'jump-rail';
  rail.setAttribute('role', 'navigation');
  rail.setAttribute('aria-label', 'Jump between your prompts');
  const railTrack = document.createElement('div');
  railTrack.className = 'jump-track';
  const railFill = document.createElement('div');
  railFill.className = 'jump-fill';
  const railTicks = document.createElement('div');
  railTicks.className = 'jump-ticks';
  const railThumb = document.createElement('div');
  railThumb.className = 'jump-thumb';
  const railLabel = document.createElement('div');
  railLabel.className = 'jump-label';
  railTrack.appendChild(railFill);
  rail.append(railTrack, railTicks, railThumb, railLabel);
  $('.main').appendChild(rail);

  /* ---------------- utilities ---------------- */

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function escapeHtml(text) {
    return text.replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  const vndFmt = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 });

  function formatVnd(value) {
    if (value == null || Number.isNaN(value)) return '';
    return `${vndFmt.format(value)} ₫`;
  }

  function formatCompact(value) {
    if (value == null) return '';
    if (value >= 1000) {
      const k = value / 1000;
      return `${k >= 100 ? Math.round(k) : k.toFixed(k % 1 ? 1 : 0)}k`;
    }
    return String(Math.round(value));
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function relativeDay(ts) {
    const now = new Date();
    const day = new Date(ts);
    const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = Math.round((startOf(now) - startOf(day)) / 86400000);
    if (diff <= 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return 'Previous 7 days';
    if (diff < 30) return 'Previous 30 days';
    return 'Older';
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* fall through to the legacy path */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }

  function flashButton(button, label) {
    const original = button.innerHTML;
    button.innerHTML = SVG.check + (label ? `<span>${label}</span>` : '');
    button.classList.add('done');
    clearTimeout(button._flashTimer);
    button._flashTimer = setTimeout(() => {
      button.innerHTML = original;
      button.classList.remove('done');
    }, 1500);
  }

  function toast(message, isError = false) {
    const box = $('#toasts');
    const node = document.createElement('div');
    node.className = 'toast' + (isError ? ' err' : '');
    node.innerHTML = (isError ? SVG.warn : SVG.check) + `<span></span>`;
    node.querySelector('span').textContent = message;
    box.appendChild(node);
    setTimeout(() => {
      node.classList.add('out');
      node.addEventListener('animationend', () => node.remove(), { once: true });
    }, 2200);
  }

  function download(filename, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Names each block from the filename the model declared, else from its
  // language, and de-duplicates so two "index.js" blocks cannot overwrite
  // each other inside the archive.
  function blocksToFiles(blocks) {
    const used = new Set();
    return blocks.map((block, i) => {
      const lang = block.dataset.lang || 'txt';
      const ext = EXT_BY_LANG[lang] || lang || 'txt';
      let name = (block.dataset.filename || '').replace(/^[/\\]+/, '');
      if (!name) name = blocks.length === 1 ? `snippet.${ext}` : `snippet-${i + 1}.${ext}`;
      if (!name.includes('.')) name = `${name}.${ext}`;

      const dot = name.lastIndexOf('.');
      let unique = name;
      for (let n = 2; used.has(unique.toLowerCase()); n++) {
        unique = dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
      }
      used.add(unique.toLowerCase());
      return { name: unique, content: block._raw ?? '' };
    });
  }

  function zipNameFor(conv) {
    const slug = (conv?.title || 'code')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    return `devchat-${slug || 'code'}.zip`;
  }

  /* ---------------- markdown + code blocks ---------------- */

  marked.use({ gfm: true, breaks: true });

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.getAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });

  function renderMarkdown(target, text) {
    target.innerHTML = DOMPurify.sanitize(marked.parse(text || '', { gfm: true, breaks: true }));
  }

  // ```lang filename.ext — marked only keeps the first word, so recover the
  // filename from a leading comment when the model used that convention.
  // Models most often write "// filename: src/a.js" rather than a bare path,
  // so the label is optional but must not swallow the name.
  const FILE_COMMENT =
    /^\s*(?:\/\/|#|\/\*+|<!--|;|--|%)\s*(?:(?:filename|file|save as|path)\s*[:=]?\s*)?([\w.@+/-]+\.[A-Za-z0-9]{1,6})\s*(?:\*\/|-->)?\s*$/i;

  function detectLanguage(code, declared) {
    if (declared && hljs.getLanguage(declared)) return declared;
    const alias = declared && hljs.getLanguage(EXT_BY_LANG[declared] || declared);
    if (alias) return EXT_BY_LANG[declared] || declared;
    const first = code.split('\n', 1)[0] || '';
    const shebang = /^#!.*\b(bash|sh|zsh|python3?|node|ruby|perl|php)\b/.exec(first);
    if (shebang) return shebang[1].replace('python3', 'python');
    return '';
  }

  // Streaming re-renders the whole answer several times a second, and re-running
  // highlight.js over every block was the bulk of the cost on long code replies.
  // Only the last block actually changes, so keep the rendered HTML keyed by
  // language + source and re-use it for everything that has settled.
  const HL_CACHE = new Map();
  const HL_CACHE_MAX = 80;

  function highlightCode(raw, lang, autodetect) {
    const key = `${lang}\u0000${autodetect ? 'auto' : 'plain'}\u0000${raw}`;
    const hit = HL_CACHE.get(key);
    if (hit !== undefined) {
      HL_CACHE.delete(key);
      HL_CACHE.set(key, hit);
      return hit;
    }

    let html;
    if (lang && hljs.getLanguage(lang)) {
      try {
        html = hljs.highlight(raw, { language: lang, ignoreIllegals: true }).value;
      } catch {
        html = escapeHtml(raw);
      }
    } else if (autodetect && raw.length < 20000) {
      try {
        html = hljs.highlightAuto(raw).value;
      } catch {
        html = escapeHtml(raw);
      }
    } else {
      html = escapeHtml(raw);
    }

    if (HL_CACHE.size >= HL_CACHE_MAX) HL_CACHE.delete(HL_CACHE.keys().next().value);
    HL_CACHE.set(key, html);
    return html;
  }

  function enhanceCodeBlocks(container, { autodetect = false } = {}) {
    for (const pre of container.querySelectorAll('pre')) {
      if (pre.parentElement?.classList.contains('code-block')) continue;
      const codeEl = pre.querySelector('code');
      if (!codeEl) continue;

      const raw = codeEl.textContent.replace(/\n$/, '');
      const declared = (codeEl.className.match(/language-([\w+-]+)/) || [])[1] || '';
      const lang = detectLanguage(raw, declared.toLowerCase());
      const filename = (raw.split('\n', 1)[0].match(FILE_COMMENT) || [])[1] || '';
      const html = highlightCode(raw, lang, autodetect);

      const block = document.createElement('div');
      block.className = 'code-block';
      block._raw = raw;

      const head = document.createElement('div');
      head.className = 'code-head';

      const langLabel = document.createElement('span');
      langLabel.className = 'code-lang';
      langLabel.textContent = lang || 'code';
      head.appendChild(langLabel);

      if (filename) {
        const nameLabel = document.createElement('span');
        nameLabel.className = 'code-fname';
        nameLabel.textContent = filename;
        head.appendChild(nameLabel);
      }

      const actions = document.createElement('div');
      actions.className = 'code-actions';
      actions.innerHTML =
        `<button class="code-btn" data-act="copy-code" title="Copy code">${SVG.copy}<span>Copy</span></button>` +
        `<button class="code-btn" data-act="download-code" title="Download as a file">${SVG.download}</button>`;
      head.appendChild(actions);

      const newPre = document.createElement('pre');
      const newCode = document.createElement('code');
      newCode.innerHTML = html;
      newPre.appendChild(newCode);

      block.appendChild(head);
      block.appendChild(newPre);
      block.dataset.filename = filename;
      block.dataset.lang = lang;
      pre.replaceWith(block);
    }
  }

  /* ---------------- conversation model ---------------- */

  function activeConv() {
    return state.conversations.find((c) => c.id === state.activeId) || null;
  }

  function ensureConv() {
    let conv = activeConv();
    if (!conv) {
      conv = { id: uid(), title: '', createdAt: Date.now(), updatedAt: Date.now(), model: prefs.model, messages: [] };
      state.conversations.unshift(conv);
      state.activeId = conv.id;
    }
    return conv;
  }

  function makeTitle(text) {
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.length > 44 ? clean.slice(0, 44) + '…' : clean || 'New chat';
  }

  function conversationCost(conv) {
    return conv.messages.reduce((sum, m) => sum + (m.usage?.x_ckey?.cost || 0), 0);
  }

  function conversationTokens(conv) {
    return conv.messages.reduce((sum, m) => sum + (m.usage?.total_tokens || 0), 0);
  }

  function apiMessages(conv, uptoIndex) {
    const out = [];
    const prompt = prefs.systemPrompt.trim();
    if (prompt) out.push({ role: 'system', content: prompt });
    conv.messages.slice(0, uptoIndex).forEach((m) => {
      if (m.role !== 'user' && m.role !== 'assistant') return;
      if (!m.content && !(m.images?.length)) return;
      if (m.role === 'user' && m.images?.length) {
        const parts = [{ type: 'text', text: m.content || '' }];
        for (const url of m.images) parts.push({ type: 'image_url', image_url: { url } });
        out.push({ role: 'user', content: parts });
      } else {
        out.push({ role: m.role, content: m.content });
      }
    });
    return out;
  }

  /* ---------------- rendering ---------------- */

  function messageNode(msg, index) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${msg.role}`;
    wrap.dataset.index = index;

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    if (msg.role === 'assistant') {
      avatar.innerHTML = SVG.spark;
      avatar.title = msg.model || '';
    } else {
      avatar.textContent = 'You';
    }
    wrap.appendChild(avatar);

    const body = document.createElement('div');
    body.className = 'msg-body';

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const role = document.createElement('span');
    role.className = 'msg-role';
    role.textContent = msg.role === 'assistant' ? (msg.model || 'Assistant') : 'You';
    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = formatTime(msg.ts || Date.now());
    meta.append(role, time);
    if (msg.refined) {
      const tag = document.createElement('span');
      tag.className = 'msg-tag';
      tag.textContent = 'improved';
      tag.title = 'Rewritten from what you typed before sending';
      meta.append(tag);
    }
    body.appendChild(meta);

    if (msg.role === 'assistant' && (msg.reasoning || msg.thinking)) {
      body.appendChild(reasoningNode(msg));
    }

    if (msg.error) body.appendChild(errorNode(msg.error));

    const content = document.createElement('div');
    content.className = 'md';
    body.appendChild(content);

    if (msg.role === 'assistant') body.appendChild(actionsNode(msg, index));

    wrap.appendChild(body);
    paintContent(content, msg, false, Boolean(msg.thinking));
    return wrap;
  }

  function reasoningNode(msg) {
    const box = document.createElement('div');
    box.className = 'reasoning' + (msg.thinking ? ' open thinking' : '');
    box.innerHTML =
      `<button class="reasoning-head" type="button">${SVG.chev}` +
      `<span class="pulse">${msg.thinking ? 'Thinking…' : 'Thought process'}</span>` +
      `<span class="dur"></span></button><div class="reasoning-body"></div>`;
    box.querySelector('.reasoning-body').textContent = msg.reasoning || '';
    if (msg.reasoningMs) box.querySelector('.dur').textContent = `${(msg.reasoningMs / 1000).toFixed(1)}s`;
    box.querySelector('.reasoning-head').addEventListener('click', () => box.classList.toggle('open'));
    return box;
  }

  function errorNode(message) {
    const box = document.createElement('div');
    box.className = 'error-box';
    box.innerHTML = `${SVG.warn}<div><b>Request failed</b><code></code></div>`;
    box.querySelector('code').textContent = message;
    return box;
  }

  function actionsNode(msg, index) {
    const bar = document.createElement('div');
    bar.className = 'msg-actions';
    bar.innerHTML =
      `<button class="act-btn" data-act="copy-msg" title="Copy message">${SVG.copy}<span>Copy</span></button>` +
      `<button class="act-btn" data-act="copy-all-code" title="Copy every code block in this answer">${SVG.stack}<span>All code</span></button>` +
      `<button class="act-btn" data-act="download-all" title="Download every file in this answer as a .zip">${SVG.zip}<span>Files</span></button>` +
      `<button class="act-btn" data-act="regen" title="Regenerate this answer">${SVG.refresh}<span>Retry</span></button>`;

    const note = document.createElement('span');
    note.className = 'act-note';
    bar.appendChild(note);
    updateMeta(note, msg);
    bar.dataset.index = index;
    return bar;
  }

  function updateMeta(note, msg) {
    const bits = [];
    if (msg.usage?.total_tokens) bits.push(`${msg.usage.total_tokens} tok`);
    const cost = msg.usage?.x_ckey?.cost;
    if (cost != null) bits.push(formatVnd(cost));
    // Time spent in the reasoning stream before the first visible token, which
    // is the part that feels like the model is stalling.
    if (msg.reasoningMs) bits.push(`thought ${(msg.reasoningMs / 1000).toFixed(1)}s`);
    if (msg.elapsedMs) bits.push(`${(msg.elapsedMs / 1000).toFixed(1)}s`);
    if (msg.stopped) bits.push('stopped');
    note.textContent = bits.join(' · ');
  }

  function paintContent(container, msg, final, live = false) {
    const streaming = live && Boolean(msg.thinking);
    if (streaming) {
      if (container._text !== msg.content) {
        container._text = msg.content;
        container.classList.add('streaming');
        container.textContent = msg.content;
      }
      const caret = container.querySelector(':scope > .caret');
      if (msg.content) {
        if (!caret) container.appendChild(caretNode());
        else if (container.lastElementChild !== caret) container.appendChild(caret);
      } else if (caret) caret.remove();
      const typing = container.querySelector(':scope > .typing');
      if (msg.thinking && !msg.content) {
        if (!typing) {
          const dots = document.createElement('div');
          dots.className = 'typing';
          dots.innerHTML = '<i></i><i></i><i></i>';
          container.appendChild(dots);
        }
      } else if (typing) typing.remove();
      return;
    }

    if (container.classList.contains('streaming')) container.classList.remove('streaming');
    if (container._text !== msg.content || container._final !== final || container._live) {
      container._text = msg.content;
      container._final = final;
      container._live = false;
      renderMarkdown(container, msg.content);
      enhanceCodeBlocks(container, { autodetect: final });
    }

    const caret = container.querySelector(':scope > .caret');
    if (msg.thinking && msg.content) {
      if (!caret) container.appendChild(caretNode());
      else if (container.lastElementChild !== caret) container.appendChild(caret);
    } else if (caret) caret.remove();

    const typing = container.querySelector(':scope > .typing');
    if (msg.thinking && !msg.content) {
      if (!typing) {
        const dots = document.createElement('div');
        dots.className = 'typing';
        dots.innerHTML = '<i></i><i></i><i></i>';
        container.appendChild(dots);
      }
    } else if (typing) typing.remove();
  }

  function caretNode() {
    const caret = document.createElement('span');
    caret.className = 'caret';
    return caret;
  }

  // Rows live as long as the message objects that made them. A turn is only ever
  // appended or truncated, so comparing object identity finds the first row that
  // differs and rebuilds from there instead of re-parsing every answer in the
  // thread — which, on a long chat, was the bulk of the cost of pressing Send.
  let rendered = [];

  function renderConversation() {
    const conv = activeConv();
    const messages = conv?.messages || [];

    let same = 0;
    while (same < messages.length && same < rendered.length && rendered[same] === messages[same]) same += 1;
    while (streamInner.childElementCount > same) streamInner.lastElementChild.remove();
    for (let i = same; i < messages.length; i += 1) streamInner.appendChild(messageNode(messages[i], i));
    rendered = messages.slice();

    streamInner.classList.toggle('long-thread', (conv?.messages?.length || 0) > 30);
    emptyEl.hidden = messages.length > 0;
    updateCost();
    updateSidebarActive();
    followTail = true;
    messagesEl.scrollTop = messagesEl.scrollHeight;
    buildRail();
  }

  function updateCost() {
    const conv = activeConv();
    const cost = conv ? conversationCost(conv) : 0;
    const tokens = conv ? conversationTokens(conv) : 0;
    costChip.textContent = cost > 0 ? formatVnd(cost) : '0 ₫';
    costChip.title = tokens
      ? `${tokens.toLocaleString()} tokens · billed to your own API key`
      : 'Spend for this conversation, billed to your own API key';
  }

  function renderAccount() {
    const user = state.user;
    acctNameEl.textContent = user ? user.username : 'Not signed in';
    acctAvatarEl.textContent = user ? user.username.slice(0, 1) : '?';
    const isAdmin = user?.role === 'admin';
    acctRoleEl.hidden = !isAdmin;
    $('#adminLink').hidden = !isAdmin;

    const hint = user?.hasKey ? user.apiKeyHint || 'saved' : 'not set';
    acctKeyHintEl.textContent = hint;
    keyHintEl.textContent = hint;
    keyEditBtn.textContent = user?.hasKey ? 'Replace key' : 'Add key';
    keyRemoveBtn.hidden = !user?.hasKey;
  }

  function toggleAcctMenu(open) {
    const show = open ?? acctMenu.hidden;
    acctMenu.hidden = !show;
    acctBtn.setAttribute('aria-expanded', String(show));
  }

  /* ---------------- sidebar ---------------- */

  let convListSig = '';

  function renderConvList() {
    const query = $('#convSearchInput').value.trim().toLowerCase();
    const sig = `${query}\u0000${state.activeId || ''}\u0000`
      + state.conversations.map((c) => `${c.id}:${c.updatedAt || 0}:${c.title || ''}`).join('|');
    // The list is rebuilt from scratch, including day headers. If nothing it shows
    // has moved, rebuilding is pure cost — and it happens after every reply.
    if (sig === convListSig) return;
    convListSig = sig;
    const list = state.conversations.filter((c) =>
      !query ||
      (c.title || '').toLowerCase().includes(query) ||
      c.messages.some((m) => (m.content || '').toLowerCase().includes(query))
    );

    convListEl.replaceChildren();
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'conv-empty';
      empty.textContent = query ? 'No chats match that search.' : 'No chats yet.';
      convListEl.appendChild(empty);
      return;
    }

    let lastGroup = null;
    for (const conv of list) {
      const group = relativeDay(conv.updatedAt || conv.createdAt);
      if (group !== lastGroup) {
        const label = document.createElement('div');
        label.className = 'conv-group-label';
        label.textContent = group;
        convListEl.appendChild(label);
        lastGroup = group;
      }

      const item = document.createElement('div');
      item.className = 'conv-item' + (conv.id === state.activeId ? ' active' : '');
      item.dataset.id = conv.id;

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'conv-open';
      const title = document.createElement('span');
      title.className = 'conv-title';
      title.textContent = conv.title || 'New chat';
      title.title = conv.title || 'New chat';
      open.appendChild(title);
      open.addEventListener('click', () => openConversation(conv.id));

      const del = document.createElement('button');
      del.className = 'conv-del';
      del.type = 'button';
      del.title = 'Delete chat';
      del.setAttribute('aria-label', 'Delete chat');
      del.innerHTML = SVG.trash;
      del.addEventListener('click', (event) => {
        event.stopPropagation();
        deleteConversation(conv.id);
      });

      item.append(open, del);
      convListEl.appendChild(item);
    }
  }

  function updateSidebarActive() {
    $$('.conv-item', convListEl).forEach((node) => {
      node.classList.toggle('active', node.dataset.id === state.activeId);
    });
  }

  function openConversation(id) {
    if (state.streaming) stopStreaming();
    state.activeId = id;
    renderConversation();
    renderConvList();
    closeSidebarOnMobile();
    inputEl.focus();
  }

  function deleteConversation(id) {
    const index = state.conversations.findIndex((c) => c.id === id);
    if (index < 0) return;
    state.conversations.splice(index, 1);
    if (state.activeId === id) {
      state.activeId = state.conversations[0]?.id || null;
      renderConversation();
    }
    saveChats();
    renderConvList();
    toast('Chat deleted');
  }

  function newConversation() {
    if (state.streaming) stopStreaming();
    const existing = activeConv();
    if (existing && existing.messages.length === 0) {
      closeSidebarOnMobile();
      inputEl.focus();
      return;
    }
    const conv = { id: uid(), title: '', createdAt: Date.now(), updatedAt: Date.now(), model: prefs.model, messages: [] };
    state.conversations.unshift(conv);
    state.activeId = conv.id;
    saveChats();
    renderConvList();
    renderConversation();
    closeSidebarOnMobile();
    inputEl.focus();
  }

  function closeSidebarOnMobile() {
    if (matchMedia('(max-width: 900px)').matches) appEl.classList.add('collapsed');
  }

  /* ---------------- model picker ---------------- */

  function modelById(id) {
    return state.models.find((m) => m.id === id);
  }

  function renderModelFilters() {
    const counts = new Map();
    for (const model of state.models) {
      for (const [name, pattern] of FAMILIES) {
        if (name === 'all') continue;
        if (pattern.test(model.id)) counts.set(name, (counts.get(name) || 0) + 1);
      }
    }
    modelFiltersEl.replaceChildren();
    for (const [name] of FAMILIES) {
      if (name !== 'all' && !counts.get(name)) continue;
      const chip = document.createElement('button');
      chip.className = 'chip' + (state.modelFamily === name ? ' active' : '');
      chip.type = 'button';
      chip.textContent = name === 'all' ? `all ${state.models.length}` : `${name} ${counts.get(name)}`;
      chip.addEventListener('click', () => {
        state.modelFamily = name;
        renderModelFilters();
        renderModelList();
      });
      modelFiltersEl.appendChild(chip);
    }
  }

  function renderModelList() {
    const query = state.modelQuery.toLowerCase();
    const family = FAMILIES.find(([name]) => name === state.modelFamily)?.[1] || /./;

    const matches = state.models.filter((m) => family.test(m.id) && (!query || m.id.toLowerCase().includes(query)));
    matches.sort((a, b) => {
      const ac = CURATED.indexOf(a.id);
      const bc = CURATED.indexOf(b.id);
      if (ac !== -1 || bc !== -1) {
        if (ac === -1) return 1;
        if (bc === -1) return -1;
        return ac - bc;
      }
      return a.id.localeCompare(b.id);
    });

    modelListEl.replaceChildren();
    if (!matches.length) {
      const none = document.createElement('div');
      none.className = 'picker-none';
      none.textContent = 'No model matches that search.';
      modelListEl.appendChild(none);
      return;
    }

    for (const model of matches.slice(0, 300)) {
      const option = document.createElement('button');
      option.className = 'model-opt' + (model.id === prefs.model ? ' selected' : '');
      option.type = 'button';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(model.id === prefs.model));
      option.dataset.id = model.id;

      const idSpan = document.createElement('span');
      idSpan.className = 'model-opt-id';
      idSpan.textContent = model.id;

      option.appendChild(idSpan);

      const price = document.createElement('span');
      price.className = 'model-opt-price';
      const p = model.pricing || {};
      price.textContent = p.input != null && p.output != null
        ? `${formatCompact(p.input)} / ${formatCompact(p.output)}`
        : '';
      price.title = p.input != null ? `per 1M tokens · ${p.input} in / ${p.output} out ${p.unit || ''}` : '';
      option.appendChild(price);

      option.addEventListener('click', () => selectModel(model.id));
      modelListEl.appendChild(option);
    }
  }

  function selectModel(id) {
    prefs.model = id;
    savePrefs();
    modelNameEl.textContent = id;
    const conv = activeConv();
    if (conv) conv.model = id;
    toggleModelPanel(false);
    renderModelList();
    toast(`Model: ${id}`);
  }

  function toggleModelPanel(open) {
    const show = open ?? modelPanel.hidden;
    modelPanel.hidden = !show;
    modelBtn.setAttribute('aria-expanded', String(show));
    if (show) {
      state.modelQuery = '';
      $('#modelSearchInput').value = '';
      renderModelList();
      $('#modelSearchInput').focus();
    }
  }

  async function loadModels() {
    if (!Auth.signedIn) return;
    try {
      const res = await fetch(Auth.apiUrl('/api/models'), { headers: Auth.authHeaders() });
      const data = await res.json();
      if (!res.ok) {
        Auth.guard({ status: res.status, data });
        throw new Error(data.error || 'Failed to load models');
      }
      state.models = Array.isArray(data.data) ? data.data : [];
      if (!modelById(prefs.model) && state.models.length) {
        prefs.model = state.models[0].id;
        savePrefs();
      }
      modelNameEl.textContent = prefs.model;
      renderModelFilters();
      renderModelList();
    } catch (err) {
      modelNameEl.textContent = prefs.model;
      modelListEl.replaceChildren();
      const none = document.createElement('div');
      none.className = 'picker-none';
      none.textContent = `Could not load the model list: ${err.message}`;
      modelListEl.appendChild(none);
    }
  }

  /* ---------------- streaming ---------------- */

  function setStreaming(on) {
    state.streaming = on;
    sendBtn.hidden = on;
    stopBtn.hidden = !on;
    if (!on) {
      statusEl.textContent = '';
      autosize();
    }
  }

  function stopStreaming() {
    if (state.controller) state.controller.abort();
  }

  async function streamReply(conv, assistantIndex) {
    const msg = conv.messages[assistantIndex];
    const node = streamInner.querySelector(`.msg[data-index="${assistantIndex}"]`);
    const bodyEl = node?.querySelector('.msg-body');
    const contentEl = bodyEl?.querySelector('.md');
    const actionsEl = bodyEl?.querySelector('.msg-actions');
    const noteEl = actionsEl?.querySelector('.act-note');
    let reasoningBox = bodyEl?.querySelector('.reasoning');

    msg.thinking = true;
    const startedAt = performance.now();
    let reasoningStartedAt = 0;
    let lastPaint = 0;
    let paintQueued = false;
    let paintTimer = null;

    const stick = () => {
      if (followTail) messagesEl.scrollTop = messagesEl.scrollHeight;
    };

    const paint = (final = false) => {
      if (!contentEl) return;
      paintContent(contentEl, msg, final, !final && msg.thinking);
      if (reasoningBox) {
        reasoningBox.classList.toggle('thinking', Boolean(msg.thinking));
        const head = reasoningBox.querySelector('.pulse');
        head.textContent = msg.thinking ? 'Thinking…' : 'Thought process';
        const rbody = reasoningBox.querySelector('.reasoning-body');
        if (rbody._text !== msg.reasoning) {
          rbody._text = msg.reasoning;
          rbody.textContent = msg.reasoning || '';
        }
        const dur = reasoningBox.querySelector('.dur');
        if (msg.reasoningMs) dur.textContent = `${(msg.reasoningMs / 1000).toFixed(1)}s`;
      }
      // Scrolling has to read the list height, and doing that per SSE chunk
      // forced a layout pass dozens of times a second. Painting is the only
      // moment the height can actually change, so it belongs here.
      // The counter is a paint, not a chunk: a reply arrives in far more pieces
      // than the screen can usefully redraw.
      if (msg.thinking) statusEl.textContent = `${msg.content.length.toLocaleString()} chars`;
      stick();
    };

    // While the answer is live it is painted as plain text, so a paint costs one
    // textContent write instead of a full markdown parse. That makes a steady
    // 50–80 ms cadence affordable even on a long reply; the expensive markdown
    // and syntax pass happens once, when the stream ends.
    const paintDelay = () => {
      const n = msg.content.length + (msg.reasoning?.length || 0);
      if (n > 32000) return 90;
      if (n > 12000) return 70;
      return 50;
    };

    const schedulePaint = () => {
      const now = performance.now();
      const delay = paintDelay();
      if (now - lastPaint > delay) {
        lastPaint = now;
        paint();
        return;
      }
      if (paintQueued) return;
      paintQueued = true;
      paintTimer = setTimeout(() => {
        paintQueued = false;
        lastPaint = performance.now();
        paint();
      }, delay);
    };

    state.controller = new AbortController();
    setStreaming(true);
    statusEl.textContent = 'connecting…';

    let idle = false;
    let idleTimer = null;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idle = true;
        state.controller?.abort();
      }, IDLE_TIMEOUT_MS);
    };
    armIdle();

    const payload = {
      model: conv.model || prefs.model,
      messages: apiMessages(conv, assistantIndex),
      stream: true,
      temperature: Number(prefs.temperature)
    };
    const maxTokens = Number(prefs.maxTokens);
    if (maxTokens > 0) payload.max_tokens = maxTokens;
    // One setting, two meanings: 'off' disables thinking, 'auto' picks a level from
    // the shape of the request, and the rest are sent as they are.
    const resolvedEffort = resolveEffort(conv.messages?.[assistantIndex - 1]?.content);
    payload.reasoning_effort = resolvedEffort === 'off' ? 'none' : resolvedEffort;

    try {
      const res = await fetch(Auth.apiUrl('/api/chat'), {
        method: 'POST',
        headers: Auth.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
        signal: state.controller.signal
      });

      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const parsed = await res.json();
          detail = parsed.error || detail;
          // An expired session, a disabled account or a key removed in another
          // tab should reopen the matching gate, not just print an error.
          Auth.guard({ status: res.status, data: parsed });
        } catch { /* keep the status text */ }
        // A provider that does not know reasoning_effort says so in a 400. The
        // answer is still worth having, so the field is dropped and sent again.
        if (payload.reasoning_effort && res.status === 400 && /reasoning[_ ]effort/i.test(detail)) {
          delete payload.reasoning_effort;
          statusEl.textContent = 'this model ignores the effort setting — sent without it';
          res = await fetch(Auth.apiUrl('/api/chat'), {
            method: 'POST',
            headers: Auth.authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(payload),
            signal: state.controller.signal
          });
          if (!res.ok) {
            let again = `HTTP ${res.status}`;
            try {
              const parsed = await res.json();
              again = parsed.error || again;
              Auth.guard({ status: res.status, data: parsed });
            } catch { /* keep the status text */ }
            throw new Error(again);
          }
        } else {
          throw new Error(detail);
        }
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      statusEl.textContent = 'generating…';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdle();
        buffer += decoder.decode(value, { stream: true });

        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;

          let chunk;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }

          if (chunk.error) throw new Error(chunk.error.message || 'Upstream stream error');

          const delta = chunk.choices?.[0]?.delta || {};
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
            if (!reasoningStartedAt) {
              reasoningStartedAt = performance.now();
              if (!reasoningBox) {
                reasoningBox = reasoningNode(msg);
                bodyEl?.querySelector('.msg-meta')?.after(reasoningBox);
              }
            }
            msg.reasoning += delta.reasoning_content;
            schedulePaint();
          }
          if (typeof delta.content === 'string' && delta.content) {
            if (reasoningStartedAt && !msg.reasoningMs) msg.reasoningMs = performance.now() - reasoningStartedAt;
            msg.content += delta.content;
            schedulePaint();
          }
          if (chunk.usage) {
            msg.usage = chunk.usage;
            if (noteEl) updateMeta(noteEl, msg);
            updateCost();
          }
        }
      }
    } catch (err) {
      if (idle) {
        msg.error = `No data arrived for ${IDLE_TIMEOUT_MS / 1000}s, so the request was cancelled. The model may be overloaded — try Retry or pick a different model.`;
      } else if (err.name === 'AbortError') {
        msg.stopped = true;
      } else {
        msg.error = err.message || String(err);
      }
      if (msg.error) {
        if (!msg.content && !msg.reasoning) bodyEl?.querySelector('.md')?.remove();
        const existing = bodyEl?.querySelector('.error-box');
        if (existing) existing.replaceWith(errorNode(msg.error));
        else bodyEl?.querySelector('.msg-meta')?.after(errorNode(msg.error));
      }
    } finally {
      clearTimeout(idleTimer);
      // A queued interim paint would re-render over the finished answer without
      // the final auto-detect pass, so it has to be dropped, not allowed to land.
      clearTimeout(paintTimer);
      paintQueued = false;
      msg.thinking = false;
      msg.elapsedMs = performance.now() - startedAt;
      if (reasoningStartedAt && !msg.reasoningMs) msg.reasoningMs = performance.now() - reasoningStartedAt;
      if (reasoningBox) reasoningBox.classList.remove('open', 'thinking');
      state.controller = null;
      setStreaming(false);
      paint(true);
      // Nobody is watching the screen when a long answer lands, so the sound is the
      // point of this. A stop the visitor pressed themselves stays silent.
      if (msg.error) window.Style?.play('error');
      else if (msg.content && !msg.stopped) window.Style?.play('done');
      if (noteEl) {
        updateMeta(noteEl, msg);
      }
      conv.updatedAt = Date.now();
      saveChats();
      renderConvList();
      stick();
      // The answer changed height all the way down the thread, so the marks
      // need re-measuring once, at the end, rather than on every paint.
      buildRail();
    }
  }

  /* ---------------- prompt rail ---------------- */

  const RAIL_MIN = 4;
  let railRows = [];
  let railPos = [];

  function railText(row) {
    return (row.querySelector('.md')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90);
  }

  // Marks sit where their prompt sits, so the rail reads as a map of the thread
  // rather than a list of turns. Prompts skipped by content-visibility report
  // their placeholder height, so the marks are re-measured as the thread is
  // scrolled through and settle onto the truth.
  let railMeasuredAt = 0;

  function measureTicks() {
    const span = Math.max(1, streamInner.offsetHeight);
    const base = streamInner.getBoundingClientRect().top;
    const ticks = railTicks.children;
    railPos = railRows.map((row, i) => {
      const at = Math.min(1, Math.max(0, (row.getBoundingClientRect().top - base) / span));
      if (ticks[i]) ticks[i].style.top = `${at * 100}%`;
      return at;
    });
    railMeasuredAt = Date.now();
  }

  function buildRail() {
    railRows = $$('.msg.user', streamInner);
    const on = railRows.length >= RAIL_MIN;
    rail.classList.toggle('on', on);
    if (!on) {
      railTicks.replaceChildren();
      railPos = [];
      return;
    }

    railBox();
    const frag = document.createDocumentFragment();
    railRows.forEach((row, i) => {
      const tick = document.createElement('button');
      tick.type = 'button';
      tick.className = 'jump-tick';
      tick.dataset.i = i;
      tick.setAttribute('aria-label', `Prompt ${i + 1}: ${railText(row)}`);
      frag.appendChild(tick);
    });
    railTicks.replaceChildren(frag);
    measureTicks();
    syncRail();
  }

  // The rail is a sibling of the scroll box, so it has to be told where the
  // thread starts — the header above it and the composer under it both move.
  function railBox() {
    rail.style.top = `${messagesEl.offsetTop}px`;
    rail.style.height = `${messagesEl.clientHeight}px`;
  }

  function syncRail() {
    if (!rail.classList.contains('on')) return;
    const h = rail.clientHeight;
    if (!h) return;
    // Cheap on purpose: a scroll settles the placeholder heights of the prompts
    // it passes, so re-reading every few hundred milliseconds keeps the marks
    // honest without measuring the whole thread on every scroll event.
    if (Date.now() - railMeasuredAt > 400) measureTicks();
    const view = messagesEl.clientHeight;
    const full = Math.max(1, messagesEl.scrollHeight);
    const thumbH = Math.max(24, Math.min(h, (view / full) * h));
    const travel = Math.max(1, h - thumbH);
    const y = Math.min(travel, (messagesEl.scrollTop / Math.max(1, full - view)) * travel);
    railThumb.style.height = `${thumbH}px`;
    railThumb.style.top = `${y}px`;
    railFill.style.height = `${((y + thumbH) / h) * 100}%`;

    const line = (messagesEl.scrollTop + 30) / full;
    let now = 0;
    for (let i = 0; i < railPos.length; i += 1) if (railPos[i] <= line) now = i;
    const ticks = railTicks.children;
    for (let i = 0; i < ticks.length; i += 1) ticks[i].classList.toggle('now', i === now);
  }

  if (window.ResizeObserver) {
    new ResizeObserver(() => {
      if (!rail.classList.contains('on')) return;
      railBox();
      syncRail();
    }).observe(messagesEl);
  }

  function jumpToPrompt(i) {
    const row = railRows[i];
    if (!row) return;
    // A jump the visitor asked for is the one place an animated scroll helps.
    row.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function scrubTo(event) {
    const rect = rail.getBoundingClientRect();
    const thumbH = railThumb.offsetHeight || 24;
    const travel = Math.max(1, rect.height - thumbH);
    const y = Math.min(travel, Math.max(0, event.clientY - rect.top - thumbH / 2));
    messagesEl.scrollTop = (y / travel) * Math.max(0, messagesEl.scrollHeight - messagesEl.clientHeight);
  }

  // The strip is a scrubber first and a list of buttons second: marks sit only
  // a few pixels apart in a long thread, so "which mark did they mean" is
  // answered by distance rather than by whichever button happens to be on top.
  let scrubbing = false;
  let scrubMoved = false;
  let scrubStartY = 0;

  function nearestTick(clientY) {
    if (!railPos.length) return -1;
    const rect = rail.getBoundingClientRect();
    const at = (clientY - rect.top) / Math.max(1, rect.height);
    let best = -1;
    let bestGap = Infinity;
    for (let i = 0; i < railPos.length; i += 1) {
      const gap = Math.abs(railPos[i] - at);
      if (gap < bestGap) { bestGap = gap; best = i; }
    }
    return bestGap * rect.height <= 9 ? best : -1;
  }

  rail.addEventListener('pointerdown', (event) => {
    scrubbing = true;
    scrubMoved = false;
    scrubStartY = event.clientY;
    event.preventDefault();
    try {
      rail.setPointerCapture(event.pointerId);
    } catch { /* a pointer the browser never started cannot be captured */ }
  });
  rail.addEventListener('pointermove', (event) => {
    if (!scrubbing) return;
    if (!scrubMoved && Math.abs(event.clientY - scrubStartY) < 4) return;
    scrubMoved = true;
    scrubTo(event);
  });
  function endScrub(event) {
    if (!scrubbing) return;
    scrubbing = false;
    try {
      if (rail.hasPointerCapture(event.pointerId)) rail.releasePointerCapture(event.pointerId);
    } catch { /* already released */ }
    if (scrubMoved) return;
    const near = nearestTick(event.clientY);
    if (near >= 0) jumpToPrompt(near);
    else scrubTo(event);
  }
  rail.addEventListener('pointerup', endScrub);
  rail.addEventListener('pointercancel', endScrub);
  // Keyboard activation produces a click with no pointer behind it.
  rail.addEventListener('click', (event) => {
    if (event.detail !== 0) return;
    const tick = event.target.closest('.jump-tick');
    if (tick) jumpToPrompt(Number(tick.dataset.i));
  });
  rail.addEventListener('pointerover', (event) => {
    const tick = event.target.closest('.jump-tick');
    if (!tick) return;
    const i = Number(tick.dataset.i);
    railLabel.textContent = railText(railRows[i]) || `Prompt ${i + 1}`;
    railLabel.style.top = tick.style.top;
    railLabel.classList.add('show');
  });
  rail.addEventListener('pointerout', (event) => {
    if (event.target.closest('.jump-tick')) railLabel.classList.remove('show');
  });

  let resizeTimer = null;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(buildRail, 180);
  });

  /* ---------------- sending ---------------- */

  const CHUNK_HEADROOM = 600;

  function attachmentLang(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    return Object.keys(EXT_BY_LANG).find((k) => EXT_BY_LANG[k] === ext) || ext;
  }

  function composeWithAttachments(text) {
    const files = state.attachments.filter((f) => !f.image);
    const images = state.attachments.filter((f) => f.image);
    const blocks = files.map((file) =>
      '```' + attachmentLang(file.name) + ' ' + file.name + '\n' + file.text + '\n```');
    const notes = images.map((f) => `[image attached: ${f.name}]`);
    const body = blocks.concat(notes);
    if (!body.length) return text;
    const head = `${body.length > 1 ? 'Attached files' : 'Attached file'}:\n\n${body.join('\n\n')}`;
    return text ? `${text}\n\n${head}` : head;
  }

  function splitFileText(text, limit) {
    const parts = [];
    let rest = text;
    while (rest.length > limit) {
      let cut = rest.lastIndexOf('\n', limit);
      if (cut < limit * 0.5) cut = limit;
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut + 1);
    }
    if (rest.length) parts.push(rest);
    return parts;
  }

  function composeParts(text) {
    const files = state.attachments.filter((f) => !f.image);
    const images = state.attachments.filter((f) => f.image);
    const totalText = files.reduce((n, f) => n + f.text.length, 0);
    const imageUrls = images.map((f) => f.image);
    if (!prefs.splitBig || totalText <= SPLIT_BYTES) {
      return [{ text: composeWithAttachments(text), images: imageUrls }];
    }
    const parts = [];
    let lead = text;
    for (const file of files) {
      const chunks = splitFileText(file.text, SPLIT_BYTES - CHUNK_HEADROOM);
      chunks.forEach((chunk, i) => {
        const label = chunks.length > 1 ? `${file.name} (part ${i + 1}/${chunks.length})` : file.name;
        const block = '```' + attachmentLang(file.name) + ' ' + label + '\n' + chunk + '\n```';
        const head = i === 0 ? [lead, ...images.map((f) => `[image attached: ${f.name}]`)].filter(Boolean).join('\n\n') : '';
        parts.push({ text: head ? `${head}\n\n${block}` : block, images: i === 0 ? imageUrls : [] });
      });
      lead = '';
    }
    return parts;
  }

  // Every request is paid for by the signed-in user's own key, so both the
  // account and the key have to be in place before anything is sent. The typed
  // message is passed through the gate rather than cleared, so nobody loses it.
  function withKey(fn) {
    if (!Auth.signedIn) {
      Auth.showSignIn(() => withKey(fn));
      return;
    }
    if (!Auth.hasKey) {
      Auth.showKeyGate((_user, meta) => {
        if (!meta?.skippedKey) withKey(fn);
      });
      return;
    }
    fn();
  }

  async function send(rawText) {
    const text = (rawText ?? inputEl.value).trim();
    // Attaching a file without typing anything is a valid question: "look at this".
    if (!text && !state.attachments.length) return;
    if (state.streaming) {
      toast('Still generating — press Esc to stop it first', true);
      return;
    }
    withKey(() => prepareAndDispatch(text));
  }

  // Auto-improve happens before the send, which is the one moment it can still be
  // seen: the rewrite is what the bubble shows and what the provider is billed for.
  async function prepareAndDispatch(text) {
    let final = text;
    let refined = false;
    if (prefs.refine && text.length >= 12) {
      statusEl.textContent = 'improving the prompt…';
      const better = await rewritePrompt(text);
      if (better && better.length >= 12) {
        final = better;
        refined = true;
      }
      statusEl.textContent = '';
    }
    const parts = composeParts(final);
    const titleHint = final || text;
    const names = state.attachments.map((f) => f.name);
    clearAttachments();
    inputEl.value = '';
    autosize();
    for (let i = 0; i < parts.length; i += 1) {
      if (parts.length > 1) statusEl.textContent = `part ${i + 1} of ${parts.length}…`;
      await dispatch(parts[i], refined && i === 0, { titleHint, names });
    }
    statusEl.textContent = '';
  }

  async function dispatch(part, refined = false, meta = {}) {
    window.Style?.play('send');
    const conv = ensureConv();
    conv.model = conv.model || prefs.model;
    const userMessage = { role: 'user', content: part.text, ts: Date.now() };
    if (part.images?.length) userMessage.images = part.images;
    if (refined) userMessage.refined = true;
    conv.messages.push(userMessage);
    if (!conv.title) conv.title = makeTitle(meta.titleHint || part.text || meta.names?.[0] || 'New chat');

    const assistantIndex = conv.messages.length;
    conv.messages.push({
      role: 'assistant', content: '', reasoning: '', ts: Date.now(),
      model: conv.model, thinking: true
    });

    conv.updatedAt = Date.now();
    renderConversation();
    renderConvList();
    saveChats();

    await streamReply(conv, assistantIndex);
  }

  function regenerate(index) {
    if (state.streaming) return;
    if (!activeConv()) return;
    // Retry spends tokens too, so it goes through the same gate as a new send.
    withKey(() => doRegenerate(index));
  }

  async function doRegenerate(index) {
    const conv = activeConv();
    if (!conv) return;
    // Regenerating truncates everything after that answer, like a normal chat UI.
    conv.messages.length = index;
    conv.messages.push({
      role: 'assistant', content: '', reasoning: '', ts: Date.now(),
      model: conv.model || prefs.model, thinking: true
    });
    renderConversation();
    saveChats();
    await streamReply(conv, index);
  }

  /* ---------------- composer ---------------- */

  function autosize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 220) + 'px';
    const count = $('#charCount');
    const len = inputEl.value.length;
    count.hidden = len < 1500;
    count.textContent = `${len.toLocaleString()} chars`;
    // aria-disabled rather than disabled: a disabled button swallows the click,
    // so any state desync would leave the user with a dead Send button.
    // An attached file is a complete message on its own, so it also unlocks Send.
    const idle = state.streaming || (!inputEl.value.trim() && !state.attachments.length);
    sendBtn.setAttribute('aria-disabled', String(idle));
  }

  function renderAttachments() {
    let tray = $('.attachment-chips');
    if (!state.attachments.length) {
      tray?.remove();
      return;
    }
    if (!tray) {
      tray = document.createElement('div');
      tray.className = 'attachment-chips';
      $('.composer-wrap').prepend(tray);
    }
    tray.replaceChildren();
    state.attachments.forEach((file, i) => {
      const chip = document.createElement('div');
      chip.className = 'attach-chip' + (file.image ? ' attach-chip-image' : '');
      if (file.image) {
        const thumb = document.createElement('img');
        thumb.className = 'attach-thumb';
        thumb.alt = '';
        thumb.src = file.image;
        chip.appendChild(thumb);
      }
      const label = document.createElement('span');
      const kb = ((file.image ? file.image.length : file.text.length) / 1024).toFixed(1);
      label.textContent = `${file.name} · ${kb} KB`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${file.name}`);
      remove.innerHTML = '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>';
      remove.addEventListener('click', () => {
        state.attachments.splice(i, 1);
        renderAttachments();
      });
      chip.append(label, remove);
      tray.appendChild(chip);
    });
  }

  function clearAttachments() {
    state.attachments = [];
    renderAttachments();
    $('#fileInput').value = '';
  }

  // A pasted or dropped picture is read through FileReader because the CSP does
  // not allow blob: images, then scaled down here: a 4 MB phone photo becomes a
  // few hundred KB before it can ever reach a request.
  function readImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('unreadable'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('unreadable'));
        img.onload = () => {
          const max = 1280;
          const scale = Math.min(1, max / Math.max(img.width || 1, img.height || 1));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round((img.width || 1) * scale));
          canvas.height = Math.max(1, Math.round((img.height || 1) * scale));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.82));
        };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });
  }

  async function handleFiles(fileList) {
    const jobs = Array.from(fileList || []).map(async (file) => {
      if (/^image\//.test(file.type || '')) {
        if (file.size > MAX_IMAGE_BYTES) {
          toast(`${file.name || 'image'} is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB — skipped`, true);
          return null;
        }
        try {
          return { name: file.name || 'pasted-image.jpg', image: await readImage(file) };
        } catch {
          toast(`Could not read ${file.name || 'the image'}`, true);
          return null;
        }
      }
      if (file.size > MAX_ATTACH_BYTES) {
        toast(`${file.name} is over ${MAX_ATTACH_BYTES / 1024} KB — skipped`, true);
        return null;
      }
      try {
        return { name: file.name, text: await file.text() };
      } catch {
        toast(`Could not read ${file.name}`, true);
        return null;
      }
    });
    const loaded = (await Promise.all(jobs)).filter(Boolean);
    state.attachments.push(...loaded);
    renderAttachments();
    autosize();
  }

  /* ---------------- drag in from disk ---------------- */

  // Dropping a file on the page is the same attach as picking it, with nothing in
  // between: the browser hands over a reference to the file on disk and it is read
  // once, here — no copy into a scratch folder, no paste step. The list of names
  // this chat accepts is read off the picker element so the two can never disagree
  // about what an attachment is.
  function armDrop() {
    const exts = String($('#fileInput').accept || '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    const attachable = (file) => {
      if (/^image\//.test(file.type || '')) return true;
      const name = String(file.name || '').toLowerCase();
      return exts.some((ext) => (ext.startsWith('.') ? name.endsWith(ext) : name === ext || name.endsWith(`/${ext}`)));
    };

    const veil = document.createElement('div');
    veil.className = 'drop-veil';
    veil.hidden = true;
    const card = document.createElement('div');
    card.className = 'drop-card';
    card.textContent = 'Drop the file — it is read straight off your disk and never leaves this browser except with your message';
    veil.append(card);
    document.body.append(veil);

    let depth = 0;
    const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');

    document.addEventListener('dragenter', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      veil.hidden = false;
    });
    document.addEventListener('dragover', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) veil.hidden = true;
    });
    document.addEventListener('drop', (event) => {
      if (!hasFiles(event)) return;
      // Preventing the default is also what stops the browser navigating away to
      // the file somebody missed the composer with.
      event.preventDefault();
      depth = 0;
      veil.hidden = true;
      const files = Array.from(event.dataTransfer.files || []);
      const wanted = files.filter(attachable);
      const others = files.filter((file) => !attachable(file));
      if (wanted.length) handleFiles(wanted);
      if (others.length) {
        toast(`${others[0].name} is not a file this chat can read`, true);
      }
    });
  }

  /* ---------------- prompt improving ---------------- */

  /* A model answers the question it was given, so a vague question buys a vague
     answer. This rewriter asks for the same request as a brief: the goal, the
     constraints that were actually stated, and the shape of the answer wanted —
     without inventing facts, and in the language the visitor wrote in. */
  const REWRITE_SYSTEM = 'You rewrite a developer\'s message into a better prompt for a coding assistant.\n'
    + 'Rules:\n'
    + '1. Keep every concrete detail the writer gave: file paths, names, versions, error text, commands,\n'
    + '   numbers. Never invent a fact, a library, a requirement or a constraint that was not there.\n'
    + '2. Say the goal first, then what is given, then what must not change, then the shape of the\n'
    + '   answer wanted (fix + explanation, patch, options, tests) when the writer implied it.\n'
    + '3. Make the task checkable: if the request is ambiguous, name the assumption the shortest correct\n'
    + '   answer would make instead of asking a question.\n'
    + '4. Write in the same language as the message. Keep code, identifiers and error text verbatim.\n'
    + '5. Output only the rewritten prompt — no preamble, no quotation marks, no bullet list, no\n'
    + '   explanation of what you changed. Stay under 200 words unless the original was longer.';

  // A model may wrap the answer in a fence or open with "Here is the prompt:".
  // Neither belongs in the textarea or in the message it becomes.
  function cleanRewrite(text) {
    return String(text || '')
      .replace(/^[\s\S]*?```(?:\w*)\n?([\s\S]*?)```[\s\S]*$/, '$1')
      .replace(/^\s*(?:prompt|here(?:'s| is) the (?:improved|better|rewritten) prompt)\s*[:\-]\s*/i, '')
      .replace(/^["'\u201c]+|["'\u201d]+$/g, '')
      .trim()
      .slice(0, 6000);
  }

  // The last few turns go along as context, so "make it faster" becomes a request
  // about the function the assistant just wrote rather than a floating sentence.
  async function rewritePrompt(text) {
    const conv = activeConv();
    const tail = (conv?.messages || [])
      .slice(-4)
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content).replace(/\s+/g, ' ').slice(0, 700)}`)
      .join('\n');
    const ask = tail ? `Conversation so far:\n${tail}\n\nMessage to rewrite:\n${text}` : text;
    try {
      const res = await Auth.api('/api/chat', {
        method: 'POST',
        body: {
          stream: false,
          model: prefs.model,
          temperature: 0.4,
          messages: [{ role: 'system', content: REWRITE_SYSTEM }, { role: 'user', content: ask }]
        }
      });
      if (!res.ok) return null;
      const answer = res.data?.choices?.[0]?.message?.content;
      const cleaned = cleanRewrite(typeof answer === 'string' ? answer : '');
      return cleaned.length >= 12 ? cleaned : null;
    } catch {
      return null;
    }
  }

  // Auto is a judgement about the request, not a coin toss: a pasted trace or a
  // refactor is worth thinking about, a one-line question is not.
  function resolveEffort(text) {
    if (prefs.effort !== 'auto') return prefs.effort;
    const value = String(text || '');
    if (value.length > 600 || /```/.test(value)
      || /\b(error|stack|trace|exception|debug|refactor|migrat|architecture|optimi[sz]e|race|deadlock|memory leak|security|vulnerab)\b/i.test(value)) {
      return 'high';
    }
    return value.length < 90 ? 'low' : 'medium';
  }

  async function improveNow() {
    const text = inputEl.value.trim();
    if (!text) {
      toast('Write what you want first — the rewriter needs a starting point', true);
      inputEl.focus();
      return;
    }
    if (state.streaming) {
      toast('Still generating — wait for the answer to finish', true);
      return;
    }
    withKey(async () => {
      statusEl.textContent = 'rewriting…';
      const better = await rewritePrompt(text);
      statusEl.textContent = '';
      if (!better) {
        toast('The rewriter did not answer — your text is untouched', true);
        return;
      }
      inputEl.value = better;
      autosize();
      inputEl.focus();
      toast('Rewritten — send it when you are happy');
    });
  }

  /* ---------------- theme ---------------- */

  function applyTheme() {
    document.documentElement.dataset.theme = prefs.theme;
    $('#themeLabel').textContent = prefs.theme === 'dark' ? 'Dark' : 'Light';
  }

  function openSettingsTab(name) {
    const panel = $('#settingsPanel');
    panel.hidden = false;
    for (const tab of $$('.sp-tab', panel)) tab.classList.toggle('is-on', tab.dataset.sp === name);
    for (const pane of $$('.sp-pane', panel)) pane.hidden = pane.dataset.sp !== name;
  }

  function showPwMsg(text, ok) {
    const msg = $('#pwMsg');
    msg.textContent = text;
    msg.className = 'sp-note ' + (ok ? 'ok' : 'bad');
    msg.hidden = false;
  }

  /* ---------------- events ---------------- */

  function bindEvents() {
    sendBtn.addEventListener('click', () => send());
    stopBtn.addEventListener('click', stopStreaming);

    // Effort and the rewriter live beside the composer, because they change how the
    // next send behaves, not how the whole account behaves.
    const effortSel = $('#effortSel');
    const autoBtn = $('#autoImproveBtn');
    effortSel.value = prefs.effort || 'auto';
    const paintAuto = () => {
      autoBtn.setAttribute('aria-pressed', String(Boolean(prefs.refine)));
      autoBtn.classList.toggle('on', Boolean(prefs.refine));
    };
    paintAuto();
    effortSel.addEventListener('change', () => {
      prefs.effort = effortSel.value;
      savePrefs();
    });
    $('#improveBtn').addEventListener('click', improveNow);
    autoBtn.addEventListener('click', () => {
      prefs.refine = !prefs.refine;
      paintAuto();
      savePrefs();
      toast(prefs.refine
        ? 'Auto-improve is on — each prompt is rewritten before it is sent'
        : 'Auto-improve is off');
    });
    const splitBtn = $('#splitBtn');
    const paintSplit = () => {
      splitBtn.setAttribute('aria-pressed', String(Boolean(prefs.splitBig)));
      splitBtn.classList.toggle('on', Boolean(prefs.splitBig));
    };
    paintSplit();
    splitBtn.addEventListener('click', () => {
      prefs.splitBig = !prefs.splitBig;
      paintSplit();
      savePrefs();
      toast(prefs.splitBig
        ? 'Large files are on — anything over 100 KB is sent in parts'
        : 'Large-file splitting is off — files are sent whole');
    });
    $('#newChatBtn').addEventListener('click', newConversation);
    $('#clearAllBtn').addEventListener('click', () => {
      if (!state.conversations.length) return toast('Nothing to delete');
      if (!confirm('Delete every saved chat? This cannot be undone.')) return;
      if (state.streaming) stopStreaming();
      state.conversations = [];
      state.activeId = null;
      saveChats();
      renderConvList();
      renderConversation();
    });

    $('#themeBtn').addEventListener('click', () => {
      prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark';
      savePrefs();
      applyTheme();
    });

    $('#convSearchInput').addEventListener('input', renderConvList);

    const setSidebar = (collapsed) => {
      appEl.classList.toggle('collapsed', collapsed);
      $('#scrim').hidden = collapsed;
      if (matchMedia('(min-width: 901px)').matches) {
        prefs.collapsed = collapsed;
        savePrefs();
      }
    };
    $('#menuBtn').addEventListener('click', () => setSidebar(false));
    $('#closeSidebarBtn').addEventListener('click', () => setSidebar(true));
    $('#scrim').addEventListener('click', () => setSidebar(true));
    setSidebar(matchMedia('(max-width: 900px)').matches ? true : Boolean(prefs.collapsed));

    modelBtn.addEventListener('click', () => toggleModelPanel());
    $('#modelSearchInput').addEventListener('input', (event) => {
      state.modelQuery = event.target.value;
      renderModelList();
    });

    const settingsPanel = $('#settingsPanel');
    $('#settingsBtn').addEventListener('click', () => {
      settingsPanel.hidden = !settingsPanel.hidden;
    });
    $('#systemPrompt').value = prefs.systemPrompt;
    $('#temperature').value = prefs.temperature;
    $('#tempVal').textContent = Number(prefs.temperature).toFixed(1);
    $('#maxTokens').value = prefs.maxTokens || '';
    $('#systemPrompt').addEventListener('input', (e) => { prefs.systemPrompt = e.target.value; savePrefs(); });
    $('#temperature').addEventListener('input', (e) => {
      prefs.temperature = e.target.value;
      $('#tempVal').textContent = Number(e.target.value).toFixed(1);
      savePrefs();
    });
    $('#maxTokens').addEventListener('input', (e) => { prefs.maxTokens = e.target.value; savePrefs(); });

    for (const tab of $$('.sp-tab')) {
      tab.addEventListener('click', () => openSettingsTab(tab.dataset.sp));
    }

    acctBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleAcctMenu();
    });

    const afterKeyChange = (user, meta) => {
      state.user = user;
      renderAccount();
      if (meta?.warning) toast(meta.warning, true);
      else if (user?.hasKey) toast('API key saved');
    };

    acctMenu.addEventListener('click', (event) => {
      const item = event.target.closest('[data-acct]');
      if (!item) return;
      toggleAcctMenu(false);
      if (item.dataset.acct === 'key') {
        openSettingsTab('account');
        Auth.showKeyGate(afterKeyChange);
      } else if (item.dataset.acct === 'password') {
        openSettingsTab('account');
        setTimeout(() => $('#pwCurrent').focus(), 40);
      } else if (item.dataset.acct === 'signout') {
        Auth.signOut();
      }
    });

    keyEditBtn.addEventListener('click', () => Auth.showKeyGate(afterKeyChange));

    keyRemoveBtn.addEventListener('click', async () => {
      if (!confirm('Remove your saved API key? You cannot chat until you add another.')) return;
      const res = await Auth.api('/api/key', { method: 'DELETE' });
      if (!res.ok) return toast(res.data.error || 'Could not remove the key', true);
      afterKeyChange(res.data.user);
    });

    $('#pwForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const current = $('#pwCurrent').value;
      const next = $('#pwNew').value;
      if (!current || !next) return showPwMsg('Enter your current password and a new one.', false);
      const res = await Auth.api('/api/auth/password', {
        method: 'POST',
        body: { currentPassword: current, newPassword: next }
      });
      if (!res.ok) return showPwMsg(res.data.error || `Could not change it (${res.status})`, false);
      event.currentTarget.reset();
      showPwMsg('Password changed. Every other session was signed out.', true);
    });

    $('#signOutBtn').addEventListener('click', () => Auth.signOut());

    inputEl.addEventListener('input', autosize);
    inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        send();
      }
    });
    inputEl.addEventListener('paste', (event) => {
      const images = Array.from(event.clipboardData?.items || [])
        .filter((item) => item.type?.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter(Boolean);
      if (images.length) {
        event.preventDefault();
        handleFiles(images);
        return;
      }
      const text = event.clipboardData?.getData('text');
      if (text && text.length > 3000 && !inputEl.value.length) {
        event.preventDefault();
        handleFiles([{ name: 'pasted.txt', size: text.length, text: () => Promise.resolve(text) }]);
      }
    });

    $('#attachBtn').addEventListener('click', () => $('#fileInput').click());
    $('#fileInput').addEventListener('change', (event) => handleFiles(event.target.files));
    armDrop();

    document.addEventListener('click', (event) => {
      if (!modelPanel.hidden && !$('#modelPicker').contains(event.target)) toggleModelPanel(false);
      if (!settingsPanel.hidden && !settingsPanel.contains(event.target) && !$('#settingsBtn').contains(event.target)) {
        settingsPanel.hidden = true;
      }
      if (!acctMenu.hidden && !$('#acctRow').contains(event.target)) toggleAcctMenu(false);
    });

    document.addEventListener('keydown', (event) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.shiftKey && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        newConversation();
      } else if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        toggleModelPanel(true);
      } else if (event.key === 'Escape') {
        if (state.streaming) return stopStreaming();
        if (!modelPanel.hidden) return toggleModelPanel(false);
        if (!acctMenu.hidden) return toggleAcctMenu(false);
        if (!settingsPanel.hidden) settingsPanel.hidden = true;
      }
    });

    // Delegated actions for message + code block buttons.
    streamInner.addEventListener('click', (event) => {
      const trigger = event.target.closest('[data-act]');
      if (!trigger) return;
      const block = trigger.closest('.code-block');
      const msgEl = trigger.closest('.msg');
      const index = Number(msgEl?.dataset.index);
      const msg = activeConv()?.messages[index];
      if (!msg) return;

      switch (trigger.dataset.act) {
        case 'copy-code': {
          const raw = block?._raw ?? '';
          copyText(raw).then((ok) => {
            if (ok) { flashButton(trigger, 'Copied'); toast(`Copied ${raw.split('\n').length} lines`); }
            else toast('Copy blocked by the browser', true);
          });
          break;
        }
        case 'download-code': {
          const raw = block?._raw ?? '';
          const lang = block?.dataset.lang || 'txt';
          const ext = EXT_BY_LANG[lang] || lang || 'txt';
          const base = block?.dataset.filename || `snippet-${index + 1}.${ext}`;
          download(base.includes('.') ? base : `${base}.${ext}`, raw);
          toast(`Downloaded ${base}`);
          break;
        }
        case 'copy-msg':
          copyText(msg.content).then((ok) => {
            if (ok) flashButton(trigger, 'Copied');
            else toast('Copy blocked by the browser', true);
          });
          break;
        case 'copy-all-code': {
          const blocks = $$('.code-block', msgEl);
          if (!blocks.length) return toast('No code in this answer', true);
          const text = blocks.map((b, i) => {
            const name = b.dataset.filename || `block-${i + 1}.${EXT_BY_LANG[b.dataset.lang] || b.dataset.lang || 'txt'}`;
            return `// ===== ${name} =====\n${b._raw}`;
          }).join('\n\n');
          copyText(text).then((ok) => {
            if (ok) {
              flashButton(trigger, 'Copied');
              toast(`Copied ${blocks.length} code block${blocks.length > 1 ? 's' : ''}`);
            } else toast('Copy blocked by the browser', true);
          });
          break;
        }
        case 'download-all': {
          const blocks = $$('.code-block', msgEl);
          if (!blocks.length) return toast('No code in this answer', true);
          const files = blocksToFiles(blocks);
          const bytes = Zip.download(files, zipNameFor(activeConv()));
          flashButton(trigger, 'Saved');
          toast(`${files.length} file${files.length > 1 ? 's' : ''} · ${(bytes / 1024).toFixed(1)} KB`);
          break;
        }
        case 'regen':
          regenerate(index);
          break;
      }
    });

    $('#suggestions').replaceChildren();
    for (const [title, blurb] of SUGGESTIONS) {
      const card = document.createElement('button');
      card.className = 'suggestion';
      card.type = 'button';
      const b = document.createElement('b');
      b.textContent = title;
      const s = document.createElement('span');
      s.textContent = blurb;
      card.append(b, s);
      card.addEventListener('click', () => {
        inputEl.value = title === 'Explain this error' ? 'Explain this error and how to fix it:\n\n' : `${title}: `;
        inputEl.focus();
        autosize();
        const len = inputEl.value.length;
        inputEl.setSelectionRange(len, len);
      });
      $('#suggestions').appendChild(card);
    }
  }

  /* ---------------- boot ---------------- */

  let enteredFor = null;

  function enterApp(user) {
    const switched = enteredFor !== user.id;
    state.user = user;
    try { localStorage.setItem(LAST_USER_KEY, JSON.stringify({ id: user.id })); } catch { /* ignore */ }
    if (switched) {
      enteredFor = user.id;
      if (preloadedFor && preloadedFor === user.id) {
        // Already parsed at boot; only the interrupted turns need touching.
        for (const conv of state.conversations) {
          for (const msg of conv.messages || []) {
            if (!msg.thinking) continue;
            msg.thinking = false;
            if (!msg.content && !msg.reasoning && !msg.error) msg.error = 'Interrupted before any output arrived.';
          }
        }
        state.activeId = state.activeId || state.conversations[0]?.id || null;
      } else {
        loadChats();
      }
      preloadedFor = user.id;
      renderConversation();
      // Load the catalogue after the thread is on screen, so typing and scrolling
      // never wait for a network round trip.
      setTimeout(() => {
        loadModels().then(() => {
          const conv = activeConv();
          if (conv && !conv.model) conv.model = prefs.model;
        });
      }, 0);
    }
    renderAccount();
    renderConvList();
  }

  let preloadedFor = null;

  async function boot() {
    applyTheme();
    bindEvents();
    autosize();
    preloadChats();
    renderAccount();
    // Preloaded history is parsed, not drawn: until the server says who this is,
    // showing it could hand one account's chat to the next person at the machine.
    if (!preloadedFor) {
      renderConvList();
      renderConversation();
    }

    Auth.onSession((user) => {
      if (!user) {
        location.reload();
        return;
      }
      enterApp(user);
    });

    await Auth.boot({ requireKey: true });
    if (Auth.signedIn) inputEl.focus();
  }

  function preloadChats() {
    const cached = readStore(LAST_USER_KEY, null);
    if (!cached?.id) return;
    const stored = readStore(`${CHAT_PREFIX}:u${cached.id}`, null);
    if (Array.isArray(stored)) {
      preloadedFor = cached.id;
      state.conversations = stored;
    }
  }

  boot();
})();
