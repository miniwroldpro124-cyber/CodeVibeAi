const PRICE_TTL_MS = 60 * 60 * 1000;

// Measured against the live provider: a 6-token request and a 156-token request
// on deepseek-v4.1-flash were both charged 2.02 dong, even though that model
// advertises no min_charge_per_request. Treating the floor as zero makes the
// calculator under-quote small requests by 100x, so apply the observed floor.
export const OBSERVED_MIN_CHARGE = 2.02;

let book = { at: 0, unit: 'VND', models: new Map() };

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// The upstream /models payload carries the provider's own price list
// (VND per 1M tokens), so the calculator quotes real ckey.vn rates instead of
// a hand-maintained table that would silently go stale.
//
// Two shapes arrive in the same list. Chat models price per 1M tokens; image
// models price per_request — one picture, one number, no tokens. The `endpoints`
// array is what tells them apart, and only the models that can do something
// other than chat carry it at all.
export function ingestModels(payload) {
  const list = Array.isArray(payload?.data) ? payload.data : [];
  if (!list.length) return book;

  const models = new Map();
  for (const m of list) {
    if (!m || typeof m.id !== 'string') continue;
    const pr = m.pricing || {};
    models.set(m.id, {
      id: m.id,
      ownedBy: m.owned_by || '',
      context: num(m.context) || 0,
      input: num(pr.input ?? pr.prompt) || 0,
      output: num(pr.output ?? pr.completion) || 0,
      cacheRead: num(pr.cache_read),
      cacheWrite: num(pr.cache_write),
      min: num(pr.min_charge_per_request) || 0,
      perRequest: num(pr.per_request),
      endpoints: Array.isArray(m.endpoints) ? m.endpoints.filter((e) => typeof e === 'string') : [],
      unit: typeof pr.unit === 'string' && pr.unit ? pr.unit : 'VND'
    });
  }
  if (!models.size) return book;

  book = { at: Date.now(), unit: 'VND', models };
  return book;
}

export function priceBookFresh() {
  return Boolean(book.models.size) && Date.now() - book.at < PRICE_TTL_MS;
}

export function getPrice(modelId) {
  return book.models.get(String(modelId || '')) || null;
}

export function priceBookSize() {
  return book.models.size;
}

export function listPriceBook() {
  return [...book.models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// Which models the provider itself says can do a non-chat thing, read from the
// endpoints array rather than guessed at from the name. Video models carry no
// entry in the catalogue at all, so they come from configuration instead.
export function listCapable(endpoint) {
  return [...book.models.values()]
    .filter((m) => m.endpoints.includes(endpoint))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function applyMarkup(cost, markupPercent) {
  const rate = 1 + (Number(markupPercent) || 0) / 100;
  return Math.round((Number(cost) || 0) * rate * 1e6) / 1e6;
}

// The provider floors small requests, so a 3-token prompt still costs its
// minimum. Mirroring that floor is what makes the calculator agree with the bill.
export function estimateCost({ modelId, promptTokens, completionTokens, markupPercent = 0 }) {
  const price = getPrice(modelId);
  const input = Number(promptTokens) || 0;
  const output = Number(completionTokens) || 0;
  if (!price) {
    return { known: false, base: 0, marked: 0, min: 0, appliedMin: false, input, output };
  }
  // A per-request model quotes the whole picture, so tokens are not the price and
  // the token floor measured on chat does not apply to it either.
  const perRequest = price.perRequest;
  const byToken = (input / 1e6) * price.input + (output / 1e6) * price.output;
  const raw = perRequest !== null ? perRequest : byToken;
  const floor = perRequest !== null ? perRequest : Math.max(price.min || 0, OBSERVED_MIN_CHARGE);
  const appliedMin = raw < floor;
  const afterMin = appliedMin ? floor : raw;
  return {
    known: true,
    base: Math.round(afterMin * 1e6) / 1e6,
    marked: applyMarkup(afterMin, markupPercent),
    min: floor,
    advertisedMin: price.min || 0,
    rawCost: Math.round(raw * 1e6) / 1e6,
    appliedMin,
    kind: perRequest !== null ? 'per_request' : 'token',
    perRequest,
    input,
    output,
    inputPrice: price.input,
    outputPrice: price.output,
    unit: price.unit
  };
}
