import { createHash, randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './db.js';
import { loadEnv } from './env.js';
import { accountKey, isStrongAdminPassword, passwordProblem, randomAdminPassword, unlockAccount } from './guard.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MASTER_KEY_FILE = join(DATA_DIR, 'master.key');
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 64;

// ---------------------------------------------------------------- passwords

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(String(password), salt, KEY_LEN, SCRYPT_OPTS).toString('hex');
  return { passHash: hash, passSalt: salt };
}

export function verifyPassword(password, passHash, passSalt) {
  if (!passHash || !passSalt) return false;
  const candidate = scryptSync(String(password), passSalt, KEY_LEN, SCRYPT_OPTS);
  const expected = Buffer.from(passHash, 'hex');
  // timingSafeEqual throws on a length mismatch, and a corrupt row must not
  // turn into a 500 that leaks the fact that the account exists.
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

// --------------------------------------------------------------- sessions

export function newSessionToken() {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function bearerToken(req) {
  const match = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
  return match ? match[1] : null;
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      out[name] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

export function sessionCookie(token, maxAgeSeconds) {
  const parts = [`devchat_session=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  // A negative max-age clears the cookie; no Max-Age would make it a session
  // cookie that dies on browser exit, which feels like a broken login.
  parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  return parts.join('; ');
}

// ------------------------------------------------------------ api key vault

function loadMasterKey() {
  if (process.env.MASTER_KEY) {
    const buf = Buffer.from(process.env.MASTER_KEY, 'base64');
    if (buf.length !== 32) throw new Error('MASTER_KEY must be 32 bytes of base64');
    return buf;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(MASTER_KEY_FILE)) {
    const buf = Buffer.from(readFileSync(MASTER_KEY_FILE, 'utf8').trim(), 'base64');
    if (buf.length === 32) return buf;
    throw new Error(`${MASTER_KEY_FILE} does not contain 32 bytes; stored API keys cannot be decrypted.`);
  }
  const buf = randomBytes(32);
  writeFileSync(MASTER_KEY_FILE, buf.toString('base64'), { mode: 0o600 });
  // Windows ignores the mode bits, so tighten it explicitly where it matters.
  try {
    chmodSync(MASTER_KEY_FILE, 0o600);
  } catch {
    /* best effort */
  }
  return buf;
}

let masterKey = null;
function key() {
  if (!masterKey) masterKey = loadMasterKey();
  return masterKey;
}

// AES-256-GCM: the auth tag means a tampered or truncated blob fails loudly
// instead of decrypting into a plausible-looking wrong key.
export function encryptApiKey(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`;
}

export function decryptApiKey(blob) {
  const parts = String(blob).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Stored key is not in a recognised format');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(parts[1], 'base64url'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
}

// Only ever this masked form reaches the browser; the plaintext stays in the vault.
export function maskKey(plain) {
  const s = String(plain || '').trim();
  if (!s) return '';
  if (s.length <= 12) return `${s.slice(0, 2)}${'•'.repeat(6)}`;
  return `${s.slice(0, 6)}${'•'.repeat(6)}${s.slice(-4)}`;
}

export function looksLikeApiKey(value) {
  const s = String(value || '').trim();
  return /^sk-[A-Za-z0-9_-]{16,}$/.test(s);
}

// ------------------------------------------------------------------ bootstrap

export function bootstrapAdmin(store) {
  const username = String(process.env.ADMIN_USERNAME || 'admin').trim() || 'admin';
  const envPassword = String(process.env.ADMIN_PASSWORD || '');
  const fromFile = loadEnv(ROOT).ADMIN_PASSWORD === envPassword;
  const envSource = envPassword ? (fromFile ? '.env' : 'the environment') : null;

  const existing = store.getUserByName(username);
  if (existing) {
    if (existing.role !== 'admin') store.setUserRole(existing.id, 'admin');
    if (existing.status !== 'active') store.setUserStatus(existing.id, 'active');
    // Without this, an account locked by failed sign-ins can never be signed into
    // from the browser again after a reboot, and the only fix would be the CLI.
    if (envPassword) {
      const row = store.getLoginGuard(accountKey(existing.username));
      if (row && row.locked_until > Date.now()) {
        unlockAccount(store, existing.username);
        console.log(`  Admin    : sign-in lock for "${username}" cleared using ADMIN_PASSWORD`);
      }
    }
    if (envPassword && !isStrongAdminPassword(username, envPassword)) {
      const rotated = randomAdminPassword(username);
      const { passHash, passSalt } = hashPassword(rotated);
      store.setUserPassword(existing.id, passHash, passSalt);
      console.log('');
      console.log(`  !! ADMIN_PASSWORD in ${envSource} is too weak for an administrator (12+ chars, a letter and a number).`);
      console.log(`  !! "${username}" now signs in with a new password:`);
      console.log(`  !!   ${rotated}`);
      console.log('  !! Update or remove ADMIN_PASSWORD in .env so the next restart does not rotate it again.');
      console.log('');
      return { created: false, id: existing.id, username, password: rotated, rotated: true };
    }
    if (envPassword) {
      console.log(`  Admin    : "${username}" signs in with ADMIN_PASSWORD from ${envSource}`);
    }
    return { created: false, username: existing.username, password: null };
  }

  const generated = !envPassword;
  // If somebody renamed or promoted a different administrator, do not conjure a
  // second "admin" account into existence on every restart.
  if (!envPassword && store.countAdmins() > 0) {
    console.log(`  Admin    : "${username}" does not exist; the administrator is one of the ${store.countAdmins()} existing admin account(s) — see "npm run admin"`);
    return { created: false, username: null, password: null };
  }
  const password = generated ? randomAdminPassword(username) : envPassword;
  const problem = passwordProblem({ role: 'admin', username, password });
  // A policy-failing ADMIN_PASSWORD must not abort the boot: the site is shared,
  // and a crash would take every other account down with it. Rotate instead.
  const usable = problem ? randomAdminPassword(username) : password;
  const { passHash, passSalt } = hashPassword(usable);
  const id = store.createUser({ username, passHash, passSalt, role: 'admin' });

  console.log('');
  console.log('  ┌─ Administrator account ────────────────────────────────');
  console.log(`  │  username : ${username}`);
  console.log(`  │  password : ${usable}`);
  if (!generated && problem) console.log(`  │  ADMIN_PASSWORD was rejected: ${problem}`);
  else if (!generated) console.log(`  │  taken from ADMIN_PASSWORD in ${envSource}`);
  else console.log('  │  generated because ADMIN_PASSWORD is not set in .env');
  console.log('  │  This password is shown once. Sign in, then change it in Settings.');
  console.log('  │  Lost it?  npm run admin');
  console.log('  └────────────────────────────────────────────────────────');
  console.log('');
  return { created: true, id, username, password: usable, generated };
}

export { DATA_DIR, MASTER_KEY_FILE };
