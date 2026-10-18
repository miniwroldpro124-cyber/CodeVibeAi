import { randomBytes, randomInt } from 'node:crypto';
import { HttpError } from './http.js';

// Persistent brute-force defence for sign-in. The in-memory limiter in http.js
// resets on restart and only covers one process, so an attacker who waits (or a
// server restart) gets a fresh budget. This lives in SQLite instead.
//
// Thresholds are deliberately harsher for admins: the admin account can change
// everyone's role, reset anyone's password and edit pricing, so it is the one
// account worth locking out early even at the cost of a self-inflicted lock
// (which `npm run admin -- --unlock <name>` clears in seconds).
const GUARD_STEPS = {
  admin: [
    { fails: 5, minutes: 15 },
    { fails: 8, minutes: 60 },
    { fails: 12, minutes: 360 }
  ],
  user: [
    { fails: 10, minutes: 10 },
    { fails: 25, minutes: 60 }
  ]
};

// The same numbers, shaped for the admin panel to display.
export const GUARD_POLICY = {
  admin: GUARD_STEPS.admin.map((s) => ({ ...s })),
  user: GUARD_STEPS.user.map((s) => ({ ...s }))
};

export const ADMIN_MIN_PASSWORD = 12;
export const USER_MIN_PASSWORD = 8;
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function accountKey(username) {
  return `user:${String(username).toLowerCase()}`;
}

export function passwordProblem({ role, username, password: raw }) {
  const password = String(raw || '');
  const min = role === 'admin' ? ADMIN_MIN_PASSWORD : USER_MIN_PASSWORD;
  if (password.length < min) {
    return role === 'admin'
      ? `Admin passwords must be at least ${min} characters.`
      : `Password must be at least ${min} characters.`;
  }
  if (password.length > 200) return 'Password must be under 200 characters.';
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must contain at least one letter and one number.';
  }
  // Compared with punctuation and case stripped. Only for usernames of six or
  // more characters: "admin" and "root" are generic role words that the obvious
  // list below already covers, and refusing them as a substring would reject
  // good passwords like "Admin2026portal".
  const user = String(username || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const flat = password.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (user.length >= 6 && flat.includes(user)) {
    return 'Password must not contain the username.';
  }
  if (role === 'admin' && /^(admin|root|administrator|password|123456789012|qwertyuiop12)$/.test(password.toLowerCase())) {
    return 'That password is on the obvious list. Pick something harder.';
  }
  return null;
}

export function lockMinutes(role, fails) {
  const steps = GUARD_STEPS[role === 'admin' ? 'admin' : 'user'];
  let minutes = 0;
  for (const step of steps) if (fails >= step.fails) minutes = step.minutes;
  return minutes;
}

export function nextAttemptWarning(role, fails) {
  const steps = GUARD_STEPS[role === 'admin' ? 'admin' : 'user'];
  const next = steps.find((step) => step.fails > fails);
  if (!next) return null;
  return { attemptsLeft: next.fails - fails, lockMinutes: next.minutes };
}

// A locked row must block the password check itself, not just the response, so
// that scrypt work cannot be used as a cheap rate-limit amplifier.
export async function assertUnlocked(store, key, role, username) {
  const row = await store.getLoginGuard(key);
  if (!row || row.locked_until <= Date.now()) return;
  const retryAfter = Math.ceil((row.locked_until - Date.now()) / 1000);
  const err = new HttpError(429, lockedMessage(role, username, retryAfter));
  err.retryAfter = retryAfter;
  throw err;
}

export function lockedMessage(role, username, retryAfter) {
  const mins = Math.max(1, Math.round(retryAfter / 60));
  const who = role === 'admin' ? 'Administrator account' : 'Account';
  return `${who} "${username}" is temporarily locked after too many failed sign-ins. Try again in ${mins} min, or ask an admin to unlock it.`;
}

export async function noteFailure(store, user, ip) {
  const key = accountKey(user.username);
  const before = await store.getLoginGuard(key);
  const fails = (before?.fails || 0) + 1;
  const minutes = lockMinutes(user.role, fails);
  const lockedUntil = minutes ? Date.now() + minutes * 60_000 : 0;
  await store.setUpLoginGuard(key, { fails, lockedUntil });
  await store.logAuthEvent({
    username: user.username,
    kind: minutes ? 'admin_locked' : 'login_fail',
    ip,
    detail: `${fails} failed · role ${user.role}${minutes ? ` · locked ${minutes} min` : ''}`
  });
  return { fails, minutes, lockedUntil };
}

export async function noteSuccess(store, user, ip) {
  await store.clearLoginGuard(accountKey(user.username));
  await store.logAuthEvent({ username: user.username, kind: 'login_ok', ip, detail: `role ${user.role}` });
}

export async function unlockAccount(store, username) {
  const removed = await store.clearLoginGuard(accountKey(username));
  await store.logAuthEvent({ username, kind: 'unlocked', ip: null, detail: 'login lock cleared' });
  return removed;
}

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';

function pick(alphabet) {
  return alphabet[randomInt(alphabet.length)];
}

// Built so it always passes passwordProblem(): long enough, a letter and a digit,
// never the username. Ambiguous glyphs (O/0, I/1/l) are left out because this is
// printed once in a terminal and meant to be retyped.
export function randomAdminPassword(username = '') {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const chars = [];
    for (let i = 0; i < 14; i += 1) chars.push(pick(LETTERS));
    for (let i = 0; i < 6; i += 1) chars.push(pick(DIGITS));
    for (let i = chars.length - 1; i > 0; i -= 1) {
      const j = randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    const password = chars.join('');
    if (!passwordProblem({ role: 'admin', username, password })) return password;
  }
  return `${randomBytes(12).toString('base64url')}7x`;
}

export function isStrongAdminPassword(username, password) {
  return passwordProblem({ role: 'admin', username, password }) === null;
}
