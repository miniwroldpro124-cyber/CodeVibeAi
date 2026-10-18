(() => {
  'use strict';

  const { $, esc, vnd, int, initTheme, initNav } = window.Page;

  const SORTS = [
    ['name', (a, b) => a.id.localeCompare(b.id)],
    ['cheapest output', (a, b) => (a.output || 0) - (b.output || 0) || a.id.localeCompare(b.id)],
    ['priciest output', (a, b) => (b.output || 0) - (a.output || 0) || a.id.localeCompare(b.id)],
    ['cheapest input', (a, b) => (a.input || 0) - (b.input || 0) || a.id.localeCompare(b.id)]
  ];

  // Rows rendered before the table stops and asks the user to filter.
  const LIST_CAP = 400;

  const state = {
    models: [],
    markupPercent: 20,
    live: false,
    query: '',
    sortIndex: 0
  };

  const els = {
    model: $('#model'),
    inTok: $('#inTok'),
    outTok: $('#outTok'),
    reqs: $('#reqs'),
    markup: $('#markup'),
    markupVal: $('#markupVal'),
    results: $('#results'),
    note: $('#note'),
    q: $('#q'),
    sortBtn: $('#sortBtn'),
    rows: $('#rows'),
    count: $('#count'),
    listMarkup: $('#listMarkup'),
    calcSub: $('#calcSub')
  };

  /* ------------------------------------------------------------- estimate */

  // Pricing maths lives on the server so the calculator, the chat cost chip and
  // the usage log can never disagree about the minimum charge or the markup.
  let timer = null;
  function scheduleEstimate() {
    clearTimeout(timer);
    timer = setTimeout(runEstimate, 160);
  }

  // A slider drag fires many estimates; without this the slower earlier reply
  // can land last and show numbers for inputs that are no longer on screen.
  let seq = 0;

  async function runEstimate() {
    const mine = ++seq;
    const body = {
      model: els.model.value,
      promptTokens: Math.max(0, Number(els.inTok.value) || 0),
      completionTokens: Math.max(0, Number(els.outTok.value) || 0),
      requests: Math.max(1, Number(els.reqs.value) || 1),
      markupPercent: Number(els.markup.value) || 0
    };
    const res = await Auth.api('/api/pricing/estimate', { method: 'POST', body });
    if (mine !== seq) return;
    if (!res.ok) {
      if (!Auth.guard(res)) return;
      els.results.innerHTML = `<div class="result"><b>—</b><span>${esc(res.data.error || 'Estimate failed')}</span></div>`;
      return;
    }
    renderEstimate(res.data);
  }

  function renderEstimate(data) {
    if (!data.known) {
      els.results.innerHTML = `
        <div class="result hero"><b>—</b><span>No list price</span></div>
        <div class="result"><b>—</b><span>Monthly total</span></div>`;
      showNote(`The provider does not publish a price for <code>${esc(data.model)}</code>, so nothing can be quoted. Pick another model, or check ckey.vn.`);
      return;
    }

    const cells = [
      ['hero', vnd(data.perRequestMarked), `Per request · +${data.markupPercent}%`],
      ['', vnd(data.perRequestBase), 'Per request · list price'],
      ['', vnd(data.totalMarked), `Monthly · ${int(data.requests)} requests`],
      ['', vnd(data.totalBase), 'Monthly at list price'],
      ['', vnd(data.markupGain), `Markup adds / month`]
    ];
    els.results.innerHTML = cells.map(([cls, value, label]) => `
      <div class="result ${cls}">
        <b>${esc(value)}</b>
        <span>${esc(label)}</span>
      </div>`).join('');

    const bits = [];
    bits.push(`List price: <b>${vnd(data.inputPrice)}</b> in and <b>${vnd(data.outputPrice)}</b> out per 1M tokens.`);
    if (data.minApplied) {
      bits.push(
        `At ${int(data.promptTokens + data.completionTokens)} tokens this request is below the provider floor of ` +
        `<b>${vnd(data.minCharge)}</b>, so the floor is what you pay — not the per-token maths ` +
        `(${vnd(data.rawCost)}).`
      );
    }
    showNote(bits.join(' '));
  }

  function showNote(html) {
    els.note.innerHTML = html;
    els.note.hidden = false;
  }

  /* ------------------------------------------------------------ price list */

  function renderList() {
    const q = state.query.trim().toLowerCase();
    const [, cmp] = SORTS[state.sortIndex];
    const rows = state.models
      .filter((m) => !q || m.id.toLowerCase().includes(q))
      .sort(cmp);

    els.count.textContent = `${int(rows.length)} of ${int(state.models.length)} models`;
    els.sortBtn.textContent = `Sort: ${SORTS[state.sortIndex][0]}`;

    if (!rows.length) {
      els.rows.innerHTML = `<tr class="empty-row"><td colspan="6">No model matches “${esc(state.query)}”.</td></tr>`;
      return;
    }

    const rate = 1 + (Number(els.markup.value) || 0) / 100;
    // 500+ rows is fine for the DOM, but slicing keeps typing in the filter snappy.
    const shown = rows.slice(0, LIST_CAP);
    els.rows.innerHTML = shown.map((m) => `
      <tr>
        <td class="mono">${esc(m.id)}</td>
        <td class="num">${m.input ? vnd(m.input) : '—'}</td>
        <td class="num">${m.cacheRead ? vnd(m.cacheRead) : '—'}</td>
        <td class="num">${m.output ? vnd(m.output) : '—'}</td>
        <td class="num">${m.output ? vnd(m.output * rate) : '—'}</td>
        <td class="num">${m.min ? vnd(m.min) : '—'}</td>
      </tr>`).join('') + (rows.length > shown.length
      // Without this the count says 524 but the table quietly stops at 400.
      ? `<tr class="empty-row"><td colspan="6">Showing the first ${int(shown.length)} of ${int(rows.length)}. Filter to narrow the list.</td></tr>`
      : '');
  }

  function renderModelOptions() {
    const current = els.model.value;
    els.model.innerHTML = state.models
      .map((m) => `<option value="${esc(m.id)}">${esc(m.id)}</option>`)
      .join('');
    if (current && state.models.some((m) => m.id === current)) {
      els.model.value = current;
      return;
    }
    // Start on whatever the chat is using, so the two pages quote the same model.
    const preferred = window.Page.prefs().model || 'deepseek-v4.1-flash';
    els.model.value = state.models.some((m) => m.id === preferred) ? preferred : state.models[0]?.id || '';
  }

  /* ------------------------------------------------------------------ load */

  async function load() {
    const res = await Auth.api('/api/pricing');
    if (!res.ok) {
      Auth.guard(res);
      els.rows.innerHTML = `<tr class="empty-row"><td colspan="6">${esc(res.data.error || 'Could not load prices')}</td></tr>`;
      return;
    }
    const data = res.data;
    state.models = data.models || [];
    state.markupPercent = Number(data.markupPercent) || 0;
    state.live = Boolean(data.live);

    // An admin can set the markup above the slider's usual ceiling; widen it
    // rather than silently quoting a smaller number than the one in force.
    els.markup.max = String(Math.max(200, Math.ceil(state.markupPercent)));
    els.markup.value = String(state.markupPercent);
    els.markupVal.textContent = String(state.markupPercent);
    els.listMarkup.textContent = String(state.markupPercent);
    renderModelOptions();
    renderList();

    els.calcSub.innerHTML = state.live
      ? `Estimate what a workload costs on <b>your own</b> key, using ${int(state.models.length)} live prices from ckey.vn.`
      : 'Prices could not be loaded from the provider right now — the calculator will quote nothing until they arrive.';

    await runEstimate();
  }

  /* ----------------------------------------------------------------- events */

  function bind() {
    initTheme($('#themeBtn'));

    els.markup.addEventListener('input', () => {
      els.markupVal.textContent = els.markup.value;
      els.listMarkup.textContent = els.markup.value;
      renderList();
      scheduleEstimate();
    });
    for (const input of [els.model, els.inTok, els.outTok, els.reqs]) {
      input.addEventListener('change', runEstimate);
      input.addEventListener('input', scheduleEstimate);
    }
    els.q.addEventListener('input', () => {
      state.query = els.q.value;
      renderList();
    });
    els.sortBtn.addEventListener('click', () => {
      state.sortIndex = (state.sortIndex + 1) % SORTS.length;
      renderList();
    });

    // Clicking a row loads that model into the calculator.
    els.rows.addEventListener('click', (event) => {
      const cell = event.target.closest('td.mono');
      if (!cell) return;
      els.model.value = cell.textContent;
      runEstimate();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  async function boot() {
    bind();
    Auth.onSession((user) => {
      initNav(user);
      if (user) load();
    });
    const user = await Auth.boot();
    initNav(user);
    if (user) load();
  }

  boot();
})();
