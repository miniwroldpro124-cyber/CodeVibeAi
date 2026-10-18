import { HttpError, clientIp, rateLimit } from './http.js';

// Two layers, because they answer for different things.
//
//   * In-process buckets and in-flight counters stop the instance that is serving
//     this request from being run over by it. On Vercel that is one warm container's
//     share of the traffic, nothing more.
//   * The window counters and the spending budget live in the database, so they hold
//     across cold starts and add up over every instance at once. They cover the
//     routes that cost something: signing in, and the three that spend the
//     provider's money.
//
// Neither layer is a substitute for edge protection. A botnet sending 200 000
// requests a second is stopped by the platform, not by code that only ever sees
// what the platform let through — README → "Anti-abuse" lists what to turn on there.

// Env knobs, so an operator can retune a ceiling without a code change. Every one
// is a floor under normal use, not a target: the defaults are set from what a busy
// human session actually sends.
function knob(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Fixed windows for the durable counters, keyed by tier.
const TIERS = {
  auth: { seconds: () => knob('AUTH_WINDOW_SECONDS', 900), max: () => knob('AUTH_WINDOW_MAX', 100) },
  expensive: { seconds: () => knob('WINDOW_SECONDS', 300), max: () => knob('WINDOW_MAX', 150) }
};

export function createLimits({ store }) {
  const running = { stream: new Map(), media: new Map() };
  const totals = { stream: 0, media: 0 };

  // Always throws: the caller never has to remember to check a return value, and a
  // forgotten `if` cannot turn into an ungated route.
  async function refuse({ bucket, ip, reason, retryAfter, message }) {
    // One audit row per bucket per five minutes. Without the suppression every
    // rejected request of a flood buys a database write, and the defence becomes
    // the attack.
    if (rateLimit(`audit:${bucket}`, 1, knob('THROTTLE_AUDIT_MS', 300_000)).ok) {
      try {
        await store.logAuthEvent({
          username: null,
          kind: 'throttled',
          ip,
          detail: `${reason} — ${message}`.slice(0, 240)
        });
      } catch (err) {
        console.error('[limits] could not record a refused request:', err.message);
      }
    }
    const err = new HttpError(429, message);
    err.retryAfter = Math.max(1, Math.ceil(retryAfter));
    throw err;
  }

  // ------------------------------------------------------------ before routing

  // The cheapest possible gate, run before a request can reach a handler, the
  // database or the provider. It covers every /api/* path, including ones that do
  // not exist: a scanner walking the routes still spends from this bucket.
  function perMinute(req) {
    const ip = clientIp(req);
    const limit = knob('MAX_REQUESTS_PER_MINUTE', 300);
    const bucket = rateLimit(`ip:${ip}`, limit, 60_000);
    if (bucket.ok) return;
    return refuse({
      bucket: `ip:${ip}`,
      ip,
      reason: `over ${limit}/min`,
      retryAfter: bucket.retryAfter,
      message: `Too many requests from this address. Try again in ${bucket.retryAfter}s.`
    });
  }

  // ------------------------------------------------------------- durable windows

  async function windowHit(key, tier, ip, what) {
    const seconds = TIERS[tier].seconds();
    const max = TIERS[tier].max();
    const size = seconds * 1000;
    const now = Date.now();
    let row;
    try {
      // One round trip: the counter is written and read back by the same statement.
      row = await store.bumpWindow(key, Math.floor(now / size) * size, size);
    } catch (err) {
      // Deliberately fails open. A database that cannot be reached is already its
      // own outage, the in-process buckets still hold this instance, and turning a
      // counter failure into "nobody can chat" would be the worse bug.
      console.error('[limits] durable window unavailable:', err.message);
      return;
    }
    if (!row || row.hits <= max) return;
    const wait = Math.max(1, Math.ceil((row.window_start + row.window_ms - now) / 1000));
    await refuse({
      bucket: key,
      ip,
      reason: `${key} ${row.hits}/${max} per ${seconds}s`,
      retryAfter: wait,
      message: `Too many ${what}. Wait ${wait}s.`
    });
  }

  // Called once a route has matched, with the tier that route was declared in.
  function guarded(req, tier) {
    if (!tier) return Promise.resolve();
    const ip = clientIp(req);
    const limit = tier === 'auth'
      ? knob('MAX_AUTH_PER_IP_MINUTE', 40)
      : knob('MAX_EXPENSIVE_PER_IP_MINUTE', 60);
    // The tier is part of the key on purpose. One address can be inside a signing-in
    // window and a paid-request window at the same time with different budgets, and
    // sharing a row between them would let the cheaper one spend the dearer one's.
    const bucket = `${tier}:ip:${ip}`;
    const bucketRate = rateLimit(bucket, limit, 60_000);
    if (!bucketRate.ok) {
      return refuse({
        bucket,
        ip,
        reason: `over ${limit}/min on ${tier}`,
        retryAfter: bucketRate.retryAfter,
        message: `Too many of these requests from this address. Try again in ${bucketRate.retryAfter}s.`
      });
    }
    return windowHit(bucket, tier, ip, tier === 'auth' ? 'sign-in attempts from this address' : 'paid requests from this address');
  }

  // ------------------------------------------------------------- per account

  // The account ceiling for the routes that cost the provider money: an in-process
  // rate, a durable rate, and the last 24 hours of the spending ledger. usage_log
  // already holds a row for every chat, picture and video an account ran, so the
  // budget is one indexed read and nothing new has to be written to keep it true.
  async function account(user, ip) {
    const rate = `user:${user.id}`;
    const perMinute = rateLimit(rate, knob('MAX_PER_USER_MINUTE', 40), 60_000);
    if (!perMinute.ok) {
      await refuse({
        bucket: rate,
        ip,
        reason: 'over the per-minute request rate',
        retryAfter: perMinute.retryAfter,
        message: `You are sending too fast. Try again in ${perMinute.retryAfter}s.`
      });
    }
    await windowHit(`expensive:${rate}`, 'expensive', ip, 'paid requests from this account');

    const dong = knob('DAILY_BUDGET_DONG', 200_000);
    const requests = knob('DAILY_BUDGET_REQUESTS', 5000);
    let spend;
    try {
      spend = await store.spendSince(user.id, Date.now() - 24 * 60 * 60 * 1000);
    } catch (err) {
      console.error('[limits] spending check skipped:', err.message);
      return;
    }
    if (spend.billed >= dong) {
      await refuse({
        bucket: `${rate}:budget`,
        ip,
        reason: `${spend.billed.toFixed(2)} of ${dong} VND/day`,
        retryAfter: 3600,
        message: `This account has used its ${dong.toLocaleString('vi-VN')} ₫ daily limit. It resets within 24 hours.`
      });
    }
    if (spend.requests >= requests) {
      await refuse({
        bucket: `${rate}:count`,
        ip,
        reason: `${spend.requests} of ${requests} requests/day`,
        retryAfter: 3600,
        message: `This account has sent its ${requests} requests for the day. Try again tomorrow.`
      });
    }
  }

  // --------------------------------------------------------------- in flight

  // A stream costs the most: one chat answer can hold the function and a provider
  // connection for five minutes. The slot is held for exactly as long as the
  // upstream call, so every caller takes it inside try/finally.
  async function enter(kind, userId, ip) {
    const perUser = kind === 'media' ? knob('MAX_MEDIA_PER_USER', 2) : knob('MAX_STREAMS_PER_USER', 3);
    const total = kind === 'media' ? knob('MAX_MEDIA_TOTAL', 4) : knob('MAX_STREAMS_TOTAL', 12);
    const mine = running[kind].get(userId) || 0;
    if (mine >= perUser) {
      throw new HttpError(
        429,
        kind === 'media'
          ? 'One generation is already running on your account. Wait for it to finish.'
          : 'You already have the most answers this account may stream at once. Wait for one to finish.'
      );
    }
    if (totals[kind] >= total) {
      await refuse({
        bucket: `saturation:${kind}`,
        ip,
        reason: `${totals[kind]}/${total} ${kind} slots busy`,
        retryAfter: 5,
        message: 'This server is relaying as many requests as it allows at once. Try again in a few seconds.'
      });
    }
    running[kind].set(userId, mine + 1);
    totals[kind] += 1;
    let open = true;
    return () => {
      // Idempotent: a release called twice would under-count and let the cap drift
      // upward for the rest of this instance's life.
      if (!open) return;
      open = false;
      const left = (running[kind].get(userId) || 1) - 1;
      if (left > 0) running[kind].set(userId, left);
      else running[kind].delete(userId);
      totals[kind] = Math.max(0, totals[kind] - 1);
    };
  }

  return {
    perMinute,
    guarded,
    account,
    enter,
    snapshot() {
      return {
        streams: totals.stream,
        media: totals.media,
        maxStreams: knob('MAX_STREAMS_TOTAL', 12),
        maxMedia: knob('MAX_MEDIA_TOTAL', 4),
        windowSeconds: TIERS.expensive.seconds(),
        windowMax: TIERS.expensive.max(),
        dailyBudgetDong: knob('DAILY_BUDGET_DONG', 200_000),
        dailyRequests: knob('DAILY_BUDGET_REQUESTS', 5000)
      };
    }
  };
}
