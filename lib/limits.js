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

  // What an account has spent, measured against what the provider charged.
  //
  // The number a budget is checked against has to be the number the user's wallet
  // actually paid, so this reads usage_log's real cost (`actual_cost`) and falls
  // back to the list-price quote (`estimate_cost`) only for the requests the
  // provider reported nothing about. The simulated margin is not in here: it is an
  // admin what-if, and spending a budget against it would stop a chat that costs
  // the provider nothing.
  //
  // Both the hard stop and the account panel call this one function, so a warning
  // can never disagree with the wall it is warning about.
  //
  // The chat subtotal costs a second indexed read, so the hot path only asks for it
  // when a per-chat ceiling has to be compared against it. Pass wantChat from a
  // panel read, where showing "this chat so far" is worth the extra round trip.
  async function spendState(user, conversation = null, wantChat = false) {
    const systemDaily = knob('DAILY_BUDGET_DONG', 200_000);
    const requests = knob('DAILY_BUDGET_REQUESTS', 5000);
    // A user may only lower the ceiling. An account that asks for more than the
    // operator's number is clamped to it rather than trusted.
    const chosen = Number(user.daily_budget_vnd);
    const daily = Number.isFinite(chosen) && chosen > 0 ? Math.min(systemDaily, chosen) : systemDaily;
    const chat = Number(user.chat_budget_vnd);
    const chatCeiling = Number.isFinite(chat) && chat > 0 ? chat : null;
    let day;
    let inChat;
    try {
      day = await store.spendSince(user.id, Date.now() - 24 * 60 * 60 * 1000);
      inChat = conversation && (chatCeiling || wantChat) ? await store.spendSince(user.id, 0, conversation) : null;
    } catch (err) {
      // Fails open like the durable windows do: a database that cannot be read is
      // already its own outage, and the per-minute rate still holds this instance.
      console.error('[limits] spending check skipped:', err.message);
      return null;
    }
    const warnAt = (Number(process.env.BUDGET_WARN_PERCENT) || 80) / 100;
    return {
      daily,
      systemDaily,
      chosenDaily: Number.isFinite(chosen) && chosen > 0 ? chosen : null,
      requests,
      spent: day.spent,
      used: day.requests,
      remaining: Math.max(0, Math.round((daily - day.spent) * 100) / 100),
      nearLimit: day.spent >= daily * warnAt,
      chatCeiling,
      chatSpent: inChat ? inChat.spent : 0,
      chatRequests: inChat ? inChat.requests : 0,
      conversation: conversation || null
    };
  }

  // The rate part of the account ceiling, run before a route reads its body. A
  // refused flood should not make the server pull four megabytes of pasted code off
  // the wire first, and these two checks cost no database read at all.
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
    return windowHit(`expensive:${rate}`, 'expensive', ip, 'paid requests from this account');
  }

  // The money part of the account ceiling, run once a route knows what it is being
  // asked to spend. usage_log already holds a row for every chat, picture and video
  // an account ran, so the budget is one indexed read and nothing new has to be
  // written to keep it true.
  //
  // Pass the conversation id and one chat gets its own ceiling on top of the
  // account's, which is what makes a runaway thread stop itself.
  //
  // Returns the same numbers it checked, so the caller can warn without a second
  // read; null when the ledger could not be read, in which case the request goes
  // through rather than turning a database outage into an outage of the chat.
  async function budget(user, ip, conversation = null) {
    const s = await spendState(user, conversation);
    if (!s) return null;
    if (s.chatCeiling && s.chatSpent >= s.chatCeiling) {
      await refuse({
        bucket: `user:${user.id}:chat:${conversation}`,
        ip,
        reason: `${s.chatSpent.toFixed(2)} of ${s.chatCeiling} VND in this conversation`,
        retryAfter: 3600,
        message:
          `This conversation has reached its ${s.chatCeiling.toLocaleString('vi-VN')} ₫ budget. ` +
          'Start a new chat, or raise the limit in your account settings.'
      });
    }
    if (s.spent >= s.daily) {
      const shown = s.chosenDaily && s.chosenDaily < s.systemDaily ? s.chosenDaily : s.systemDaily;
      await refuse({
        bucket: `user:${user.id}:budget`,
        ip,
        reason: `${s.spent.toFixed(2)} of ${shown} VND/day`,
        retryAfter: 3600,
        message:
          `Your key has been charged ${s.spent.toLocaleString('vi-VN')} ₫ in the last 24 hours, against the ` +
          `${shown.toLocaleString('vi-VN')} ₫ limit in force. It frees up as those requests age out.`
      });
    }
    if (s.used >= s.requests) {
      await refuse({
        bucket: `user:${user.id}:count`,
        ip,
        reason: `${s.used} of ${s.requests} requests/day`,
        retryAfter: 3600,
        message: `This account has sent its ${s.requests} requests for the day. Try again tomorrow.`
      });
    }
    return s;
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
    budget,
    spendState,
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
        dailyRequests: knob('DAILY_BUDGET_REQUESTS', 5000),
        // What a budget is measured against. The platform collects nothing on a
        // bring-your-own-key request, so the only honest number is the one the
        // provider put on the bill.
        budgetBasis: 'provider cost'
      };
    }
  };
}
