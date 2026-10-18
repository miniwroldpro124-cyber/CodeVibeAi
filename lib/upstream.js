import { request as httpsRequest } from 'node:https';

const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);

export const PASSTHROUGH_PARAMS = [
  'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'stop', 'seed',
  'presence_penalty', 'frequency_penalty', 'response_format', 'tools', 'tool_choice',
  'stream_options', 'reasoning', 'thinking'
];

export function isValidMessage(message) {
  if (!message || typeof message !== 'object') return false;
  if (!ROLES.has(message.role)) return false;
  return typeof message.content === 'string' || Array.isArray(message.content);
}

// Only known chat fields are forwarded, so this proxy cannot be reused as an
// open relay to the rest of the upstream API with the caller's key.
export function buildUpstreamBody(payload, defaultModel) {
  const body = {
    model: typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : defaultModel,
    messages: (payload.messages || []).filter(isValidMessage).map((m) => ({ role: m.role, content: m.content })),
    stream: payload.stream !== false
  };
  for (const key of PASSTHROUGH_PARAMS) {
    if (payload[key] !== undefined) body[key] = payload[key];
  }
  // The final SSE chunk carries usage, which is where the provider's real
  // charge in dong lives. Without this the bill is invisible.
  if (body.stream && !body.stream_options) body.stream_options = { include_usage: true };
  return body;
}

// Relays the stream while reading it, so usage can be logged without buffering
// a long answer in memory.
function createUsageTap() {
  let buffer = '';
  let usage = null;
  return {
    push(chunk) {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed && parsed.usage) usage = parsed.usage;
        } catch {
          /* a keep-alive or partial frame; nothing to record */
        }
      }
    },
    get usage() {
      return usage;
    }
  };
}

export function extractCost(usage) {
  if (!usage) return 0;
  const cost = usage?.x_ckey?.cost;
  const n = Number(cost !== undefined ? cost : usage.cost);
  return Number.isFinite(n) ? n : 0;
}

export function extractTokens(usage) {
  return {
    promptTokens: Number(usage?.prompt_tokens) || 0,
    completionTokens: Number(usage?.completion_tokens) || 0,
    totalTokens: Number(usage?.total_tokens) || 0
  };
}

function readUpstreamError(upstreamRes) {
  return new Promise((resolve) => {
    let text = '';
    upstreamRes.setEncoding('utf8');
    upstreamRes.on('data', (chunk) => {
      if (text.length < 20000) text += chunk;
    });
    upstreamRes.on('end', () => resolve(text));
    upstreamRes.on('error', () => resolve(text));
  });
}

export function describeUpstreamError(status, text) {
  let message = text || `Upstream returned ${status}`;
  try {
    const parsed = JSON.parse(text);
    message = parsed?.error?.message || parsed?.message || message;
  } catch {
    /* not JSON; the raw text is the best we have */
  }
  if (status === 401 || status === 403) {
    return 'Your API key was rejected by the provider. Check that it is still valid, then save it again in Settings.';
  }
  if (status === 402 || status === 429) {
    return `The provider refused this request (HTTP ${status}): ${message.slice(0, 300)}`;
  }
  return String(message).slice(0, 2000);
}

/**
 * Streams a chat completion to res using the caller's own key.
 * onResult is always called exactly once, including on abort, and may be async:
 * the returned promise resolves once it has settled, because a serverless
 * function is frozen the moment the response ends and a usage write still in
 * flight would be lost.
 */
export function proxyChat({ apiKey, base, body, req, res, onResult }) {
  const startedAt = Date.now();
  const target = new URL(`${base}/chat/completions`);
  let settled = false;
  const tap = createUsageTap();
  let reportDone;
  const reported = new Promise((resolve) => {
    reportDone = resolve;
  });

  const finish = (result) => {
    if (settled) return;
    settled = true;
    Promise.resolve()
      .then(() => onResult({ ms: Date.now() - startedAt, usage: tap.usage, ...result }))
      .catch((err) => console.error('[usage] failed to record request:', err))
      .then(() => reportDone());
  };

  const upstream = httpsRequest(
    {
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname + target.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: body.stream ? 'text/event-stream' : 'application/json',
        Authorization: `Bearer ${apiKey}`
      }
    },
    async (upstreamRes) => {
      if (upstreamRes.statusCode !== 200) {
        const text = await readUpstreamError(upstreamRes);
        const message = describeUpstreamError(upstreamRes.statusCode, text);
        if (!res.headersSent) {
          const payload = Buffer.from(JSON.stringify({ error: message }));
          res.writeHead(upstreamRes.statusCode || 502, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': payload.length,
            'Cache-Control': 'no-store'
          });
          res.end(payload);
        } else {
          res.write(`data: ${JSON.stringify({ error: { message } })}\n\n`);
          res.end();
        }
        finish({ ok: false, status: upstreamRes.statusCode || 502, error: message });
        return;
      }

      if (body.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
      } else {
        res.writeHead(200, {
          'Content-Type': upstreamRes.headers['content-type'] || 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        });
      }

      upstreamRes.on('data', (chunk) => {
        tap.push(chunk);
        // Honour backpressure: a slow client must not turn into unbounded memory.
        if (!res.write(chunk)) upstreamRes.pause();
      });
      res.on('drain', () => upstreamRes.resume());
      upstreamRes.on('end', () => {
        if (!res.writableEnded) res.end();
        finish({ ok: true, status: 200 });
      });
      upstreamRes.on('error', (err) => {
        if (!res.writableEnded) res.end();
        finish({ ok: false, status: 200, error: `Stream interrupted: ${err.message}` });
      });
      upstreamRes.on('aborted', () => {
        if (!res.writableEnded) res.end();
        finish({ ok: false, status: 200, error: 'Upstream closed the stream early', aborted: true });
      });
    }
  );

  upstream.on('error', (err) => {
    const message = `Cannot reach ${target.hostname}: ${err.message}`;
    if (!res.headersSent) {
      const payload = Buffer.from(JSON.stringify({ error: message }));
      res.writeHead(502, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': payload.length,
        'Cache-Control': 'no-store'
      });
      res.end(payload);
    } else if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: { message } })}\n\n`);
      res.end();
    }
    finish({ ok: false, status: 502, error: message });
  });

  // Stop button or closed tab: cut the upstream request so tokens stop burning,
  // but still log whatever usage already arrived. "settled" is checked as well as
  // writableEnded because a serverless response object does not always report the
  // end it already wrote — and its request socket closes on every normal reply.
  const onClose = () => {
    upstream.destroy();
    if (!res.writableEnded) res.end();
    finish({ ok: false, status: 0, error: 'Cancelled by client', aborted: true });
  };
  req.on('close', () => {
    if (!res.writableEnded && !settled) onClose();
  });
  req.on('aborted', onClose);

  upstream.end(JSON.stringify(body));
  return reported;
}

// The catalogue (and therefore the price list) is public upstream, so no key is
// needed here; one is only attached when the caller has one.
export async function fetchModels(apiKey, base, timeoutMs = 30000) {
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(`${base}/models`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* fall through to the error branch with the raw text */
  }
  if (!response.ok) {
    const message = data?.error?.message || data?.message || text.slice(0, 500) || `HTTP ${response.status}`;
    return { ok: false, status: response.status, error: describeUpstreamError(response.status, text) || message };
  }
  return { ok: true, status: response.status, data };
}

/**
 * Proves a key actually works by spending the smallest possible request on it.
 * /v1/models is public upstream and answers 200 for garbage keys, so it cannot
 * be used to validate anything. A 1-token completion costs the provider's
 * per-request minimum (a few dong) and is charged to the user's own key.
 */
export async function verifyApiKey({ apiKey, base, model, timeoutMs = 30000 }) {
  let response;
  try {
    response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
        max_tokens: 1
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    return { ok: false, status: 0, error: `Cannot reach the provider: ${err.message}` };
  }

  const text = await response.text();
  if (response.status === 200) return { ok: true, status: 200 };

  let message = text.slice(0, 500);
  try {
    const parsed = JSON.parse(text);
    message = parsed?.error?.message || parsed?.message || message;
  } catch {
    /* keep the raw text */
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, status: response.status, error: 'The provider rejected this key. It is invalid, expired or revoked.' };
  }
  // These prove the key authenticated; only the account or the model is the problem.
  if (response.status === 402) {
    return { ok: true, status: 402, warning: 'The key is valid, but the provider reports no credit left on it.' };
  }
  if (response.status === 429) {
    return { ok: true, status: 429, warning: 'The key is valid, but the provider is rate-limiting it right now.' };
  }
  if (/model/i.test(message)) {
    return { ok: true, status: response.status, warning: `The key works, but "${model}" was refused: ${message.slice(0, 200)}` };
  }
  return { ok: false, status: response.status, error: message.slice(0, 300) };
}
