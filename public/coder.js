/* Coding-tool setup. The snippets are the provider's own published shapes, kept
   verbatim except for three tokens — {V1}, {ROOT} and {MODEL} — which are
   replaced with this deployment's live base URL and whichever model is selected,
   so the page never shows a host the operator has not configured. */
(() => {
  'use strict';

  const { $, $$, vnd, initTheme, initNav, copy, flash } = window.Page;

  const KEY = 'sk-YOUR_API_KEY';

  const RULES = [
    ['OpenAI-shaped clients', 'Base URL must end with {V1}. Cursor, the VS Code extensions, Codex, Droid, OpenCode and OpenClaw all take this form.'],
    ['Claude Code', '{ROOT} — the root domain, with no /v1. The Anthropic client adds the path itself, so /v1/v1/messages is what you get when it is left in.'],
    ['One key, every tool', 'The sk- key you saved in Settings works in all of these. It is stored encrypted on the server and never sent back to the browser, so each snippet below carries a placeholder you paste yourself.'],
    ['Model ids are not all bare', 'Most tools take the id exactly as the price list spells it. OpenClaw takes it namespaced with the provider alias, e.g. ckey/gpt-5.4. Namespaced image models (account/model) appear that way in Studio too.']
  ];

  const ENDPOINTS = [
    ['POST', '/v1/chat/completions', 'Chat with messages, tools and optional stream=true.', 'Chat'],
    ['GET', '/v1/models', 'The live catalogue: every model with its prices and its endpoints array.', 'Chat · Pricing · Studio'],
    ['POST', '/v1/images/generations', 'Picture from a prompt; image_url adds a reference picture.', 'Studio'],
    ['POST', '/v2/video/generations', 'Clip job: content[] plus resolution, duration and ratio. Answers a task_id.', 'Studio'],
    ['GET', '/v2/video/generations/TASK_ID', 'Poll the clip job until it reports a file.', 'Studio'],
    ['POST', '/v1/messages', 'Anthropic contract. Needs anthropic-version: 2023-06-01 and a max_tokens field.', 'Claude Code guide'],
    ['POST', '/v1/completions', 'Legacy prompt completion, only where that capability is enabled.', ''],
    ['POST', '/v1/responses', 'Responses format; input and output depend on the upstream contract.', ''],
    ['POST', '/v1/images/edits', 'Multipart upload of the picture to edit.', ''],
    ['POST', '/v1/images/variations', 'Multipart upload, returns variations.', ''],
    ['POST', '/v1/audio/speech', 'Text to speech. The response is binary audio, never JSON.', ''],
    ['POST', '/v1/audio/transcriptions', 'Multipart upload of a recording.', ''],
    ['POST', '/v1/audio/translations', 'Multipart upload, translates what it hears.', ''],
    ['POST', '/v1/video/generations', 'Older clip job shape: prompt and seconds.', ''],
    ['POST', '/v1/embeddings', 'Vectorise an array of texts.', ''],
    ['POST', '/v1/rerank', 'Rank documents against a query, top_n results.', ''],
    ['POST', '/v1/moderations', 'Classify text for safety.', ''],
    ['POST', '/v1/search', 'Web search results for a query.', ''],
    ['POST', '/v1beta/models/MODEL:generateContent', 'Gemini native contract on the same host.', ''],
    ['POST', '/api/chat', 'Ollama native chat contract.', ''],
    ['POST', '/api/generate', 'Ollama native completion contract.', '']
  ];

  const SUGGESTED = ['gpt-5.4', 'claude-opus-4.8', 'claude-sonnet-4.6', 'claude-haiku-4.5', 'deepseek-v4-flash', 'deepseek-v4.1-flash'];

  const TOOLS = [
    {
      id: 'cursor',
      name: 'Cursor',
      lead: 'Cursor goes through the OpenAI-compatible mode with a custom API key and a custom base URL.',
      kind: 'OpenAI-compatible · chat/completions · /v1',
      where: 'Cursor Settings → AI / Models / API Keys',
      fields: [
        ['Provider', 'OpenAI-compatible'],
        ['API key', KEY],
        ['Base URL', '{V1}'],
        ['Model', '{MODEL}'],
        ['Route', 'chat/completions']
      ],
      steps: [
        'Open Cursor Settings and find the AI / Models / API Keys area.',
        'Turn on the custom OpenAI key or custom provider — the wording differs by version.',
        'Paste the API key and the base URL below.',
        'Pick the model, or any other model that is active in the price list.'
      ],
      snippets: [
        ['What you type into the settings form', `Provider: OpenAI-compatible\nAPI Key: ${KEY}\nBase URL: {V1}\nModel: {MODEL}\nRoute: chat/completions`]
      ],
      notes: [
        'Base URL must include /v1 — Cursor speaks the OpenAI shape.',
        'A custom API endpoint needs the Cursor plan that allows it.'
      ]
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      lead: 'Configure it through the Anthropic environment variables, but the base URL is the root domain.',
      kind: 'Anthropic · messages · no /v1',
      where: '~/.claude/settings.json · Windows: %USERPROFILE%\\.claude\\settings.json',
      install: 'npm install -g @anthropic-ai/claude-code',
      fields: [
        ['API key', KEY],
        ['Base URL', '{ROOT}'],
        ['Model', '{MODEL}'],
        ['Route', 'messages'],
        ['max_tokens', '1024 (required on this route)']
      ],
      snippets: [
        ['Temporary, terminal (macOS / Linux)', `export ANTHROPIC_BASE_URL="{ROOT}"\nexport ANTHROPIC_AUTH_TOKEN="${KEY}"\nclaude --bare`],
        ['Temporary, PowerShell', `$env:ANTHROPIC_BASE_URL = "{ROOT}"\n$env:ANTHROPIC_AUTH_TOKEN = "${KEY}"\nclaude --bare`],
        ['Saved in ~/.claude/settings.json', `{
    "env": {
        "ANTHROPIC_BASE_URL": "{ROOT}",
        "ANTHROPIC_AUTH_TOKEN": "${KEY}",
        "ANTHROPIC_DEFAULT_OPUS_MODEL": "{MODEL}",
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4.6",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4.5"
    }
}`]
      ],
      notes: [
        'ANTHROPIC_BASE_URL takes no /v1.',
        'Prefer a model that answers on the messages route.',
        'If Claude Code insists on logging in first, finish that once, then reopen with the variables above.',
        'Every request through the messages route must carry max_tokens.'
      ]
    },
    {
      id: 'vscode',
      name: 'VS Code extensions',
      lead: 'Continue, Cline, Roo Code and Kilo Code are steadiest in OpenAI-compatible mode with a custom base URL.',
      kind: 'OpenAI-compatible · /v1',
      where: 'Continue: ~/.continue/config.yaml · the others: the extension settings panel',
      fields: [
        ['Provider', 'OpenAI-compatible'],
        ['API key', KEY],
        ['Base URL', '{V1}'],
        ['Model', '{MODEL}'],
        ['Route', 'messages or chat/completions']
      ],
      snippets: [
        ['Continue — config.yaml', `name: CKEY API
version: 1.0.0
schema: v1
models:
  - name: {MODEL}
    provider: anthropic
    model: {MODEL}
    apiBase: {V1}
    apiKey: ${KEY}
    roles:
      - chat
      - edit
      - apply`]
      ],
      notes: [
        'Cline, Roo Code and Kilo Code: choose the OpenAI-compatible provider, keep /v1 in the base URL, paste your key.',
        'After saving, send one short prompt to confirm chat/completions answers.',
        'Requests that go through the messages route must add max_tokens.'
      ]
    },
    {
      id: 'codex',
      name: 'Codex CLI',
      lead: 'Codex reads its key from ~/.codex/auth.json and its base URL from ~/.codex/config.toml.',
      kind: 'OpenAI-compatible · chat/completions · /v1',
      where: '~/.codex/config.toml + ~/.codex/auth.json · Windows: %USERPROFILE%\\.codex\\',
      install: 'npm install -g @openai/codex',
      fields: [
        ['Provider', 'OpenAI-compatible'],
        ['API key', KEY],
        ['Base URL', '{V1}'],
        ['Model', '{MODEL}'],
        ['Route', 'chat/completions']
      ],
      steps: [
        'Install the CLI, or the Codex extension from the VS Code Marketplace.',
        'Run codex once to confirm it starts.',
        'Write the two files below.',
        'Pick the model from the ones that are active in the price list.'
      ],
      snippets: [
        ['~/.codex/config.toml', `model = "{MODEL}"
model_reasoning_effort = "xhigh"
personality = "pragmatic"

openai_base_url = "{V1}"`],
        ['~/.codex/auth.json', `{
    "auth_mode": "apikey",
    "OPENAI_API_KEY": "${KEY}"
}`]
      ],
      notes: [
        'Base URL must include /v1.',
        'Reload VS Code after changing the extension settings.',
        'Test by opening a source file and asking it about that file.'
      ]
    },
    {
      id: 'droid',
      name: 'Factory Droid',
      lead: 'Droid takes custom models through a settings.json file.',
      kind: 'OpenAI-compatible · chat/completions · /v1',
      where: '~/.factory/settings.json · Windows: %USERPROFILE%\\.factory\\settings.json',
      install: 'macOS / Linux: curl -fsSL https://app.factory.ai/cli | sh\nWindows:  iwr -useb https://app.factory.ai/cli/install.ps1 | iex',
      fields: [
        ['Provider', 'openai'],
        ['API key', KEY],
        ['Base URL', '{V1}'],
        ['Model', '{MODEL}'],
        ['Route', 'chat/completions']
      ],
      snippets: [
        ['~/.factory/settings.json', `{
    "customModels": [
        {
            "model": "{MODEL}",
            "id": "custom:ckey-0",
            "index": 0,
            "baseUrl": "{V1}",
            "apiKey": "${KEY}",
            "displayName": "{MODEL}",
            "maxOutputTokens": 131072,
            "noImageSupport": false,
            "provider": "openai"
        }
    ]
}`]
      ],
      notes: [
        'Every entry in customModels needs a unique id and an increasing index (0, 1, 2 …).',
        'provider stays "openai" so Droid uses the OpenAI-compatible flow.',
        'Add more models by copying the object and changing model and id.'
      ]
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      lead: 'OpenCode registers a provider block; the sample below is the provider alias ckey.',
      kind: 'OpenAI-compatible · JSONC · /v1',
      where: '~/.config/opencode/opencode.json (or .jsonc) · Windows: %USERPROFILE%\\.config\\opencode\\',
      install: 'npm install -g opencode-ai',
      fields: [
        ['API key', KEY],
        ['Base URL', '{V1}'],
        ['Model', '{MODEL}'],
        ['Route', 'messages'],
        ['max_tokens', '1024']
      ],
      snippets: [
        ['~/.config/opencode/opencode.json', `{
    "$schema": "https://opencode.ai/config.json",
    "provider": {
        "ckey": {
            "npm": "@ai-sdk/openai-compatible",
            "options": {
                "baseURL": "{V1}",
                "apiKey": "${KEY}"
            },
            "models": {
                "{MODEL}": {
                    "name": "{MODEL}"
                }
            }
        }
    },
    "model": "ckey/{MODEL}"
}`]
      ],
      notes: [
        'Run opencode once to confirm the install.',
        'Models are addressed as ckey/<id> because the block above registers that alias.'
      ]
    },
    {
      id: 'openclaw',
      name: 'OpenClaw',
      lead: 'OpenClaw uses an OpenAI-compatible provider through openclaw.json, with the alias ckey.',
      kind: 'OpenAI-compatible · chat/completions · /v1',
      where: './openclaw.json in the project, or ~/.openclaw/openclaw.json',
      fields: [
        ['Provider', 'ckey / OpenAI-compatible'],
        ['API key', KEY],
        ['Base URL', '{V1}'],
        ['Model', 'ckey/{MODEL}'],
        ['Route', 'chat/completions']
      ],
      snippets: [
        ['openclaw.json', `{
    "agents": {
        "defaults": {
            "model": {
                "primary": "ckey/{MODEL}"
            }
        }
    },
    "models": {
        "providers": {
            "ckey": {
                "baseUrl": "{V1}",
                "apiKey": "${KEY}",
                "api": "openai-completions",
                "models": [
                    {
                        "id": "{MODEL}",
                        "name": "{MODEL}"
                    }
                ]
            }
        }
    }
}`]
      ],
      notes: [
        'Add a model to the models array before using it as a primary.',
        'Reference it as ckey/<id> — the bare id alone will not resolve.'
      ]
    }
  ];

  const state = {
    base: 'https://api.xah.io/v1',
    model: SUGGESTED[0],
    prices: new Map(),
    catalogue: false,
    tool: TOOLS[0].id
  };

  const els = {
    ruleGrid: $('#ruleGrid'),
    endpoints: $('#endpointRows'),
    modelPick: $('#modelPick'),
    modelPrice: $('#modelPrice'),
    modelGrid: $('#modelGrid'),
    toolNav: $('#toolNav'),
    tools: $('#tools')
  };

  function fill(text) {
    const root = state.base.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
    return String(text)
      .split('{V1}').join(state.base)
      .split('{ROOT}').join(root)
      .split('{MODEL}').join(state.model);
  }

  /* ------------------------------------------------------------------- rules */

  function renderRules() {
    els.ruleGrid.textContent = '';
    for (const [title, body] of RULES) {
      const card = document.createElement('div');
      card.className = 'rule';
      const head = document.createElement('b');
      head.textContent = title;
      const text = document.createElement('span');
      text.textContent = fill(body);
      card.append(head, text);
      els.ruleGrid.append(card);
    }
  }

  /* --------------------------------------------------------------- endpoints */

  function renderEndpoints() {
    els.endpoints.textContent = '';
    for (const [method, path, what, used] of ENDPOINTS) {
      const row = document.createElement('tr');
      const m = document.createElement('td');
      m.className = 'mono';
      m.textContent = method;
      const p = document.createElement('td');
      p.className = 'mono';
      p.textContent = path;
      const w = document.createElement('td');
      w.className = 'wrap';
      w.textContent = what;
      const u = document.createElement('td');
      if (used) {
        const pill = document.createElement('span');
        pill.className = 'pill ok';
        pill.textContent = used;
        u.append(pill);
      } else {
        u.textContent = '—';
      }
      row.append(m, p, w, u);
      els.endpoints.append(row);
    }
  }

  /* ----------------------------------------------------------------- models */

  function renderModels() {
    els.modelGrid.textContent = '';
    for (const id of SUGGESTED) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'model-chip';
      chip.dataset.model = id;
      chip.classList.toggle('is-on', id === state.model);
      const name = document.createElement('b');
      name.textContent = id;
      const cost = document.createElement('span');
      const price = state.prices.get(id);
      cost.textContent = price?.output ? vnd(price.output) + ' / 1M out' : 'not in the price book';
      chip.append(name, cost);
      els.modelGrid.append(chip);
    }
    if (els.modelPick.value !== state.model) els.modelPick.value = state.model;
    renderModelPrice();
  }

  function renderModelPrice() {
    const price = state.prices.get(state.model);
    if (!price) {
      els.modelPrice.textContent = state.catalogue
        ? `“${state.model}” is not in the live price book, so nothing can be quoted for it. The snippets still carry the id verbatim.`
        : 'Sign in and this line shows the provider’s list price for the model you picked.';
      return;
    }
    const bits = [];
    bits.push(price.input ? `in ${vnd(price.input)} / 1M` : 'no input price published');
    bits.push(price.output ? `out ${vnd(price.output)} / 1M` : 'no output price published');
    if (price.perRequest) bits.push(`${vnd(price.perRequest)} per request`);
    if (price.endpoints.length) bits.push(price.endpoints.join(' · '));
    els.modelPrice.textContent = bits.join('  ·  ');
  }

  /* ------------------------------------------------------------------ tools */

  function snippetBlock(label, code) {
    const box = document.createElement('div');
    box.className = 'snippet';
    const head = document.createElement('div');
    head.className = 'snippet-head';
    const title = document.createElement('span');
    title.textContent = label;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mini-btn';
    button.textContent = 'Copy';
    button.addEventListener('click', async () => {
      if (await copy(code)) flash(button, 'Copied');
      else flash(button, 'Select it');
    });
    head.append(title, button);
    const pre = document.createElement('pre');
    const inner = document.createElement('code');
    inner.textContent = code;
    pre.append(inner);
    box.append(head, pre);
    return box;
  }

  function renderTools() {
    els.tools.textContent = '';
    for (const tool of TOOLS) {
      const card = document.createElement('section');
      card.className = 'card tool';
      card.id = `tool-${tool.id}`;
      card.hidden = tool.id !== state.tool;

      const title = document.createElement('h2');
      title.textContent = tool.name;
      const kind = document.createElement('span');
      kind.className = 'pill dim tool-kind';
      kind.textContent = tool.kind;
      const head = document.createElement('div');
      head.className = 'tool-head';
      head.append(title, kind);

      const lead = document.createElement('p');
      lead.className = 'card-sub';
      lead.textContent = tool.lead;

      card.append(head, lead);

      if (tool.where) {
        const where = document.createElement('p');
        where.className = 'tool-where';
        const label = document.createElement('b');
        label.textContent = 'Config lives at ';
        const value = document.createElement('code');
        value.textContent = tool.where;
        where.append(label, value);
        card.append(where);
      }

      if (tool.install) {
        card.append(snippetBlock('Install', tool.install));
      }

      const fields = document.createElement('dl');
      fields.className = 'kv';
      for (const [key, value] of tool.fields) {
        const dt = document.createElement('dt');
        dt.textContent = key;
        const dd = document.createElement('dd');
        dd.textContent = fill(value);
        fields.append(dt, dd);
      }
      card.append(fields);

      if (tool.steps) {
        const ol = document.createElement('ol');
        ol.className = 'steps';
        for (const step of tool.steps) {
          const li = document.createElement('li');
          li.textContent = step;
          ol.append(li);
        }
        card.append(ol);
      }

      for (const [label, code] of tool.snippets) card.append(snippetBlock(label, fill(code)));

      if (tool.notes) {
        const ul = document.createElement('ul');
        ul.className = 'notes';
        for (const note of tool.notes) {
          const li = document.createElement('li');
          li.textContent = note;
          ul.append(li);
        }
        card.append(ul);
      }

      els.tools.append(card);
    }
  }

  function renderToolNav() {
    els.toolNav.textContent = '';
    for (const tool of TOOLS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sp-tab';
      button.textContent = tool.name;
      button.classList.toggle('is-on', tool.id === state.tool);
      button.setAttribute('aria-selected', String(tool.id === state.tool));
      button.addEventListener('click', () => {
        state.tool = tool.id;
        renderToolNav();
        for (const card of $$('.tool', els.tools)) card.hidden = card.id !== `tool-${tool.id}`;
      });
      els.toolNav.append(button);
    }
  }

  function setModel(id, fromField) {
    const next = String(id || '').trim();
    if (!next) return;
    state.model = next;
    if (!fromField) els.modelPick.value = next;
    renderRules();
    renderModels();
    renderTools();
  }

  els.modelGrid.addEventListener('click', (event) => {
    const chip = event.target.closest('.model-chip');
    if (chip) setModel(chip.dataset.model);
  });

  // The field is free text on purpose: the catalogue has 500+ ids and namespaced
  // ones (account/model) are the ones that fail most quietly in a tool config.
  els.modelPick.addEventListener('change', () => setModel(els.modelPick.value, true));
  els.modelPick.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      setModel(els.modelPick.value, true);
    }
  });

  /* ------------------------------------------------------------------- load */

  async function loadPrices() {
    const res = await window.Auth.api('/api/pricing');
    if (!res.ok) return;
    for (const model of res.data.models || []) {
      state.prices.set(model.id, {
        input: model.input,
        output: model.output,
        perRequest: model.perRequest,
        endpoints: model.endpoints || []
      });
    }
    state.catalogue = Boolean(res.data.models?.length);
    renderModels();
  }

  async function loadBase() {
    const res = await window.Auth.api('/api/health');
    if (!res.ok || !res.data?.base) return;
    state.base = String(res.data.base).replace(/\/+$/, '');
    if (res.data.defaultModel) state.model = res.data.defaultModel;
    renderRules();
    renderModels();
    renderTools();
  }

  async function boot() {
    initTheme($('#themeBtn'));
    renderRules();
    renderEndpoints();
    renderModels();
    renderTools();
    renderToolNav();

    const user = await window.Auth.boot();
    initNav(user);
    await loadBase();
    await loadPrices();
  }

  boot();
})();
