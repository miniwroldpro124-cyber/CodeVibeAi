import { argon2, createHash, randomBytes, scrypt, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DATA_DIR } from './db.js';
import { hostedConfigured, loadEnv } from './env.js';
import { accountKey, isStrongAdminPassword, passwordProblem, randomAdminPassword, unlockAccount } from './guard.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MASTER_KEY_FILE = join(DATA_DIR, 'master.key');

// ---------------------------------------------------------------- passwords

// Three encodings live in the same column, and each one says how it was made, so
// a hash is always checked at the cost it was created at:
//   a2id$<memoryKiB>$<passes>$<parallelism>$<nonce>$<tag>   current
//   sc1$<N>$<r>$<p>$<salt>$<digest>                         scrypt fallback
//   <128 hex> with a separate pass_salt column             legacy, N=16384
// The legacy form is still verified — accounts that exist today must not be
// locked out by a code change — and a successful sign-in rewrites it as a2id.
// Password hashes of the three accounts in the published data/devchat.db are
// offline-crackable at N=16384, which is why the upgrade is not optional.
const LEGACY_SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const LEGACY_HEX = /^[0-9a-f]{128}$/i;

// OWASP's Argon2id floor: 19 MiB of memory, two passes, one lane. Measured here
// at ~36 ms, which is cheaper than the 2^14 scrypt it replaces.
const ARGON2 = { algorithm: 'argon2id', memory: 19456, passes: 2, parallelism: 1, tagLength: 32 };

// Only reached when this runtime has no crypto.argon2 — the API landed in Node
// 24.7 and a hosted runtime is whatever the platform happens to pin. 2^17 is
// scrypt's OWASP floor; it costs ~430 ms, so it is the fallback, not the plan.
const SCRYPT_NOW = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

const argon2Async = typeof argon2 === 'function' ? promisify(argon2) : null;
const scryptAsync = promisify(scrypt);

export function hashBackend() {
  return argon2Async ? 'argon2id' : 'scrypt';
}

// One hash at these settings holds ~19 MiB for tens of milliseconds, so an
// endpoint that starts a hash per request turns a request rate into a memory
// bill. The queue is the limit: extra attempts wait instead of arriving at the
// thread pool all at once.
const MAX_CONCURRENT_HASHES = Math.min(8, Math.max(1, Number(process.env.HASH_CONCURRENCY) || 3));
let hashInFlight = 0;
const hashWaiting = [];

function hashSlot() {
  if (hashInFlight < MAX_CONCURRENT_HASHES) {
    hashInFlight += 1;
  } else {
    let begin;
    const gate = new Promise((resolve) => { begin = resolve; });
    hashWaiting.push(begin);
    return gate.then(() => {
      hashInFlight += 1;
      return () => {
        hashInFlight -= 1;
        const next = hashWaiting.shift();
        if (next) next();
      };
    });
  }
  return Promise.resolve(() => {
    hashInFlight -= 1;
    const next = hashWaiting.shift();
    if (next) next();
  });
}

async function withHashSlot(fn) {
  const release = await hashSlot();
  try {
    return await fn();
  } finally {
    release();
  }
}

function encodeArgon2(nonce, tag, params = ARGON2) {
  return `a2id$${params.memory}$${params.passes}$${params.parallelism}$${nonce.toString('base64url')}$${tag.toString('base64url')}`;
}

function encodeScrypt(salt, digest, params = SCRYPT_NOW) {
  return `sc1$${params.N}$${params.r}$${params.p}$${salt.toString('base64url')}$${digest.toString('base64url')}`;
}

function argon2Tag(password, nonce, params) {
  return argon2Async(ARGON2.algorithm, {
    message: String(password),
    nonce,
    memory: params.memory,
    passes: params.passes,
    parallelism: params.parallelism,
    tagLength: params.tagLength
  });
}

// The salt now travels inside pass_hash, so pass_salt is written empty for new
// rows and only read for legacy ones.
export async function hashPassword(password, unusedSalt) {
  void unusedSalt;
  const plain = String(password);
  if (argon2Async) {
    const nonce = randomBytes(16);
    const tag = await withHashSlot(() => argon2Tag(plain, nonce, ARGON2));
    return { passHash: encodeArgon2(nonce, tag), passSalt: '' };
  }
  const salt = randomBytes(16);
  const digest = await withHashSlot(() => scryptAsync(plain, salt, 64, SCRYPT_NOW));
  return { passHash: encodeScrypt(salt, digest), passSalt: '' };
}

export async function verifyPassword(password, passHash, passSalt) {
  const plain = String(password);
  const stored = String(passHash || '');
  if (!stored) return false;

  if (stored.startsWith('a2id$')) {
    const [, memory, passes, parallelism, nonceB64, tagB64] = stored.split('$');
    const expected = Buffer.from(tagB64 || '', 'base64url');
    if (!argon2Async || !expected.length) return false;
    const tag = await withHashSlot(() => argon2Tag(plain, Buffer.from(nonceB64 || '', 'base64url'), {
      memory: Number(memory) || ARGON2.memory,
      passes: Number(passes) || ARGON2.passes,
      parallelism: Number(parallelism) || ARGON2.parallelism,
      tagLength: expected.length
    }));
    return tag.length === expected.length && timingSafeEqual(tag, expected);
  }

  if (stored.startsWith('sc1$')) {
    const [, n, r, p, saltB64, digestB64] = stored.split('$');
    const expected = Buffer.from(digestB64 || '', 'base64url');
    if (!expected.length) return false;
    const candidate = await withHashSlot(() => scryptAsync(plain, Buffer.from(saltB64 || '', 'base64url'), expected.length, {
      N: Number(n) || SCRYPT_NOW.N,
      r: Number(r) || SCRYPT_NOW.r,
      p: Number(p) || SCRYPT_NOW.p,
      maxmem: SCRYPT_NOW.maxmem
    }));
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }

  if (LEGACY_HEX.test(stored) && passSalt) {
    // scryptSync stays here on purpose: this branch only ever runs for the few
    // rows that have not signed in since the upgrade, and it must keep working
    // even on a runtime where the async path has changed under it.
    const candidate = scryptSync(plain, String(passSalt), 64, LEGACY_SCRYPT);
    const expected = Buffer.from(stored, 'hex');
    // timingSafeEqual throws on a length mismatch, and a corrupt row must not
    // turn into a 500 that leaks the fact that the account exists.
    if (candidate.length !== expected.length) return false;
    return timingSafeEqual(candidate, expected);
  }

  return false;
}

// What a stored hash is protected by, so the login path knows whether to pay for
// a rewrite. 'unknown' is treated as needing one, and verifyPassword already
// returns false for it, so a garbage column cannot loop the upgrade.
export function hashStrength(passHash) {
  const stored = String(passHash || '');
  if (stored.startsWith('a2id$')) return 'argon2id';
  if (stored.startsWith('sc1$')) return 'scrypt';
  if (LEGACY_HEX.test(stored)) return 'legacy';
  return 'unknown';
}

export function needsRehash(passHash) {
  return hashStrength(passHash) !== hashBackend();
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
  // A hosted database has no disk behind this process. Writing a fresh key here
  // would look like a successful boot and quietly make every stored API key
  // undecryptable, one instance at a time, so it has to be a startup failure.
  // hostedConfigured() is the same name list the driver picks with, so a database
  // injected under an alias cannot slip past this guard.
  if (hostedConfigured()) {
    throw new Error(
      'MASTER_KEY is required when the database is hosted. Copy it from the machine that '
        + 'created the accounts: npm run admin -- --print-master-key'
    );
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

// Resolve the vault key while the process is starting rather than at the first
// saved sk-. A host that is missing MASTER_KEY otherwise passes its health check
// and then answers "Internal server error" the moment somebody pastes a key,
// because the route masks an unexpected throw.
export function assertMasterKey() {
  key();
}

// A short label for one master key: the first eight hex digits of its SHA-256.
// It travels inside every sealed blob, so a stored key always states which key
// sealed it. That is the key version — it is what lets rotation be a
// re-encryption pass instead of a guess about what the old value was, and a
// digest of the key says nothing about the key itself.
function keyLabel(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 8);
}

function decodeKey(value, name) {
  const buf = Buffer.from(String(value).trim(), 'base64');
  if (buf.length !== 32) throw new Error(`${name} must be 32 bytes of base64`);
  return buf;
}

// Every key this instance may read with: the current one, plus MASTER_KEY_PREV
// for exactly as long as rows sealed with the previous key remain in the
// database. Keeping the old key is only dangerous if it is kept forever, so the
// rotation pass exists to make it deletable.
let ring = null;
function keyring() {
  if (ring) return ring;
  const map = new Map();
  const prev = process.env.MASTER_KEY_PREV;
  if (prev) {
    const buf = decodeKey(prev, 'MASTER_KEY_PREV');
    map.set(keyLabel(buf), buf);
  }
  const current = key();
  map.set(keyLabel(current), current);
  ring = map;
  return ring;
}

export function currentKeyLabel() {
  return keyLabel(key());
}

export function readableKeyLabels() {
  return [...keyring().keys()];
}

function seal(buf, plain, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', buf, iv);
  if (aad) cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `v2.${keyLabel(buf)}.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
}

function open(buf, ivPart, tagPart, ctPart, aad) {
  const decipher = createDecipheriv('aes-256-gcm', buf, Buffer.from(ivPart, 'base64url'));
  if (aad) decipher.setAAD(Buffer.from(String(aad), 'utf8'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctPart, 'base64url')), decipher.final()]).toString('utf8');
}

// AES-256-GCM: the auth tag means a tampered or truncated blob fails loudly
// instead of decrypting into a plausible-looking wrong key.
//
// aad binds the ciphertext to one row — the account id is what the vault passes —
// so a blob copied onto somebody else's row does not decrypt, and a partial
// database dump is not a list of usable keys.
export function encryptApiKey(plain, aad) {
  return seal(key(), plain, aad);
}

export function decryptApiKey(blob, aad) {
  const parts = String(blob).split('.');
  if (parts[0] === 'v2' && parts.length === 5) {
    const buf = keyring().get(parts[1]);
    if (!buf) {
      throw new Error(
        `This key was sealed with master key ${parts[1]}, which is not available here. `
        + 'Set MASTER_KEY_PREV to the value that was in use when it was saved, then run the rotation.'
      );
    }
    return open(buf, parts[2], parts[3], parts[4], aad);
  }
  if (parts[0] === 'v1' && parts.length === 4) {
    // Written before key versioning, so no label and no bound account: every key
    // this instance can read is tried until a tag agrees. A wrong guess can only
    // ever throw, never produce a plausible key.
    let lastError = null;
    for (const buf of keyring().values()) {
      try {
        return open(buf, parts[1], parts[2], parts[3]);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('Stored key could not be decrypted');
  }
  throw new Error('Stored key is not in a recognised format');
}

// A row still in the pre-versioning format. Reading one is the moment to rewrite
// it, because that is the only time its plaintext is in hand.
export function isLegacySeal(blob) {
  return String(blob || '').startsWith('v1.');
}

// The additional-authenticated-data string for one account's key. Defined here so
// the save path, the read path and the rotation pass all bind it identically.
export function keyContext(id) {
  return `uid:${id}`;
}

// Only ever this masked form reaches the browser; the plaintext stays in the vault.
// The last four characters are enough to tell two keys apart, and everything before
// them is a prefix an attacker could use to confirm a guess, so none of it is shown.
export function maskKey(plain) {
  const s = String(plain || '').trim();
  if (!s) return '';
  const prefix = s.startsWith('sk-') ? 'sk-' : '';
  if (s.length < 12) return '•'.repeat(8);
  return `${prefix}${'•'.repeat(8)}${s.slice(-4)}`;
}

// The same box, for short-lived server state that has to survive a second
// instance of a serverless function — an OAuth handshake, which starts on one
// cold start and finishes on another. It is sealed under its own context string
// rather than an account id, so a stored sk- can never be read as a handshake
// and a handshake can never be read as a key.
export const STATE_CONTEXT = 'devchat-oauth-state';

export function sealState(value) {
  return encryptApiKey(value, STATE_CONTEXT);
}

export function openState(value) {
  return decryptApiKey(value, STATE_CONTEXT);
}


export function looksLikeApiKey(value) {
  const s = String(value || '').trim();
  return /^sk-[A-Za-z0-9_-]{16,}$/.test(s);
}

// ------------------------------------------------------------------ bootstrap

export async function bootstrapAdmin(store) {
  const username = String(process.env.ADMIN_USERNAME || 'admin').trim() || 'admin';
  const envPassword = String(process.env.ADMIN_PASSWORD || '');
  const fromFile = loadEnv(ROOT).ADMIN_PASSWORD === envPassword;
  const envSource = envPassword ? (fromFile ? '.env' : 'the environment') : null;

  const existing = await store.getUserByName(username);
  if (existing) {
    if (existing.role !== 'admin') await store.setUserRole(existing.id, 'admin');
    if (existing.status !== 'active') await store.setUserStatus(existing.id, 'active');
    // Without this, an account locked by failed sign-ins can never be signed into
    // from the browser again after a reboot, and the only fix would be the CLI.
    if (envPassword) {
      const row = await store.getLoginGuard(accountKey(existing.username));
      if (row && row.locked_until > Date.now()) {
        await unlockAccount(store, existing.username);
        console.log(`  Admin    : sign-in lock for "${username}" cleared using ADMIN_PASSWORD`);
      }
    }
    if (envPassword && !isStrongAdminPassword(username, envPassword)) {
      const rotated = randomAdminPassword(username);
      const { passHash, passSalt } = await hashPassword(rotated);
      await store.setUserPassword(existing.id, passHash, passSalt);
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
  const adminCount = await store.countAdmins();
  if (!envPassword && adminCount > 0) {
    console.log(`  Admin    : "${username}" does not exist; the administrator is one of the ${adminCount} existing admin account(s) — see "npm run admin"`);
    return { created: false, username: null, password: null };
  }
  const password = generated ? randomAdminPassword(username) : envPassword;
  const problem = passwordProblem({ role: 'admin', username, password });
  // A policy-failing ADMIN_PASSWORD must not abort the boot: the site is shared,
  // and a crash would take every other account down with it. Rotate instead.
  const usable = problem ? randomAdminPassword(username) : password;
  const { passHash, passSalt } = await hashPassword(usable);
  const id = await store.createUser({ username, passHash, passSalt, role: 'admin' });

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
