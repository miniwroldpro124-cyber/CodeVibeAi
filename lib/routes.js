import { randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError, sendJson, sendBytes, readJson, setCookies, clientIp, rateLimit, clearIdleTimeout } from './http.js';
import {
  hashPassword, verifyPassword, newSessionToken, hashToken, parseCookies, sessionCookie,
  bearerToken, encryptApiKey, decryptApiKey, maskKey, looksLikeApiKey, encryptSecret, decryptSecret
} from './auth.js';
import { applyCors, handlePreflight, isCrossOrigin, originAllowed } from './cors.js';
import { SESSION_TTL_MS } from './db.js';
import {
  accountKey, assertUnlocked, noteFailure, noteSuccess, nextAttemptWarning,
  passwordProblem, lockedMessage, unlockAccount, ADMIN_SESSION_TTL_MS,
  ADMIN_MIN_PASSWORD, USER_MIN_PASSWORD, GUARD_POLICY
} from './guard.js';
import {
  buildUpstreamBody, buildImageBody, buildEditBody, buildSpeechBody, buildVideoBody, isValidMessage,
  proxyChat, fetchModels, verifyApiKey, extractCost, extractTokens, normalizeImages, normalizeChatPictures,
  normalizeVideoTask, requestUpstreamJson, requestUpstreamBinary, v2Base
} from './upstream.js';
import {
  applyMarkup, estimateCost, ingestModels, listCapable, listPriceBook, priceBookFresh, priceBookSize,
  getPrice, OBSERVED_MIN_CHARGE
} from './pricing.js';
import { pictureCeilingDong, videoModels } from './env.js';
import { createLimits } from './limits.js';
import {
  appUrl, authorizeUrl, exchange, oauthReady, pkceChallenge, providerIds, randomToken
} from './oauth.js';

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const MODELS_TTL_MS = 10 * 60 * 1000;

// The handshake lives in a sealed cookie rather than in memory: on Vercel the
// request that starts it and the one that finishes it are usually different
// instances, and a database table for a value that must expire in minutes is the
// wrong tool.
const OAUTH_STATE_COOKIE = 'devchat_oauth_state';
const OAUTH_STATE_TTL_S = 10 * 60;

// Media burns the caller's credit one picture at a time and holds the request open
// for tens of seconds, so it gets a tighter gate than chat. Best effort: a
// serverless instance counts its own traffic only.
const IMAGE_LIMIT = { max: 20, windowMs: 60 * 1000 };
const VIDEO_LIMIT = { max: 6, windowMs: 60 * 1000 };
// An edit is one picture turn on a vision model and a clip of speech is one file,
// so both are gated like the picture route rather than like chat.
const EDIT_LIMIT = { max: 20, windowMs: 60 * 1000 };
const SPEECH_LIMIT = { max: 20, windowMs: 60 * 1000 };

// The only guard reports the server will store, so the audit list cannot be
// filled with arbitrary text by a crafted client.
const GUARD_EVENT_KINDS = new Set(['devtools_open', 'automation_detected', 'guard_removed']);
const GUARD_EVENT_DEDUPE_MS = 60 * 1000;
const COOKIE_NAME = 'devchat_session';

// A throwaway hash so a login attempt against an unknown username costs the
// same time as a real one, and the response cannot be used to enumerate users.
let dummy = null;
function dummyVerify(password) {
  if (!dummy) dummy = hashPassword('dummy-password-for-timing');
  verifyPassword(password, dummy.passHash, dummy.passSalt);
}

export function createApi({ store, env }) {
  const limits = createLimits({ store });
  let modelsCache = { at: 0, data: null };

  function publicUser(user) {
    if (!user) return null;
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      hasKey: Boolean(user.api_key_enc || user.apiKeyEnc),
      apiKeyHint: user.api_key_hint || user.apiKeyHint || null,
      createdAt: user.created_at || null,
      lastSeenAt: user.last_seen_at || null
    };
  }

  async function sessionUser(req) {
    const token = bearerToken(req) || parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!token) return null;
    const row = await store.getSession(hashToken(token));
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      role: row.role,
      status: row.status,
      api_key_enc: row.api_key_enc,
      api_key_hint: row.api_key_hint,
      created_at: row.user_created_at,
      last_seen_at: row.last_seen_at,
      token,
      tokenHash: row.token_hash,
      tokenIssuedAt: row.session_created_at
    };
  }

  async function requireUser(req) {
    const user = await sessionUser(req);
    if (!user) throw new HttpError(401, 'Not signed in');
    if (user.status !== 'active') throw new HttpError(403, 'This account has been disabled.');
    return user;
  }

  async function requireAdmin(req) {
    const user = await requireUser(req);
    if (user.role !== 'admin') throw new HttpError(403, 'Administrator access required');
    return user;
  }

  // The plaintext key is decrypted only for the duration of one upstream call
  // and never leaves the server.
  function requireApiKey(user) {
    if (!user.api_key_enc) {
      throw new HttpError(428, 'Add your sk- API key in Settings before sending a message.');
    }
    try {
      return decryptApiKey(user.api_key_enc);
    } catch {
      throw new HttpError(500, 'Your stored API key could not be decrypted. Please save it again in Settings.');
    }
  }

  // Returns the fragment the caller spreads into its response body. Across
  // origins a cookie set here would be third-party storage, which Safari drops
  // outright, so the token is handed to the browser in JSON and sent back as
  // Authorization. Same-origin keeps the HttpOnly cookie and never exposes it.
  async function beginSession(req, res, user, forceToken = false) {
    const token = newSessionToken();
    // An admin cookie can edit users, roles and pricing, so it dies in hours
    // rather than the 30 days a normal session gets.
    const ttl = user.role === 'admin' ? ADMIN_SESSION_TTL_MS : SESSION_TTL_MS;
    await store.createSession(hashToken(token), user.id, ttl);
    if (isCrossOrigin(req) || forceToken) return { token };
    setCookies(res, sessionCookie(token, ttl / 1000));
    return {};
  }

  function adminReauthMode() {
    const raw = String(process.env.ADMIN_REAUTH || 'sensitive').trim().toLowerCase();
    if (['off', '0', 'false', 'no'].includes(raw)) return 'off';
    if (raw === 'always') return 'always';
    return 'sensitive';
  }

  function adminReauthWindowMs() {
    const n = Number(process.env.ADMIN_REAUTH_MINUTES);
    return Math.min(240, Math.max(1, Number.isFinite(n) ? n : 10)) * 60 * 1000;
  }

  // Step-up confirmation: pricing is the day-to-day control, so it stays free by
  // default, while anything that changes accounts or roles asks for the admin
  // password again unless the browser signed in (or confirmed) recently.
  async function stepUp(req, admin, group, body) {
    const mode = adminReauthMode();
    if (mode === 'off') return;
    if (mode === 'sensitive' && group === 'pricing') return;

    const since = Date.now() - adminReauthWindowMs();
    const lastEvent = await store.lastAuthEventAt(admin.username, ['login_ok', 'password_change', 'admin_reauth']);
    if ((admin.tokenIssuedAt >= since || lastEvent >= since) && !body.confirmPassword) return;

    const password = String(body.confirmPassword || '');
    if (!password) {
      throw new HttpError(401, 'Confirm your admin password to apply this change.', 'reauth_required');
    }
    const row = await store.getUserById(admin.id);
    if (!verifyPassword(password, row.pass_hash, row.pass_salt)) {
      await store.logAuthEvent({ username: admin.username, kind: 'reauth_fail', ip: clientIp(req), detail: group });
      throw new HttpError(401, 'That password is not correct.', 'bad_password');
    }
    await store.logAuthEvent({ username: admin.username, kind: 'admin_reauth', ip: clientIp(req), detail: group });
  }

  // ---------------------------------------------------------- admin guard rails

  async function adminRow(id) {
    return store.getUserById(id);
  }

  async function countOtherActiveAdmins(targetId) {
    const users = await store.listUsers();
    return users.filter((u) => u.role === 'admin' && u.status === 'active' && u.id !== targetId).length;
  }

  function assertNotSelfPurge(admin, targetId, what) {
    if (admin.id !== targetId) return;
    throw new HttpError(409, `You cannot ${what} your own account. Use Sign out, or ask another admin.`);
  }

  async function assertAnotherAdminExists(admin, targetId, what) {
    if ((await countOtherActiveAdmins(targetId)) > 0) return;
    throw new HttpError(
      409,
      `This is the last active administrator, so you cannot ${what} it. ` +
        `Promote another user first, from another admin account, or reset the lock with "npm run admin".`
    );
  }

  function validateCredentials(username, password, role = 'user') {
    if (!USERNAME_RE.test(username)) {
      throw new HttpError(400, 'Username must be 3-32 characters: letters, numbers, dot, dash or underscore.');
    }
    const problem = passwordProblem({ role, username, password });
    if (problem) throw new HttpError(400, problem);
  }

  function clampDays(value, fallback = 30) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(365, Math.max(1, Math.round(n)));
  }

  // ---------------------------------------------------------------- handlers

  async function handleRegister(req, res) {
    const ip = clientIp(req);
    const limit = rateLimit(`register:${ip}`, 8, 10 * 60 * 1000);
    if (!limit.ok) throw new HttpError(429, `Too many sign-ups from this address. Retry in ${limit.retryAfter}s.`);

    const body = await readJson(req, 64 * 1024);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    validateCredentials(username, password);
    // The bootstrap admin name is reserved: a signup for "admin" on a fresh install
    // would otherwise look like it worked right up until it was the real one.
    const reserved = String(process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
    if (username.toLowerCase() === reserved && !(await store.getUserByName(username))) {
      throw new HttpError(400, 'That username is reserved for the administrator.');
    }
    if (await store.getUserByName(username)) throw new HttpError(409, 'That username is already taken.');

    const { passHash, passSalt } = hashPassword(password);
    let id;
    try {
      id = await store.createUser({ username, passHash, passSalt });
    } catch {
      throw new HttpError(409, 'That username is already taken.');
    }
    const user = await store.getUserById(id);
    await store.logAuthEvent({ username, kind: 'signup', ip, detail: null });
    const session = await beginSession(req, res, user);
    sendJson(res, 200, { user: publicUser(user), markupPercent: await store.getMarkupPercent(), ...session });
  }

  async function handleLogin(req, res) {
    const body = await readJson(req, 64 * 1024);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const ip = clientIp(req);

    // This bucket is the only check that runs for usernames that do not exist, so
    // it fires at 10 attempts with the same generic wording as the per-account
    // lock below. A different number or message here would tell an attacker which
    // accounts are real.
    const limit = rateLimit(`login:${ip}:${username.toLowerCase()}`, 10, 15 * 60 * 1000);
    if (!limit.ok) {
      res.setHeader('Retry-After', String(limit.retryAfter));
      throw new HttpError(429, `Too many attempts. Retry in ${limit.retryAfter}s.`);
    }

    const user = await store.getUserByName(username);
    if (!user) {
      dummyVerify(password);
      await store.logAuthEvent({ username, kind: 'login_unknown', ip, detail: 'no such account' });
      throw new HttpError(401, 'Incorrect username or password.');
    }

    // Before verifyPassword: a locked account must not cost scrypt time per guess.
    await assertUnlocked(store, accountKey(user.username), user.role, user.username);

    if (!verifyPassword(password, user.pass_hash, user.pass_salt)) {
      const state = await noteFailure(store, user, ip);
      if (state.minutes) {
        res.setHeader('Retry-After', String(state.minutes * 60));
        throw new HttpError(429, lockedMessage(user.role, user.username, state.minutes * 60));
      }
      const warn = nextAttemptWarning(user.role, state.fails);
      throw new HttpError(
        401,
        warn
          ? `Incorrect username or password. ${warn.attemptsLeft} more failed attempt${warn.attemptsLeft === 1 ? '' : 's'} lock${warn.attemptsLeft === 1 ? 's' : ''} this account for ${warn.lockMinutes} min.`
          : 'Incorrect username or password.'
      );
    }

    if (user.status !== 'active') {
      await store.logAuthEvent({ username: user.username, kind: 'login_disabled', ip, detail: null });
      throw new HttpError(403, 'This account has been disabled.');
    }

    await noteSuccess(store, user, ip);
    await store.touchUser(user.id);
    const session = await beginSession(req, res, user);
    sendJson(res, 200, {
      user: publicUser(await store.getUserById(user.id)),
      markupPercent: await store.getMarkupPercent(),
      ...session
    });
  }

  // ------------------------------------------------------------ oauth sign-in

  // Where a finished login lands. Empty means "this same origin" — the normal
  // layout, where the session rides in a cookie. A split deployment lists the
  // page in ALLOWED_ORIGINS, and a cookie set by the API host would be third-party
  // storage there, so the session has to travel as a token instead.
  function oauthFrontOrigin() {
    return String(process.env.ALLOWED_ORIGINS || '').split(',')[0].trim().replace(/\/+$/, '');
  }

  function sendRedirect(res, location) {
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
    res.end();
  }

  function oauthStateCookie(value, maxAgeSeconds) {
    const parts = [
      `${OAUTH_STATE_COOKIE}=${value ? encodeURIComponent(value) : ''}`,
      'Path=/api/auth/oauth',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAgeSeconds}`
    ];
    // APP_URL is this deployment's own public address, so it answers "are we
    // https" far more honestly than a Host header the client chose.
    if (/^https:\/\//i.test(appUrl())) parts.push('Secure');
    return parts.join('; ');
  }

  function stateMatches(expected, received) {
    // Hashed first so the compare never sees two buffers of different length,
    // which is the one thing timingSafeEqual refuses to do.
    const digest = (s) => hashToken(String(s));
    const a = Buffer.from(digest(expected), 'hex');
    const b = Buffer.from(digest(received), 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // An OAuth sign-up never takes over an account that already exists, not even
  // one whose username matches the email's local part: that name was chosen by
  // somebody else, and owning an address is not proof of owning the account. A
  // taken name therefore gets a suffix and a fresh account.
  async function freeUsername(provider, preferred) {
    const cleaned = String(preferred || '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '')
      .replace(/^[._-]+|[._-]+$/g, '')
      .slice(0, 26);
    const base = cleaned.length >= 3 ? cleaned : `${cleaned || 'user'}-${provider === 'google' ? 'g' : 'gh'}`;
    const reserved = String(process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const name = attempt === 0 ? base : `${base}${attempt}`;
      if (name.length < 3 || name === reserved) continue;
      if (!(await store.getUserByName(name))) return name;
    }
    return `${base.slice(0, 24)}-${randomBytes(3).toString('hex')}`;
  }

  async function createOAuthAccount(provider, profile) {
    // scrypt over 32 random bytes that are then thrown away: password sign-in is
    // impossible for this account until somebody sets one, which is the honest
    // state for an account created by a third party.
    const { passHash, passSalt } = hashPassword(randomBytes(32).toString('base64url'));
    const wanted = profile.login || String(profile.email || '').split('@')[0];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const username = attempt === 0 ? await freeUsername(provider, wanted) : `${wanted.slice(0, 24)}-${randomBytes(3).toString('hex')}`;
      if (!USERNAME_RE.test(username)) continue;
      try {
        const id = await store.createUser({ username, passHash, passSalt });
        await store.createIdentity({
          provider,
          subject: profile.subject,
          userId: id,
          email: profile.email,
          login: profile.login,
          name: profile.name,
          avatar: profile.avatar
        });
        return await store.getUserById(id);
      } catch (err) {
        // The UNIQUE username is the only real candidate; anything else has to
        // surface rather than be retried into a different account.
        if (!/UNIQUE|CONSTRAINT/i.test(String(err && err.message))) throw err;
      }
    }
    throw new HttpError(409, 'Could not find a free username for this account. Try signing in again.');
  }

  async function handleOAuthBegin(req, res, url, match) {
    const provider = match[1];
    if (!oauthReady().includes(provider)) {
      throw new HttpError(404, 'That sign-in method is not configured on this server.');
    }
    const ip = clientIp(req);
    const limit = rateLimit(`oauth:${ip}`, 15, 10 * 60 * 1000);
    if (!limit.ok) {
      res.setHeader('Retry-After', String(limit.retryAfter));
      throw new HttpError(429, `Too many sign-in attempts from this address. Retry in ${limit.retryAfter}s.`);
    }

    const state = randomToken(24);
    // Proof key for Google only; GitHub has no PKCE for a confidential client, and
    // sending one there would be a second way to get the exchange wrong.
    const verifier = provider === 'google' ? randomToken(32) : '';
    const sealed = encryptSecret(JSON.stringify({ provider, state, verifier, at: Date.now() }));
    setCookies(res, oauthStateCookie(sealed, OAUTH_STATE_TTL_S));
    await store.logAuthEvent({ username: null, kind: 'oauth_begin', ip, detail: provider });
    sendRedirect(res, authorizeUrl(provider, { state, codeChallenge: verifier ? pkceChallenge(verifier) : '' }));
  }

  async function handleOAuthCallback(req, res, url, match) {
    const provider = match[1];
    const ip = clientIp(req);
    const front = oauthFrontOrigin();
    const fail = (reason) => sendRedirect(res, `${front}/?oauth=${encodeURIComponent(reason)}`);

    if (!oauthReady().includes(provider)) {
      throw new HttpError(404, 'That sign-in method is not configured on this server.');
    }
    const limit = rateLimit(`oauth-cb:${ip}`, 30, 10 * 60 * 1000);
    if (!limit.ok) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');

    // The handshake is single-use whatever happens next, so it is spent here even
    // on the failures — a code cannot be replayed against a stale state.
    setCookies(res, oauthStateCookie('', 0));

    const query = url.searchParams;
    if (query.get('error')) {
      await store.logAuthEvent({ username: null, kind: 'oauth_cancel', ip, detail: provider });
      return fail('cancelled');
    }

    const code = String(query.get('code') || '').slice(0, 512);
    const state = String(query.get('state') || '').slice(0, 256);
    const sealed = parseCookies(req.headers.cookie)[OAUTH_STATE_COOKIE] || '';
    if (!code || !state || !sealed) return fail('incomplete');

    let hand = null;
    try {
      hand = JSON.parse(decryptSecret(sealed));
    } catch {
      // A state sealed by another instance after MASTER_KEY changed, or by nobody.
    }
    if (!hand || hand.provider !== provider) return fail('tampered');
    if (Date.now() - Number(hand.at || 0) > OAUTH_STATE_TTL_S * 1000) return fail('expired');
    if (!stateMatches(hand.state, state)) return fail('mismatch');

    let profile;
    try {
      profile = await exchange(provider, { code, codeVerifier: String(hand.verifier || '') });
    } catch (err) {
      // The provider's own words stay in the log; the browser only ever sees that
      // the exchange failed, because an error string from upstream is untrusted.
      console.error(`[oauth] ${provider} exchange failed:`, err);
      await store.logAuthEvent({ username: null, kind: 'oauth_fail', ip, detail: provider });
      return fail('provider');
    }

    const identity = await store.getIdentity(provider, profile.subject);
    let user = identity ? await store.getUserById(identity.user_id) : null;
    if (identity && !user) {
      // Only reachable if the cascade did not run; leaving the row would lock this
      // provider account out of the site forever.
      await store.deleteIdentity(provider, profile.subject);
    }

    let kind = 'oauth_login';
    if (!user) {
      user = await createOAuthAccount(provider, profile);
      kind = 'oauth_signup';
    } else if (user.status !== 'active') {
      await store.logAuthEvent({ username: user.username, kind: 'oauth_disabled', ip, detail: provider });
      return fail('disabled');
    } else {
      await store.touchIdentity(provider, profile.subject);
    }

    await store.touchUser(user.id);
    await store.logAuthEvent({ username: user.username, kind, ip, detail: provider });
    const session = await beginSession(req, res, user, front !== '');
    sendRedirect(res, session.token ? `${front}/#devchat_oauth=${encodeURIComponent(session.token)}` : `${front}/`);
  }

  async function handleLogout(req, res) {
    const user = await sessionUser(req);
    if (user) {
      await store.deleteSession(user.tokenHash);
      await store.logAuthEvent({ username: user.username, kind: 'logout', ip: clientIp(req), detail: null });
    }
    setCookies(res, sessionCookie('', -1));
    sendJson(res, 200, { ok: true });
  }

  async function handleMe(req, res) {
    const user = await sessionUser(req);
    sendJson(res, 200, {
      user: user && user.status === 'active' ? publicUser(user) : null,
      disabled: Boolean(user && user.status !== 'active'),
      markupPercent: await store.getMarkupPercent(),
      priceBookSize: priceBookSize(),
      // Which buttons the sign-in pane may show. Reported rather than hard-coded,
      // so an unconfigured deployment never offers a dead "Continue with Google".
      oauth: oauthReady()
    });
  }

  async function handleChangePassword(req, res) {
    const user = await requireUser(req);
    const body = await readJson(req, 64 * 1024);
    const current = String(body.currentPassword || '');
    const next = String(body.newPassword || '');
    const row = await store.getUserById(user.id);
    if (!verifyPassword(current, row.pass_hash, row.pass_salt)) {
      await store.logAuthEvent({ username: row.username, kind: 'password_current_fail', ip: clientIp(req), detail: null });
      throw new HttpError(401, 'Your current password is incorrect.');
    }
    const problem = passwordProblem({ role: row.role, username: row.username, password: next });
    if (problem) throw new HttpError(400, problem);

    const { passHash, passSalt } = hashPassword(next);
    // setUserPassword drops every session for the account, including this one:
    // if the password was changed because of a suspected leak, the thief's cookie
    // has to die too. A new session is issued afterwards so the caller stays in.
    await store.setUserPassword(user.id, passHash, passSalt);
    // Whoever changed the password just proved they know the current one, so a
    // sign-in lock on this account is no longer needed and only causes confusion.
    await store.clearLoginGuard(accountKey(row.username));
    const session = await beginSession(req, res, row);
    await store.logAuthEvent({
      username: row.username,
      kind: 'password_change',
      ip: clientIp(req),
      detail: row.role === 'admin' ? 'admin password changed, all sessions revoked' : 'all sessions revoked'
    });
    sendJson(res, 200, { ok: true, sessionsRevoked: true, ...session });
  }

  async function handleSaveKey(req, res) {
    const user = await requireUser(req);
    const body = await readJson(req, 8 * 1024);
    const apiKey = String(body.apiKey || '').trim();
    if (!looksLikeApiKey(apiKey)) {
      throw new HttpError(400, 'That does not look like a key. Paste the full value, e.g. sk-xxxxxxxxxxxxxxxx');
    }
    // Verify before storing: a typo would otherwise fail on every later message
    // with no obvious cause. This spends the per-request minimum on the user's
    // own key, so a rejected key is never stored at all.
    const check = await verifyApiKey({ apiKey, base: env.apiBase, model: env.defaultModel });
    if (!check.ok) throw new HttpError(502, check.error);

    await store.setUserApiKey(user.id, encryptApiKey(apiKey), maskKey(apiKey));
    sendJson(res, 200, {
      user: publicUser(await store.getUserById(user.id)),
      markupPercent: await store.getMarkupPercent(),
      warning: check.warning || null
    });
  }

  async function handleDeleteKey(req, res) {
    const user = await requireUser(req);
    await store.setUserApiKey(user.id, null, null);
    sendJson(res, 200, { user: publicUser(await store.getUserById(user.id)) });
  }

  // The browser is never a trust boundary, so this cannot stop a determined
  // person — it makes tampering visible. Whatever the client-side guard notices
  // lands in the same audit list as logins, and the dedupe keeps a scripted
  // client from turning it into a write storm.
  async function handleGuardEvent(req, res) {
    const user = await requireUser(req);
    const limited = rateLimit(`guard:${user.id}`, 30, 60 * 60 * 1000);
    if (!limited.ok) throw new HttpError(429, 'Too many security reports. Slow down.');

    const body = await readJson(req, 2 * 1024);
    const kind = String(body.kind || '');
    if (!GUARD_EVENT_KINDS.has(kind)) throw new HttpError(400, 'Unknown guard event.');

    const last = await store.lastAuthEventAt(user.username, [kind]);
    if (Date.now() - last < GUARD_EVENT_DEDUPE_MS) return sendJson(res, 202, { ok: true, deduped: true });

    await store.logAuthEvent({
      username: user.username,
      kind,
      ip: clientIp(req),
      detail: String(body.detail || '').slice(0, 120)
    });
    sendJson(res, 202, { ok: true });
  }

  // The catalogue is public upstream and carries the price list, so one refresh
  // feeds both the model picker and the calculator. It costs no tokens and needs
  // no key, which means a brand-new user can browse models and prices before
  // saving anything.
  async function refreshCatalogue() {
    if (modelsCache.data && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.data;
    const result = await fetchModels(null, env.apiBase);
    if (!result.ok) throw new HttpError(502, result.error);
    ingestModels(result.data);
    modelsCache = { at: Date.now(), data: result.data };
    return modelsCache.data;
  }

  async function handleModels(req, res) {
    await requireUser(req);
    sendJson(res, 200, await refreshCatalogue());
  }

  async function handlePricing(req, res) {
    await requireUser(req);
    if (!priceBookFresh()) {
      try {
        await refreshCatalogue();
      } catch {
        /* serve whatever the cache holds rather than failing the calculator */
      }
    }
    sendJson(res, 200, {
      markupPercent: await store.getMarkupPercent(),
      unit: 'VND',
      live: priceBookSize() > 0,
      count: priceBookSize(),
      observedMinCharge: OBSERVED_MIN_CHARGE,
      models: listPriceBook().map((m) => ({
        id: m.id,
        input: m.input,
        output: m.output,
        cacheRead: m.cacheRead,
        cacheWrite: m.cacheWrite,
        min: m.min,
        perRequest: m.perRequest,
        endpoints: m.endpoints,
        context: m.context
      }))
    });
  }

  async function handleEstimate(req, res) {
    await requireUser(req);
    // A chat client may post an estimate before ever opening the price list, so
    // warm the book here too — otherwise every quote comes back unknown.
    if (!priceBookFresh()) {
      try {
        await refreshCatalogue();
      } catch {
        /* fall through and report the model as unpriced */
      }
    }
    const body = await readJson(req, 8 * 1024);
    const model = String(body.model || env.defaultModel).trim();
    const promptTokens = Math.max(0, Number(body.promptTokens) || 0);
    const completionTokens = Math.max(0, Number(body.completionTokens) || 0);
    const requests = Math.min(1e7, Math.max(1, Number(body.requests) || 1));
    const markupPercent = body.markupPercent === undefined
      ? await store.getMarkupPercent()
      : Math.min(1000, Math.max(0, Number(body.markupPercent) || 0));

    const one = estimateCost({ modelId: model, promptTokens, completionTokens, markupPercent });
    sendJson(res, 200, {
      model,
      unit: 'VND',
      known: one.known,
      markupPercent,
      promptTokens,
      completionTokens,
      inputPrice: one.inputPrice ?? null,
      outputPrice: one.outputPrice ?? null,
      minCharge: one.min,
      advertisedMinCharge: one.advertisedMin ?? 0,
      minApplied: one.appliedMin,
      rawCost: one.rawCost ?? 0,
      observedMinCharge: OBSERVED_MIN_CHARGE,
      perRequestBase: one.base,
      perRequestMarked: one.marked,
      requests,
      totalBase: Math.round(one.base * requests * 100) / 100,
      totalMarked: Math.round(one.marked * requests * 100) / 100,
      markupGain: Math.round((one.marked - one.base) * requests * 100) / 100
    });
  }

  async function handleChat(req, res) {
    // From here on the wire is allowed to go quiet: the provider is silent while it
    // reasons, and the body has its own deadline in readBody.
    clearIdleTimeout(req);
    const user = await requireUser(req);
    // Before the body is read: a refused request should not make the server pull
    // four megabytes of pasted code off the wire first.
    await limits.account(user, clientIp(req));
    const apiKey = requireApiKey(user);
    const payload = await readJson(req, 4 * 1024 * 1024);
    if (!Array.isArray(payload.messages) || !payload.messages.some(isValidMessage)) {
      throw new HttpError(400, 'A non-empty "messages" array is required');
    }
    const body = buildUpstreamBody(payload, env.defaultModel);
    const markupPercent = await store.getMarkupPercent();

    // The slot is taken only once the request is real. Holding one while a slow
    // client drips its body onto the wire would let an attacker occupy exactly the
    // resource the cap exists to protect.
    const leave = await limits.enter('stream', user.id, clientIp(req));
    try {
      // Awaited, not fire-and-forget: on a host that freezes the process when the
      // response ends, an unawaited usage write is simply lost.
      await proxyChat({
        apiKey,
        base: env.apiBase,
        body,
        req,
        res,
        async onResult(result) {
          // Logging must never break a stream that already succeeded.
          try {
            const tokens = extractTokens(result.usage);
            const actual = extractCost(result.usage);
            const quote = estimateCost({
              modelId: body.model,
              promptTokens: tokens.promptTokens,
              completionTokens: tokens.completionTokens
            });
            await store.logUsage({
              userId: user.id,
              model: body.model,
              promptTokens: tokens.promptTokens,
              completionTokens: tokens.completionTokens,
              actualCost: actual,
              billedCost: applyMarkup(actual, markupPercent),
              estimateCost: quote.known ? quote.base : 0,
              durationMs: result.ms,
              ok: Boolean(result.ok),
              error: result.ok ? null : String(result.error || 'failed').slice(0, 500)
            });
          } catch (err) {
            console.error('[usage] failed to record request:', err.message);
          }
        }
      });
    } finally {
      leave();
    }
  }
  // A 401 from the provider is about the stored sk- key, but the browser reads any
  // 401 as "your session died" and signs the user out. Only statuses that cannot be
  // mistaken for our own auth are passed through; the message already explains it.
  function providerStatus(status) {
    if (!Number.isFinite(status) || status < 400 || status > 599) return 502;
    return status === 401 || status === 403 ? 502 : status;
  }

  // One usage row per user action, for both media routes. A picture has no tokens,

  // so the provider's own per-request price is the estimate; when the answer does
  // carry x_ckey.cost that real number wins, exactly as it does in chat.
  // Awaited before the response is sent: a frozen serverless function would lose
  // an in-flight write.
  //
  // quoteIsActual is for the route whose answer is a file rather than JSON: it
  // cannot report a cost, and a per-request-priced model has no other number to
  // keep. Recording 0 there would make the dashboard's re-derived totals read a
  // paid-for speech request as free.
  async function recordMedia({ userId, model, units, result, startedAt, error, quoteIsActual = false }) {
    try {
      const markupPercent = await store.getMarkupPercent();
      const count = Math.max(1, Number(units) || 1);
      const quote = estimateCost({ modelId: model, promptTokens: 0, completionTokens: 0 });
      const reported = result && result.ok ? extractCost(result.data && result.data.usage) : 0;
      const base = reported > 0 ? reported : quote.known ? quote.base * count : 0;
      const actual = reported > 0 || (quoteIsActual && quote.known) ? base : 0;
      await store.logUsage({
        userId,
        model,
        promptTokens: 0,
        completionTokens: 0,
        actualCost: actual,
        billedCost: applyMarkup(base, markupPercent),
        estimateCost: quote.known ? quote.base * count : 0,
        durationMs: Date.now() - startedAt,
        ok: Boolean(result && result.ok && !error),
        error: error || (result && result.error) || null
      });
      return { baseCost: base, markupPercent, billedCost: applyMarkup(base, markupPercent) };
    } catch (err) {
      console.error('[usage] failed to record media request:', err.message);
      return { baseCost: 0, markupPercent: 0, billedCost: 0 };
    }
  }

  // The provider prices pictures per request, and the models that answer on that
  // endpoint run from 65 dong to 1800 dong for one image. This server only offers
  // the cheap end of the range; MAX_PICTURE_DONG moves the line and 0 removes it.
  // A model with no published per-request price is left out too — the ceiling is
  // there to stop a surprise on the user's bill, and an unknown number is one.
  function underCeiling(model) {
    const ceiling = pictureCeilingDong();
    if (!ceiling) return true;
    return model.perRequest !== null && model.perRequest < ceiling;
  }

  function pictureModels() {
    return listCapable('images/generations').filter(underCeiling);
  }

  // The list the browser is given is a hint; this is the control, run on the route
  // where the money actually leaves the caller's key.
  function assertPictureAffordable(modelId) {
    const ceiling = pictureCeilingDong();
    const price = getPrice(modelId);
    if (!ceiling || !price || price.perRequest === null || price.perRequest < ceiling) return;
    throw new HttpError(
      400,
      `${modelId} costs ${price.perRequest} dong for one picture, and this server only offers pictures`
        + ` under ${ceiling} dong. Choose a cheaper model, or raise MAX_PICTURE_DONG.`
    );
  }

  // Which models can take a picture as input and draw a new one from it. The
  // provider's `images/edits` endpoint answers 400 for every body shape tried
  // against it — including for the one model it lists there — so editing goes
  // through the chat endpoint instead, on the models that advertise both chat and
  // image generation. Those are the ones that accept an image_url part in a
  // message and answer with the edited picture.
  function visionModels() {
    return [...listCapable('chat/completions'), ...listCapable('images/generations')]
      .filter((m) => m.endpoints.includes('chat/completions') && m.endpoints.includes('images/generations'))
      .filter((m, index, all) => all.findIndex((o) => o.id === m.id) === index)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  // Refuse an edit asked of a model that cannot see. Checked against the
  // catalogue rather than a name pattern, and skipped entirely when the catalogue
  // is empty: no price book is not the same as a model being unqualified, and a
  // stalled /models call must not take the studio down with it.
  function assertVisionModel(modelId) {
    if (!priceBookSize()) return;
    if (visionModels().some((m) => m.id === modelId)) return;
    throw new HttpError(
      400,
      `${modelId} cannot take a picture as input on this provider. Pick a model that appears in the Edit tab.`
    );
  }

  // What the studio may offer, decided by the provider's own endpoints array
  // rather than by a name pattern in the browser.
  async function handleStudioModels(req, res) {
    await requireUser(req);
    if (!priceBookFresh()) {
      try {
        await refreshCatalogue();
      } catch {
        /* the chat models are cached, so a stalled catalogue still shows the priced ones */
      }
    }
    const shape = (m) => ({
      id: m.id,
      perRequest: m.perRequest,
      min: m.min,
      context: m.context,
      unit: m.unit
    });
    sendJson(res, 200, {
      markupPercent: await store.getMarkupPercent(),
      pictureCeiling: pictureCeilingDong(),
      // Counted before the ceiling was applied, so the studio can say how many
      // models it left out instead of looking like a short list for no reason.
      pictureTotal: listCapable('images/generations').length,
      image: pictureModels().map(shape),
      // Editing is outside the ceiling on purpose: it is what the user asked their
      // own picture be turned into, and the confirm step is what guards the spend.
      edit: visionModels().map(shape),
      voice: listCapable('audio/speech').map(shape),
      // No video model appears in the catalogue, so this list is configuration.
      video: videoModels().map((id) => ({ id, perRequest: null, min: 0, context: 0, unit: 'VND' }))
    });
  }

  async function handleImage(req, res) {
    clearIdleTimeout(req);
    const user = await requireUser(req);
    await limits.account(user, clientIp(req));
    const apiKey = requireApiKey(user);
    const limited = rateLimit(`image:${user.id}`, IMAGE_LIMIT.max, IMAGE_LIMIT.windowMs);
    if (!limited.ok) {
      const err = new HttpError(429, `Slow down — at most ${IMAGE_LIMIT.max} pictures a minute. Retry in ${limited.retryAfter}s.`);
      err.retryAfter = limited.retryAfter;
      throw err;
    }

    const payload = await readJson(req, 64 * 1024);
    const body = buildImageBody(payload, env.defaultModel);
    if (!body.prompt) throw new HttpError(400, 'Describe the picture you want first.');
    assertPictureAffordable(body.model);

    const startedAt = Date.now();
    // A picture holds the provider connection for tens of seconds, so the media
    // slot is taken for exactly that call and nothing else.
    const leave = await limits.enter('media', user.id, clientIp(req));
    let result;
    try {
      result = await requestUpstreamJson({
        apiKey,
        base: env.apiBase,
        path: '/images/generations',
        body
      });
    } finally {
      leave();
    }
    const images = result.ok ? normalizeImages(result.data) : [];
    const problem = result.ok
      ? images.length
        ? null
        : 'The provider accepted the request but returned no image.'
      : result.error;

    const costs = await recordMedia({
      userId: user.id, model: body.model, units: body.n, result, startedAt, error: problem
    });
    if (problem) throw new HttpError(providerStatus(result.status), problem);

    sendJson(res, 200, {
      model: body.model,
      images,
      ms: Date.now() - startedAt,
      baseCost: costs.baseCost,
      billedCost: costs.billedCost,
      markupPercent: costs.markupPercent,
      unit: 'VND'
    });
  }

  // Editing a picture the user already has: the instruction and the file go to a
  // vision model on the chat endpoint, and the answer is read for the picture it
  // embedded. The file never leaves this server except as the body of that call,
  // and the browser's copy is held only for the request.
  async function handleEdit(req, res) {
    clearIdleTimeout(req);
    const user = await requireUser(req);
    await limits.account(user, clientIp(req));
    const apiKey = requireApiKey(user);
    const limited = rateLimit(`edit:${user.id}`, EDIT_LIMIT.max, EDIT_LIMIT.windowMs);
    if (!limited.ok) {
      const err = new HttpError(429, `Slow down — at most ${EDIT_LIMIT.max} edits a minute. Retry in ${limited.retryAfter}s.`);
      err.retryAfter = limited.retryAfter;
      throw err;
    }

    // A picture has to travel with the instruction, so this is the one route that
    // accepts a chat-sized body. The client compresses first; this ceiling is what
    // stops somebody posting a raw 40 MB scan.
    const payload = await readJson(req, 4 * 1024 * 1024);
    const body = buildEditBody(payload, env.defaultModel);
    const [instruction, picture] = body.messages[0].content;
    if (!instruction.text) throw new HttpError(400, 'Say what to change about the picture first.');
    if (!picture) throw new HttpError(400, 'Choose the picture to edit, or paste a link to one.');
    assertVisionModel(body.model);

    const startedAt = Date.now();
    const leave = await limits.enter('media', user.id, clientIp(req));
    let result;
    try {
      result = await requestUpstreamJson({ apiKey, base: env.apiBase, path: '/chat/completions', body });
    } finally {
      leave();
    }
    const images = result.ok ? normalizeChatPictures(result.data) : [];
    const problem = result.ok
      ? images.length
        ? null
        : 'The model answered, but it did not send a picture back. Ask again, or try another model.'
      : result.error;

    const costs = await recordMedia({
      userId: user.id, model: body.model, units: 1, result, startedAt, error: problem
    });
    if (problem) throw new HttpError(providerStatus(result.status), problem);

    sendJson(res, 200, {
      model: body.model,
      images,
      ms: Date.now() - startedAt,
      baseCost: costs.baseCost,
      billedCost: costs.billedCost,
      markupPercent: costs.markupPercent,
      unit: 'VND'
    });
  }

  // Text to speech. The reply is the audio file, so it is relayed as bytes under
  // this origin: the caller's key stays on the server and the provider's host never
  // sees the page that played the clip.
  async function handleSpeech(req, res) {
    clearIdleTimeout(req);
    const user = await requireUser(req);
    await limits.account(user, clientIp(req));
    const apiKey = requireApiKey(user);
    const limited = rateLimit(`speech:${user.id}`, SPEECH_LIMIT.max, SPEECH_LIMIT.windowMs);
    if (!limited.ok) {
      const err = new HttpError(429, `Slow down — at most ${SPEECH_LIMIT.max} clips a minute. Retry in ${limited.retryAfter}s.`);
      err.retryAfter = limited.retryAfter;
      throw err;
    }

    const payload = await readJson(req, 64 * 1024);
    const body = buildSpeechBody(payload, env.defaultModel);
    if (!body.input) throw new HttpError(400, 'Write the text you want read aloud first.');

    const startedAt = Date.now();
    const leave = await limits.enter('media', user.id, clientIp(req));
    let result;
    try {
      result = await requestUpstreamBinary({ apiKey, base: env.apiBase, path: '/audio/speech', body });
    } finally {
      leave();
    }

    // Awaited before the bytes go out: the answer is a file, so there is no JSON
    // envelope left to attach a cost to, and the log is the only place it is kept.
    await recordMedia({
      userId: user.id, model: body.model, units: 1, result, startedAt,
      error: result.ok ? null : result.error, quoteIsActual: true
    });
    if (!result.ok) throw new HttpError(providerStatus(result.status), result.error);

    sendBytes(res, 200, result.buffer, result.contentType);
  }

  async function handleVideoStart(req, res) {
    clearIdleTimeout(req);
    const user = await requireUser(req);
    await limits.account(user, clientIp(req));
    const apiKey = requireApiKey(user);
    const limited = rateLimit(`video:${user.id}`, VIDEO_LIMIT.max, VIDEO_LIMIT.windowMs);
    if (!limited.ok) {
      const err = new HttpError(429, `Slow down — at most ${VIDEO_LIMIT.max} video jobs a minute. Retry in ${limited.retryAfter}s.`);
      err.retryAfter = limited.retryAfter;
      throw err;
    }

    const payload = await readJson(req, 64 * 1024);
    const body = buildVideoBody(payload, env.defaultModel);
    if (!body.content[0].text) throw new HttpError(400, 'Describe the clip you want first.');

    const startedAt = Date.now();
    const leave = await limits.enter('media', user.id, clientIp(req));
    let result;
    try {
      result = await requestUpstreamJson({
        apiKey,
        base: v2Base(env.apiBase),
        path: '/video/generations',
        body
      });
    } finally {
      leave();
    }
    const task = normalizeVideoTask(result.data);
    const problem = result.ok
      ? task.id
        ? null
        : 'The provider started this job without giving a task id, so DevChat cannot follow it.'
      : result.error;

    const costs = await recordMedia({
      userId: user.id, model: body.model, units: 1, result, startedAt, error: problem
    });
    if (problem) throw new HttpError(providerStatus(result.status), problem);

    // Nothing is billed into the log here that the provider has not already taken:
    // a task id is the whole answer, and the clip arrives on a later poll.
    sendJson(res, 202, {
      model: body.model,
      task,
      ms: Date.now() - startedAt,
      baseCost: costs.baseCost,
      billedCost: costs.billedCost,
      markupPercent: costs.markupPercent,
      unit: 'VND'
    });
  }

  async function handleVideoStatus(req, res, url, match) {
    const user = await requireUser(req);
    const apiKey = requireApiKey(user);
    // The pattern already restricts this to task-id characters, so it cannot be
    // turned into a path to somewhere else on the gateway.
    const taskId = match[1];
    const result = await requestUpstreamJson({
      apiKey,
      base: v2Base(env.apiBase),
      path: `/video/generations/${encodeURIComponent(taskId)}`,
      method: 'GET'
    });
    if (!result.ok) throw new HttpError(providerStatus(result.status), result.error);
    sendJson(res, 200, { task: normalizeVideoTask(result.data) });
  }

  async function handleAdminOverview(req, res, url) {
    await requireAdmin(req);
    if (!priceBookSize()) {
      // Free and unauthenticated upstream, so a cold dashboard can still show
      // list prices instead of a row of zeros.
      try {
        await refreshCatalogue();
      } catch {
        /* the rest of the overview is still useful */
      }
    }
    const days = clampDays(url.searchParams.get('days'));
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const markupPercent = await store.getMarkupPercent();

    // usage_log.billed_cost is a snapshot of the markup in force when the
    // request happened, which is right for the audit trail but wrong for a
    // dashboard that is supposed to react to "set markup live". The aggregates
    // are therefore re-derived from actual_cost; recent[] keeps the snapshot.
    const round4 = (n) => Math.round(n * 10000) / 10000;
    const live = (row) => ({ ...row, billed_cost: round4(applyMarkup(row.actual_cost, markupPercent)) });

    const totals = live(await store.usageTotals(since));
    sendJson(res, 200, {
      days,
      markupPercent,
      userCount: await store.countUsers(),
      adminCount: await store.countAdmins(),
      priceBook: { count: priceBookSize(), live: priceBookSize() > 0 },
      totals,
      byUser: (await store.usageByUser(since)).map(live),
      byModel: (await store.usageByModel(since)).map(live),
      byDay: (await store.usageByDay(since)).map(live),
      recent: await store.recentUsage(40)
    });
  }

  async function handleAdminUsers(req, res) {
    await requireAdmin(req);
    const markupPercent = await store.getMarkupPercent();
    const users = (await store.listUsers()).map((u) => ({
      ...u,
      billed_cost: Math.round(applyMarkup(u.actual_cost, markupPercent) * 10000) / 10000
    }));
    sendJson(res, 200, { users, markupPercent });
  }

  async function handleAdminStatus(req, res, url, match) {
    const admin = await requireAdmin(req);
    const id = Number(match[1]);
    const body = await readJson(req, 4096);
    await stepUp(req, admin, 'accounts', body);
    const status = String(body.status || '');
    if (!['active', 'disabled'].includes(status)) throw new HttpError(400, 'status must be "active" or "disabled"');
    assertNotSelfPurge(admin, id, 'disable');
    const target = await adminRow(id);
    if (!target) throw new HttpError(404, 'No such user');
    if (status === 'disabled') {
      await assertAnotherAdminExists(admin, id, 'disable');
      await store.deleteUserSessions(id);
    }
    await store.setUserStatus(id, status);
    await store.logAuthEvent({
      username: admin.username,
      kind: 'admin_status',
      ip: clientIp(req),
      detail: `${status === 'disabled' ? 'disabled' : 'enabled'} @${target.username}`
    });
    sendJson(res, 200, { ok: true, user: publicUser(await adminRow(id)) });
  }

  async function handleAdminRole(req, res, url, match) {
    const admin = await requireAdmin(req);
    const id = Number(match[1]);
    const body = await readJson(req, 4096);
    await stepUp(req, admin, 'roles', body);
    const role = String(body.role || '');
    if (!['user', 'admin'].includes(role)) throw new HttpError(400, 'role must be "user" or "admin"');
    if (id === admin.id && role !== 'admin') throw new HttpError(409, 'You cannot remove your own admin rights.');
    const target = await adminRow(id);
    if (!target) throw new HttpError(404, 'No such user');
    if (role !== 'admin') await assertAnotherAdminExists(admin, id, 'demote');
    await store.setUserRole(id, role);
    await store.logAuthEvent({
      username: admin.username,
      kind: 'admin_role',
      ip: clientIp(req),
      detail: `@${target.username} → ${role}`
    });
    sendJson(res, 200, { ok: true, user: publicUser(await adminRow(id)) });
  }

  async function handleAdminResetPassword(req, res, url, match) {
    const admin = await requireAdmin(req);
    const id = Number(match[1]);
    const body = await readJson(req, 4096);
    await stepUp(req, admin, 'accounts', body);
    const password = String(body.password || '');
    const target = await adminRow(id);
    if (!target) throw new HttpError(404, 'No such user');
    // A reset aimed at an administrator is a way to take the admin account over,
    // so it must not be possible to set a weak password and the session cookies
    // of that admin have to die. Both happen below: setUserPassword revokes them.
    const problem = passwordProblem({ role: target.role, username: target.username, password });
    if (problem) throw new HttpError(400, problem);
    await assertNotLockedAdminSelfReset(admin, target);
    const { passHash, passSalt } = hashPassword(password);
    await store.setUserPassword(id, passHash, passSalt);
    await store.logAuthEvent({
      username: admin.username,
      kind: 'admin_reset_password',
      ip: clientIp(req),
      detail: `password reset for @${target.username} (${target.role}), sessions revoked`
    });
    sendJson(res, 200, { ok: true, sessionsRevoked: await store.countSessions(id) });
  }

  // An admin who is locked out and still signed in elsewhere must not be able to
  // lift the lock by resetting the very account that is locked — that would turn
  // a stolen long-lived admin cookie into a way to erase the evidence.
  async function assertNotLockedAdminSelfReset(admin, target) {
    if (admin.id === target.id) return;
    const guard = await store.getLoginGuard(accountKey(target.username));
    if (!guard || guard.locked_until <= Date.now()) return;
    throw new HttpError(
      409,
      `@${target.username} is locked by failed sign-in attempts. Unlock it first, or run "npm run admin -- --unlock ${target.username}".`
    );
  }

  async function handleAdminDeleteUser(req, res, url, match) {
    const admin = await requireAdmin(req);
    const id = Number(match[1]);
    const body = await readJson(req, 4096);
    await stepUp(req, admin, 'accounts', body);
    assertNotSelfPurge(admin, id, 'delete');
    const target = await adminRow(id);
    if (!target) throw new HttpError(404, 'No such user');
    if (target.role === 'admin') await assertAnotherAdminExists(admin, id, 'delete');
    await store.deleteUser(id);
    await store.clearLoginGuard(accountKey(target.username));
    await store.logAuthEvent({
      username: admin.username,
      kind: 'admin_delete_user',
      ip: clientIp(req),
      detail: `deleted @${target.username} (${target.role}) with their usage rows and stored key`
    });
    sendJson(res, 200, { ok: true });
  }

  async function handleAdminSessions(req, res) {
    const admin = await requireAdmin(req);
    const all = await store.listUsers();
    const rows = all
      .filter((u) => u.sessions > 0)
      .map((u) => ({
        id: u.id,
        username: u.username,
        role: u.role,
        status: u.status,
        sessions: u.sessions,
        lastSeenAt: u.last_seen_at
      }));
    sendJson(res, 200, {
      rows,
      me: { id: admin.id, username: admin.username, sessionCount: await store.countSessions(admin.id) }
    });
  }

  async function handleAdminRevokeSessions(req, res, url, match) {
    const admin = await requireAdmin(req);
    const id = Number(match[1]);
    const body = await readJson(req, 4096);
    await stepUp(req, admin, 'accounts', body);
    const target = await adminRow(id);
    if (!target) throw new HttpError(404, 'No such user');
    const mine = id === admin.id;
    // Revoking your own sessions deletes all of them and immediately hands this
    // browser a new cookie: every other device is out, this one stays in.
    await store.deleteUserSessions(id);
    const session = mine ? await beginSession(req, res, admin) : {};
    await store.logAuthEvent({
      username: admin.username,
      kind: 'admin_revoke_sessions',
      ip: clientIp(req),
      detail: `${mine ? 'other sessions of my own account' : `all sessions of @${target.username}`}`
    });
    sendJson(res, 200, { ok: true, revoked: true, self: mine, ...session });
  }

  async function handleAdminSecurity(req, res) {
    await requireAdmin(req);
    const now = Date.now();
    const [guards, events, users] = await Promise.all([
      store.listLoginGuards(),
      store.recentAuthEvents(60),
      store.listUsers()
    ]);
    sendJson(res, 200, {
      guards: guards
        .filter((g) => g.fails > 0)
        .map((g) => ({
          username: g.username || g.key.replace(/^user:/, ''),
          knownUser: Boolean(g.username),
          role: g.role,
          status: g.status,
          fails: g.fails,
          lockedUntil: g.locked_until,
          lockedSeconds: g.locked_until > now ? Math.ceil((g.locked_until - now) / 1000) : 0,
          lastAttemptAt: g.updated_at
        })),
      events,
      admins: users.filter((u) => u.role === 'admin').map((u) => ({
        id: u.id,
        username: u.username,
        status: u.status,
        sessions: u.sessions,
        lastSeenAt: u.last_seen_at
      })),
      policy: {
        admin: GUARD_POLICY.admin,
        user: GUARD_POLICY.user,
        adminPasswordChars: ADMIN_MIN_PASSWORD,
        userPasswordChars: USER_MIN_PASSWORD,
        adminSessionHours: Math.round(ADMIN_SESSION_TTL_MS / 3600000),
        reauth: adminReauthMode(),
        reauthMinutes: Math.round(adminReauthWindowMs() / 60000)
      },
      // What this instance is holding right now, against the caps it enforces. The
      // numbers are per instance — see README → "Anti-abuse".
      throttle: limits.snapshot()
    });
  }

  async function handleAdminUnlock(req, res) {
    const admin = await requireAdmin(req);
    const body = await readJson(req, 4096);
    await stepUp(req, admin, 'accounts', body);
    const username = String(body.username || '').trim();
    if (!username) throw new HttpError(400, 'username is required');
    await unlockAccount(store, username);
    await store.logAuthEvent({
      username: admin.username,
      kind: 'admin_unlock',
      ip: clientIp(req),
      detail: `lock cleared for @${username}`
    });
    sendJson(res, 200, { ok: true, username });
  }

  async function handleAdminSettings(req, res) {
    const admin = await requireAdmin(req);
    const body = await readJson(req, 4096);
    await stepUp(req, admin, 'pricing', body);
    let markupPercent;
    try {
      markupPercent = await store.setMarkupPercent(body.markupPercent);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    await store.logAuthEvent({
      username: admin.username,
      kind: 'admin_markup',
      ip: clientIp(req),
      detail: `markup → ${markupPercent}%`
    });
    sendJson(res, 200, { markupPercent });
  }

  async function handleHealth(req, res) {
    const user = await sessionUser(req);
    sendJson(res, 200, {
      ok: true,
      base: env.apiBase,
      defaultModel: env.defaultModel,
      signedIn: Boolean(user && user.status === 'active'),
      priceBook: priceBookSize(),
      users: await store.countUsers(),
      oauth: oauthReady()
    });
  }

  // ------------------------------------------------------------------ routing

  // The fourth element is the tier lib/limits.js gates the route under: 'auth' for
  // the routes that touch the password hash, 'expensive' for the ones that spend
  // the provider's money and hold a connection doing it. Everything else is only
  // behind the per-address bucket that runs before this table is even searched, so
  // an unknown path costs a regex and nothing more.
  const routes = [
    ['GET', /^\/api\/health$/, handleHealth],
    ['POST', /^\/api\/auth\/register$/, handleRegister, 'auth'],
    ['POST', /^\/api\/auth\/login$/, handleLogin, 'auth'],
    // The provider name is matched by the pattern itself, so nothing from the URL
    // ever reaches the redirect target or the token endpoint unvalidated.
    ['GET', /^\/api\/auth\/oauth\/(google|github)$/, handleOAuthBegin, 'auth'],
    ['GET', /^\/api\/auth\/oauth\/(google|github)\/callback$/, handleOAuthCallback, 'auth'],
    ['POST', /^\/api\/auth\/logout$/, handleLogout],
    ['GET', /^\/api\/me$/, handleMe],
    ['POST', /^\/api\/auth\/password$/, handleChangePassword],
    ['POST', /^\/api\/key$/, handleSaveKey],
    ['DELETE', /^\/api\/key$/, handleDeleteKey],
    ['GET', /^\/api\/models$/, handleModels],
    ['GET', /^\/api\/pricing$/, handlePricing],
    ['POST', /^\/api\/pricing\/estimate$/, handleEstimate],
    ['POST', /^\/api\/chat$/, handleChat, 'expensive'],
    ['GET', /^\/api\/studio\/models$/, handleStudioModels],
    ['POST', /^\/api\/image$/, handleImage, 'expensive'],
    ['POST', /^\/api\/image\/edit$/, handleEdit, 'expensive'],
    ['POST', /^\/api\/audio\/speech$/, handleSpeech, 'expensive'],
    ['POST', /^\/api\/video$/, handleVideoStart, 'expensive'],
    // Task ids are echoed straight back into the upstream path, so the pattern is
    // the allowlist: anything with a slash, a dot-dot or a query in it never runs.
    ['GET', /^\/api\/video\/([A-Za-z0-9_.:-]{1,120})$/, handleVideoStatus],
    ['POST', /^\/api\/guard\/event$/, handleGuardEvent],
    ['GET', /^\/api\/admin\/overview$/, handleAdminOverview],
    ['GET', /^\/api\/admin\/users$/, handleAdminUsers],
    ['GET', /^\/api\/admin\/sessions$/, handleAdminSessions],
    ['GET', /^\/api\/admin\/security$/, handleAdminSecurity],
    ['POST', /^\/api\/admin\/unlock$/, handleAdminUnlock],
    ['POST', /^\/api\/admin\/users\/(\d+)\/status$/, handleAdminStatus],
    ['POST', /^\/api\/admin\/users\/(\d+)\/role$/, handleAdminRole],
    ['POST', /^\/api\/admin\/users\/(\d+)\/password$/, handleAdminResetPassword],
    ['POST', /^\/api\/admin\/users\/(\d+)\/sessions$/, handleAdminRevokeSessions],
    ['DELETE', /^\/api\/admin\/users\/(\d+)$/, handleAdminDeleteUser],
    ['POST', /^\/api\/admin\/settings$/, handleAdminSettings]
  ];

  // The one place an HttpError becomes a response, so a request refused by a gate
  // before it reached a handler looks exactly like one refused inside a handler.
  function sendError(res, err) {
    const expected = err instanceof HttpError;
    if (expected && err.retryAfter && !res.headersSent) {
      res.setHeader('Retry-After', String(err.retryAfter));
    }
    // A refusal that stopped mid-body leaves the connection half-read. Without
    // this the client gets its 408 and then waits on a socket Node has no reason
    // to close.
    if (expected && err.closeConnection && !res.headersSent) {
      res.setHeader('Connection', 'close');
    }
    sendJson(res, expected ? err.status : 500, {
      error: expected ? err.message : 'Internal server error',
      code: expected && err.code ? err.code : null
    });
  }

  return async function handleApi(req, res, url) {
    const { pathname } = url;
    if (!pathname.startsWith('/api/')) return false;
    const method = req.method.toUpperCase();

    if (method === 'OPTIONS') return handlePreflight(req, res);
    applyCors(req, res);

    // Same-origin is what makes the cookie safe as ambient credentials. A page on
    // another origin only gets through when allowlisted, and it then authenticates
    // with a bearer token — which a cross-site form or fetch cannot attach.
    if (method !== 'GET' && method !== 'HEAD' && !originAllowed(req)) {
      sendJson(res, 403, { error: 'Cross-origin request blocked' });
      return true;
    }
    if (method === 'POST' && !String(req.headers['content-type'] || '').includes('application/json')) {
      sendJson(res, 415, { error: 'Content-Type must be application/json' });
      return true;
    }

    // Per address, in memory, before any handler, database read or upstream call —
    // and before the route table is searched, so this also covers paths that do
    // not exist. It is the cheapest refusal in the app on purpose.
    try {
      await limits.perMinute(req);
    } catch (err) {
      sendError(res, err);
      return true;
    }

    for (const [routeMethod, pattern, handler, tier] of routes) {
      if (routeMethod !== method) continue;
      const match = pattern.exec(pathname);
      if (!match) continue;
      try {
        await limits.guarded(req, tier);
        await handler(req, res, url, match);
      } catch (err) {
        // An HttpError carries a message we wrote for the user, including the
        // 5xx ones; anything else is unexpected and must not leak internals.
        if (!(err instanceof HttpError)) console.error(`[api] ${method} ${pathname}:`, err);
        sendError(res, err);
      }
      return true;
    }

    sendJson(res, 404, { error: 'Not found' });
    return true;
  };
}
