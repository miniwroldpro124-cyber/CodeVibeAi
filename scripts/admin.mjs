#!/usr/bin/env node
// DevChat administrator recovery. Run it with no arguments to find out who the
// admin is; use --reset when the password is lost.
//
//   npm run admin
//   npm run admin -- --list
//   npm run admin -- --reset admin
//   npm run admin -- --promote someone
//   npm run admin -- --unlock admin
//
// It opens the same SQLite file as the server, so it works while DevChat is
// running. Writes wait up to 5 seconds for the server's lock (PRAGMA busy_timeout).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Windows rejects a bare "C:\…" specifier in dynamic import(), so every lib
// import goes through a file:// URL. They are dynamic because lib/db.js reads
// DATA_DIR from the environment when the module is first evaluated.
const lib = (name) => import(pathToFileURL(join(ROOT, 'lib', name)).href);

const { hostedConfigured, loadEnv } = await lib('env.js');
loadEnv(ROOT);

const { Store, DB_FILE } = await lib('db.js');
const { hashPassword, MASTER_KEY_FILE, encryptApiKey, decryptApiKey, currentKeyLabel, readableKeyLabels, keyContext, maskKey } = await lib('auth.js');
const guard = await lib('guard.js');
const { GUARD_POLICY } = guard;

const HELP = `
  DevChat admin recovery

  npm run admin                          who is the administrator, and how to sign in
  npm run admin -- --list                every account, with role, lock and key state
  npm run admin -- --reset <name> [pw]   new password (generated if you omit it)
  npm run admin -- --promote <name>      make an account an administrator (--create to make it)
  npm run admin -- --demote <name>       take administrator rights away
  npm run admin -- --unlock <name>       clear a failed-sign-in lock
  npm run admin -- --status <name> active|disabled
  npm run admin -- --markup <percent>    set the markup used by reports and the calculator
  npm run admin -- --print-master-key    show MASTER_KEY, needed before moving to a host with no disk
  npm run admin -- --rotate-master       what would be re-sealed under a new MASTER_KEY (--apply to do it)

  Options: --write-env (store the new admin password in .env), --json, --help
`;

const args = process.argv.slice(2);

// Boolean switches are removed from the word list; everything else keeps its
// dashes, so a password that happens to start with "--" is still a word.
const BOOLEAN_FLAGS = new Set(['--json', '--write-env', '--create', '--apply', '--dry-run']);
const flags = new Set(args.filter((a) => BOOLEAN_FLAGS.has(a)));
const words = args.filter((a) => !BOOLEAN_FLAGS.has(a));

const cmd = String(words[0] || 'info').replace(/^--/, '');
const name = words[1];
const extra = words[2];
const store = await openStore();

try {
  switch (cmd) {
    case 'info':
      await info();
      break;
    case 'help':
      console.log(HELP);
      break;
    case 'list':
      await list();
      break;
    case 'reset':
      await reset();
      break;
    case 'promote':
      await promote();
      break;
    case 'demote':
      await demote();
      break;
    case 'unlock':
      await unlock();
      break;
    case 'status':
      await setStatus();
      break;
    case 'markup':
      await markup();
      break;
    case 'print-master-key':
      printMasterKey();
      break;
    case 'rotate-master':
      await rotateMaster();
      break;
    default:
      fail(`Unknown command "${cmd}".${HELP}`);
  }
} catch (err) {
  if (err.code === 'SQLITE_BUSY' || /database is locked/i.test(err.message || '')) {
    fail('The database is busy — another write is in flight. Nothing was changed.');
  }
  fail(err.stack || String(err));
} finally {
  store.close?.();
}

async function openStore() {
  const hosted = hostedConfigured();
  if (!hosted && !existsSync(DB_FILE)) {
    fail(
      `No database yet at ${DB_FILE}.\n` +
        '  Start the server once ("npm start") and the administrator account is created for you.'
    );
  }
  try {
    return await Store.open();
  } catch (err) {
    fail(`Could not open ${hosted || DB_FILE}: ${err.message}`);
  }
}

async function requireName(what) {
  if (!name) fail(`--${what} needs a username, e.g. npm run admin -- --${what} admin`);
  const user = await store.getUserByName(name);
  if (!user) fail(`No account named "${name}". Use npm run admin -- --list to see them.`);
  return user;
}

function signUrl() {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT) || 5173;
  return `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
}

// The master key is what makes every stored sk- key readable. Moving the site to
// a host with no disk means putting this exact value in MASTER_KEY there, or
// every stored key becomes undecryptable and each user has to paste it again.
function printMasterKey() {
  let value = String(process.env.MASTER_KEY || '');
  let source = 'the MASTER_KEY environment variable';
  if (!value) {
    try {
      value = readFileSync(MASTER_KEY_FILE, 'utf8').trim();
      source = MASTER_KEY_FILE;
    } catch {
      fail(`No MASTER_KEY in the environment and no key file at ${MASTER_KEY_FILE}.`);
    }
  }
  console.log('');
  console.log(`  Read from ${source}. This decrypts every stored API key — treat it as a password.`);
  console.log('  Do not paste it into a chat, an issue, a screenshot or a file that gets committed.');
  console.log('');
  console.log(`    MASTER_KEY=${value}`);
  console.log('');
  console.log('  Put that value in the Vercel project environment (Settings → Environment Variables)');
  console.log('  and in .env on any other host, then restart. It must match exactly.');
  console.log('');
}

// Which master key a stored blob was sealed with, as printed inside the blob.
// "legacy" is the pre-versioning format, which carries no label at all.
function sealLabel(blob) {
  const parts = String(blob || '').split('.');
  if (parts[0] === 'v2' && parts.length === 5) return parts[1];
  if (parts[0] === 'v1' && parts.length === 4) return 'legacy';
  return 'unknown';
}

// Re-seals every stored sk- under the MASTER_KEY this process is using now.
//
// This is what makes a published master key revocable without asking every user
// to paste their key again: the previous value stays readable through
// MASTER_KEY_PREV only for the length of this pass, and once every row reports
// the new label the old key can be deleted for good.
//
// A dry run by default, because it rewrites the vault of every account. A row
// that cannot be decrypted is reported and left exactly as it is — this command
// never destroys a blob it could not read.
async function rotateMaster() {
  const apply = flags.has('--apply');
  const target = currentKeyLabel();
  const readable = readableKeyLabels();
  const rows = await store.listSealedKeys();

  console.log('');
  console.log(`  Vault key in use now : ${target}`);
  console.log(`  Keys readable        : ${readable.join(', ')}${readable.length > 1 ? ' (includes MASTER_KEY_PREV)' : ''}`);
  console.log(`  Accounts with a key  : ${rows.length}`);
  if (!readable.includes(target)) console.log('  !! The current key cannot read its own label. Check MASTER_KEY.');

  const counts = { current: 0, rewrite: 0, unreadable: 0, failed: 0 };
  const lines = [];
  for (const row of rows) {
    const label = sealLabel(row.sealed);
    if (label === target) {
      counts.current += 1;
      lines.push(`    ${String(row.id).padStart(3)}  ${row.username.padEnd(20)}  ${row.hint || ''}  ${label}  already current`);
      continue;
    }
    let plain = null;
    try {
      plain = decryptApiKey(row.sealed, keyContext(row.id));
    } catch {
      counts.unreadable += 1;
      lines.push(`    ${String(row.id).padStart(3)}  ${row.username.padEnd(20)}  ${row.hint || ''}  ${label}  NOT READABLE here`);
      continue;
    }
    if (!apply) {
      counts.rewrite += 1;
      lines.push(`    ${String(row.id).padStart(3)}  ${row.username.padEnd(20)}  ${row.hint || ''}  ${label}  would be re-sealed`);
      continue;
    }
    try {
      await store.setUserApiKey(row.id, encryptApiKey(plain, keyContext(row.id)), row.hint || maskKey(plain));
      counts.rewrite += 1;
      lines.push(`    ${String(row.id).padStart(3)}  ${row.username.padEnd(20)}  ${row.hint || ''}  ${label} → ${target}  re-sealed`);
    } catch {
      counts.failed += 1;
      lines.push(`    ${String(row.id).padStart(3)}  ${row.username.padEnd(20)}  ${row.hint || ''}  ${label}  WRITE FAILED, left as it was`);
    }
    plain = null;
  }

  for (const line of lines) console.log(line);
  console.log('');
  console.log(`  Already current: ${counts.current}   ${apply ? 're-sealed' : 'to re-seal'}: ${counts.rewrite}   unreadable: ${counts.unreadable}   write failures: ${counts.failed}`);

  if (counts.unreadable) {
    console.log('');
    console.log('  Some rows were sealed with a key this process cannot read. They were left');
    console.log('  untouched. Put that value in MASTER_KEY_PREV and run this again, or those');
    console.log('  accounts will have to paste their key again.');
    process.exitCode = 1;
  } else if (!apply) {
    console.log('');
    console.log('  Nothing was changed. Run it again with --apply to write the new seals.');
    console.log('    npm run admin -- --rotate-master --apply');
  } else if (counts.rewrite) {
    console.log('');
    console.log('  Every readable row is now under the current key. Remove MASTER_KEY_PREV from');
    console.log('  the environment and restart, so the old key stops being usable anywhere.');
  } else {
    console.log('');
    console.log('  Nothing to do: every stored key already uses the current master key.');
  }
  console.log('');
}

async function lockState(username) {
  const row = await store.getLoginGuard(`user:${String(username).toLowerCase()}`);
  if (!row || !row.fails) return null;
  return {
    fails: row.fails,
    minutesLeft: row.locked_until > Date.now() ? Math.ceil((row.locked_until - Date.now()) / 60000) : 0
  };
}

async function info() {
  const admins = (await store.listUsers()).filter((u) => u.role === 'admin');

  console.log('');
  if (!admins.length) {
    console.log('  There is no administrator account yet.');
    console.log('');
    console.log('    npm start                 creates one and prints its password once');
    console.log('    npm run admin -- --promote <name> --create [password]');
    console.log('                              makes a specific account the admin now');
    console.log('');
    return;
  }

  console.log('  Administrator accounts');
  console.log('  ' + '─'.repeat(72));
  for (const a of admins) {
    const lock = await lockState(a.username);
    console.log(
      `   ${a.username}  (${a.status})` +
        (lock?.minutesLeft ? `  LOCKED for ${lock.minutesLeft} min` : lock ? `  ${lock.fails} failed sign-in(s)` : '')
    );
    console.log(
      `     id ${a.id} · ${a.sessions} live session(s) · key ${a.api_key_hint || 'not set'} · last seen ${when(a.last_seen_at)}`
    );
  }

  const first = admins[0];
  console.log('');
  console.log(`  Sign in at  ${signUrl()}/          (or open ${signUrl()}/admin.html directly)`);
  console.log('  The password is the one printed in the console box when the server first');
  console.log('  started, or ADMIN_PASSWORD in .env if you set it.');
  console.log('');
  console.log('  Forgotten it? Reset it — this signs every browser out of that account:');
  console.log('');
  console.log(`    npm run admin -- --reset ${first.username}`);
  console.log('');
  console.log('  To keep one password across restarts, put it in .env (600 permissions):');
  console.log('');
  console.log(`    ADMIN_USERNAME=${first.username}`);
  console.log('    ADMIN_PASSWORD=your-strong-password');
  console.log('');
  console.log(`  Protection: admin sign-ins lock after ${policyText('admin')}.`);
  console.log(`  Clear a lock:  npm run admin -- --unlock ${first.username}`);
  console.log('');
}

function policyText(role) {
  return GUARD_POLICY[role].map((s) => `${s.fails} tries → ${s.minutes} min`).join(', ');
}

async function list() {
  const rows = await store.listUsers();
  if (flags.has('--json')) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const pad = (s, n) => String(s).padEnd(n);
  console.log('');
  console.log(
    `  ${pad('id', 5)}${pad('username', 22)}${pad('role', 7)}${pad('status', 10)}` +
      `${pad('reqs', 7)}${pad('billed ₫', 11)}${pad('key', 18)}lock / sessions`
  );
  console.log(`  ${'─'.repeat(100)}`);
  for (const u of rows) {
    const lock = await lockState(u.username);
    const lockText = lock?.minutesLeft
      ? `locked ${lock.minutesLeft}m`
      : lock
        ? `${lock.fails} failed`
        : '—';
    console.log(
      `  ${pad(u.id, 5)}${pad(u.username, 22)}${pad(u.role, 7)}${pad(u.status, 10)}` +
        `${pad(u.requests, 7)}${pad(Number(u.billed_cost).toFixed(2), 11)}` +
        `${pad(u.api_key_hint || 'not set', 18)}${lockText} / ${u.sessions}`
    );
  }
  console.log('');
  console.log(
    `  ${rows.length} account(s) · ${rows.filter((u) => u.role === 'admin').length} administrator(s)` +
      ` · markup ${await store.getMarkupPercent()}% · database ${store.location}`
  );
  console.log('');
}

async function reset() {
  const user = await requireName('reset');
  const provided = extra;
  const problem = provided
    ? guard.passwordProblem({ role: user.role, username: user.username, password: provided })
    : null;
  if (provided && problem) fail(`Refusing that password: ${problem}`);

  const password = provided || guard.randomAdminPassword(user.username);
  const { passHash, passSalt } = await hashPassword(password);
  await store.setUserPassword(user.id, passHash, passSalt);
  await guard.unlockAccount(store, user.username);
  await store.logAuthEvent({
    username: user.username,
    kind: 'cli_password_reset',
    ip: null,
    detail: `password reset for ${user.role} via CLI, sessions revoked`
  });

  console.log('');
  console.log(`  New password for "${user.username}" (${user.role}):`);
  console.log('');
  console.log(`    ${password}`);
  console.log('');
  console.log('  Every browser session of that account was signed out, and its failed-attempt');
  console.log('  counter was cleared. Admin sessions now last 12 hours.');

  if (flags.has('--write-env')) writeEnv(user.username, password);
}

async function promote() {
  const user = name ? await store.getUserByName(name) : null;
  if (!user) {
    if (!name) fail('Usage: npm run admin -- --promote <username> [--create] [password]');
    if (!flags.has('--create')) fail(`No account named "${name}". Add --create to make it as an admin.`);
    const password = extra || guard.randomAdminPassword(name);
    const problem = guard.passwordProblem({ role: 'admin', username: name, password });
    if (problem) fail(`Refusing that password: ${problem}`);
    const { passHash, passSalt } = await hashPassword(password);
    await store.createUser({ username: name, passHash, passSalt, role: 'admin' });
    await store.logAuthEvent({ username: name, kind: 'admin_role', ip: null, detail: 'created as admin by CLI' });
    console.log(`\n  Created "${name}" as administrator.`);
    console.log(`  Password (shown once): ${password}\n`);
    return;
  }
  if (user.role === 'admin') {
    console.log(`\n  "${user.username}" is already an administrator.\n`);
    return;
  }
  await store.setUserRole(user.id, 'admin');
  await store.setUserStatus(user.id, 'active');
  await store.logAuthEvent({ username: user.username, kind: 'admin_role', ip: null, detail: '→ admin by CLI' });
  console.log(`\n  "${user.username}" is now an administrator.`);
  console.log(`  Sign out and back in for the role to take effect in the browser.`);
  console.log(`  Panel: ${signUrl()}/admin.html\n`);
}

async function demote() {
  const user = await requireName('demote');
  if (user.role !== 'admin') {
    console.log(`\n  "${user.username}" is already a normal user.\n`);
    return;
  }
  const others = (await store.listUsers()).filter(
    (u) => u.role === 'admin' && u.status === 'active' && u.id !== user.id
  );
  if (!others.length) {
    fail(
      `"${user.username}" is the last active administrator, so demoting it would lock everyone out.\n` +
        '  Promote a replacement first:  npm run admin -- --promote <other-name>'
    );
  }
  await store.setUserRole(user.id, 'user');
  await store.deleteUserSessions(user.id);
  await store.logAuthEvent({ username: user.username, kind: 'admin_role', ip: null, detail: '→ user by CLI' });
  console.log(`\n  "${user.username}" is now a normal user and was signed out.\n`);
}

async function unlock() {
  const user = await requireName('unlock');
  const removed = await guard.unlockAccount(store, user.username);
  console.log(
    removed
      ? `\n  Sign-in lock for "${user.username}" cleared and the failed-attempt count reset.\n`
      : `\n  "${user.username}" has no failed-sign-in counter to clear.\n`
  );
}

async function setStatus() {
  const user = await requireName('status');
  if (!['active', 'disabled'].includes(extra)) fail('Usage: npm run admin -- --status <name> active|disabled');
  if (user.role === 'admin' && extra === 'disabled') {
    const others = (await store.listUsers()).filter(
      (u) => u.role === 'admin' && u.status === 'active' && u.id !== user.id
    );
    if (!others.length) fail(`Refusing to disable "${user.username}": it is the last active administrator.`);
  }
  await store.setUserStatus(user.id, extra);
  if (extra === 'disabled') await store.deleteUserSessions(user.id);
  await store.logAuthEvent({ username: user.username, kind: 'admin_status', ip: null, detail: `${extra} by CLI` });
  console.log(`\n  "${user.username}" is ${extra}.${extra === 'disabled' ? ' Its sessions were removed.' : ''}\n`);
}

async function markup() {
  if (extra === undefined) fail('Usage: npm run admin -- --markup <percent>');
  try {
    await store.setMarkupPercent(extra);
  } catch (err) {
    fail(err.message);
  }
  const percent = await store.getMarkupPercent();
  await store.logAuthEvent({ username: null, kind: 'admin_markup', ip: null, detail: `markup → ${percent}% by CLI` });
  console.log(`\n  Markup is now ${percent}%. Reload the admin panel or the calculator to see it.\n`);
}

// .env is the only place a plaintext password can sit, so it is created 600 and
// an existing file is edited in place rather than rewritten.
function writeEnv(username, password) {
  const file = join(ROOT, '.env');
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    raw = '';
  }
  const set = { ADMIN_USERNAME: username, ADMIN_PASSWORD: password };
  const seen = new Set();
  const out = raw
    .split(/\r?\n/)
    .map((line) => {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (!match || set[match[1]] === undefined) return line;
      seen.add(match[1]);
      return `${match[1]}=${set[match[1]]}`;
    });
  for (const [key, value] of Object.entries(set)) if (!seen.has(key)) out.push(`${key}=${value}`);
  writeFileSync(file, out.join('\n').replace(/\n+$/, '\n'), { mode: 0o600 });

  console.log('');
  console.log(`  Wrote ADMIN_USERNAME and ADMIN_PASSWORD to ${file}`);
  console.log('  Keep that file private — anyone who can read it can sign in as the administrator.');
  console.log('  While ADMIN_PASSWORD stays there, restarting always applies it, and a weak one is rotated.');
  console.log('');
}

function when(ts) {
  if (!ts) return 'never';
  return new Date(Number(ts)).toISOString().slice(0, 16).replace('T', ' ');
}

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}
