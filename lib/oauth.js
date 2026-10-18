// Sign-in with a Google or GitHub account, written against the two providers'
// plain authorization-code endpoints because there is no dependency to buy here.
//
// Only the shape of the exchange is this file's business. It never touches the
// database, never issues a session and never decides what an account may do —
// lib/routes.js does all of that with the profile this returns.
import { createHash, randomBytes } from 'node:crypto';

const TIMEOUT_MS = 15_000;

const PROVIDERS = {
  google: {
    label: 'Google',
    scope: 'openid email profile',
    // Google's own OIDC endpoints. `userinfo` over the ID token means no JWT
    // signature or audience check to get wrong here.
    urls: {
      authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
      token: 'https://oauth2.googleapis.com/token',
      profile: 'https://openidconnect.googleapis.com/v1/userinfo'
    }
  },
  github: {
    label: 'GitHub',
    scope: 'read:user user:email',
    urls: {
      authorize: 'https://github.com/login/oauth/authorize',
      token: 'https://github.com/login/oauth/access_token',
      profile: 'https://api.github.com/user',
      emails: 'https://api.github.com/user/emails'
    }
  }
};

export function providerIds() {
  return Object.keys(PROVIDERS);
}

function env(name) {
  return String(process.env[name] || '').trim();
}

// Each provider is one pair of variables, and both halves have to be present: an
// app registered without its secret would look configured and then fail at the
// token endpoint, which is a far worse experience than not offering the button.
export function credentialsFor(provider) {
  const id = env(`${provider.toUpperCase()}_CLIENT_ID`);
  const secret = env(`${provider.toUpperCase()}_CLIENT_SECRET`);
  return id && secret ? { clientId: id, clientSecret: secret } : null;
}

// Every redirect this file builds is rooted here, and it is deliberately an
// explicit setting rather than the request's Host header: a spoofed host would
// otherwise steer a finished login — and the token in its fragment — somewhere
// else. Unset means no OAuth, which is also the answer on a machine that has not
// decided what its public address is yet.
export function appUrl() {
  const raw = env('APP_URL');
  if (!raw) return '';
  return raw.replace(/\/+$/, '');
}

export function oauthReady() {
  const base = appUrl();
  if (!base) return [];
  return providerIds().filter((provider) => credentialsFor(provider) !== null);
}

export function redirectUri(provider) {
  return `${appUrl()}/api/auth/oauth/${provider}/callback`;
}

// Test-only indirection: the fake provider in .smoketest answers on a loopback
// port, and the flow is worth covering end to end rather than left to a browser.
function url(provider, part) {
  const over = env(`OAUTH_${provider.toUpperCase()}_${part.toUpperCase()}_URL`);
  if (over) return over;
  return PROVIDERS[provider].urls[part];
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function pkceChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function authorizeUrl(provider, { state, codeChallenge }) {
  const { clientId } = credentialsFor(provider);
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(provider),
    response_type: 'code',
    scope: PROVIDERS[provider].scope,
    state
  });
  if (provider === 'google') {
    query.set('access_type', 'online');
    query.set('include_granted_scopes', 'true');
    query.set('code_challenge', codeChallenge);
    query.set('code_challenge_method', 'S256');
  }
  return `${url(provider, 'authorize')}?${query}`;
}

async function postForm(endpoint, fields) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // GitHub answers form-encoded unless it is told to speak JSON.
      Accept: 'application/json'
    },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || typeof body !== 'object') {
    const reason = String((body && (body.error_description || body.error)) || `HTTP ${res.status}`);
    throw new Error(`The provider refused the code (${short(reason)}).`);
  }
  return body;
}

async function getJson(endpoint, accessToken, extraHeaders = {}) {
  const res = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      // api.github.com rejects a request with no user agent at all.
      'User-Agent': 'devchat-oauth',
      ...extraHeaders
    },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || typeof body !== 'object') {
    throw new Error(`The provider would not return the profile (HTTP ${res.status}).`);
  }
  return body;
}

// Anything this length is echoed back to an operator, so keep it to one line and
// free of the access token that could otherwise ride along in an error string.
function short(value) {
  return String(value).replace(/\s+/g, ' ').slice(0, 160);
}

function text(value, max) {
  const s = String(value ?? '').trim();
  return s ? s.slice(0, max) : '';
}

// One shape for both providers, and every field clamped: this is the only
// externally supplied text that reaches the database.
function normalize(provider, profile, email) {
  const subject = text(profile.sub ?? profile.id, 64);
  if (!subject) throw new Error('The provider returned a profile with no account id.');
  const login = text(profile.login || text(email, 320).split('@')[0], 64);
  return {
    provider,
    subject,
    email: text(email, 320).toLowerCase(),
    login,
    name: text(profile.name || profile.login, 120),
    // Only ever an https URL shown as an avatar; stored, never fetched by us.
    avatar: /^https:\/\/\S{1,480}$/.test(String(profile.avatar_url || profile.picture || ''))
      ? String(profile.avatar_url || profile.picture)
      : ''
  };
}

export async function exchange(provider, { code, codeVerifier }) {
  const { clientId, clientSecret } = credentialsFor(provider);
  const token = await postForm(url(provider, 'token'), {
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(provider),
    ...(provider === 'google' ? { code_verifier: codeVerifier } : {})
  });
  const accessToken = text(token.access_token, 512);
  if (!accessToken) throw new Error('The provider returned no access token.');

  const profile = await getJson(url(provider, 'profile'), accessToken);

  let email = '';
  if (provider === 'google') {
    // An unverified address is somebody else's address one day later, and this
    // one is the only thing the account is ever described by.
    email = profile.email_verified === true ? text(profile.email, 320) : '';
  } else {
    email = text(profile.email, 320);
    if (!email) {
      // GitHub hides the address unless it was made public on the profile, so
      // ask for the verified list and take the primary one.
      const list = await getJson(url(provider, 'emails'), accessToken);
      const rows = Array.isArray(list) ? list : [];
      const chosen = rows.find((row) => row.primary && row.verified) || rows.find((row) => row.verified);
      email = text(chosen && chosen.email, 320);
    }
  }
  return normalize(provider, profile, email);
}

export function providerLabel(provider) {
  return PROVIDERS[provider] ? PROVIDERS[provider].label : provider;
}
