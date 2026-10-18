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

const { loadEnv } = await lib('env.js');
loadEnv(ROOT);

const { Store, DB_FILE } = await lib('db.js');
const { hashPassword } = await lib('auth.js');
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

  Options: --write-env (store the new admin password in .env), --json, --help
`;

const args = process.argv.slice(2);

// Boolean switches are removed from the word list; everything else keeps its
// dashes, so a password that happens to start with "--" is still a word.
const BOOLEAN_FLAGS = new Set(['--json', '--write-env', '--create']);
const flags = new Set(args.filter((a) => BOOLEAN_FLAGS.has(a)));
const words = args.filter((a) => !BOOLEAN_FLAGS.has(a));

const cmd = String(words[0] || 'info').replace(/^--/, '');
const name = words[1];
const extra = words[2];
const store = openStore();

try {
  switch (cmd) {
    case 'info':
      info();
      break;
    case 'help':
      console.log(HELP);
      break;
    case 'list':
      list();
      break;
    case 'reset':
      reset();
      break;
    case 'promote':
      promote();
      break;
    case 'demote':
      demote();
      break;
    case 'unlock':
      unlock();
      break;
    case 'status':
      setStatus();
      break;
    case 'markup':
      markup();
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

function openStore() {
  if (!existsSync(DB_FILE)) {
    fail(
      `No database yet at ${DB_FILE}.\n` +
        '  Start the server once ("npm start") and the administrator account is created for you.'
    );
  }
  try {
    return new Store();
  } catch (err) {
    fail(`Could not open ${DB_FILE}: ${err.message}`);
  }
}

function requireName(what) {
  if (!name) fail(`--${what} needs a username, e.g. npm run admin -- --${what} admin`);
  const user = store.getUserByName(name);
  if (!user) fail(`No account named "${name}". Use npm run admin -- --list to see them.`);
  return user;
}

function signUrl() {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT) || 5173;
  return `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
}

function lockState(username) {
  const row = store.getLoginGuard(`user:${String(username).toLowerCase()}`);
  if (!row || !row.fails) return null;
  return {
    fails: row.fails,
    minutesLeft: row.locked_until > Date.now() ? Math.ceil((row.locked_until - Date.now()) / 60000) : 0
  };
}

function info() {
  const admins = store.listUsers().filter((u) => u.role === 'admin');

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
    const lock = lockState(a.username);
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

function list() {
  const rows = store.listUsers();
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
    const lock = lockState(u.username);
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
      ` · markup ${store.getMarkupPercent()}% · database ${DB_FILE}`
  );
  console.log('');
}

function reset() {
  const user = requireName('reset');
  const provided = extra;
  const problem = provided
    ? guard.passwordProblem({ role: user.role, username: user.username, password: provided })
    : null;
  if (provided && problem) fail(`Refusing that password: ${problem}`);

  const password = provided || guard.randomAdminPassword(user.username);
  const { passHash, passSalt } = hashPassword(password);
  store.setUserPassword(user.id, passHash, passSalt);
  guard.unlockAccount(store, user.username);
  store.logAuthEvent({
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

function promote() {
  const user = name ? store.getUserByName(name) : null;
  if (!user) {
    if (!name) fail('Usage: npm run admin -- --promote <username> [--create] [password]');
    if (!flags.has('--create')) fail(`No account named "${name}". Add --create to make it as an admin.`);
    const password = extra || guard.randomAdminPassword(name);
    const problem = guard.passwordProblem({ role: 'admin', username: name, password });
    if (problem) fail(`Refusing that password: ${problem}`);
    const { passHash, passSalt } = hashPassword(password);
    store.createUser({ username: name, passHash, passSalt, role: 'admin' });
    store.logAuthEvent({ username: name, kind: 'admin_role', ip: null, detail: 'created as admin by CLI' });
    console.log(`\n  Created "${name}" as administrator.`);
    console.log(`  Password (shown once): ${password}\n`);
    return;
  }
  if (user.role === 'admin') {
    console.log(`\n  "${user.username}" is already an administrator.\n`);
    return;
  }
  store.setUserRole(user.id, 'admin');
  store.setUserStatus(user.id, 'active');
  store.logAuthEvent({ username: user.username, kind: 'admin_role', ip: null, detail: '→ admin by CLI' });
  console.log(`\n  "${user.username}" is now an administrator.`);
  console.log(`  Sign out and back in for the role to take effect in the browser.`);
  console.log(`  Panel: ${signUrl()}/admin.html\n`);
}

function demote() {
  const user = requireName('demote');
  if (user.role !== 'admin') {
    console.log(`\n  "${user.username}" is already a normal user.\n`);
    return;
  }
  const others = store
    .listUsers()
    .filter((u) => u.role === 'admin' && u.status === 'active' && u.id !== user.id);
  if (!others.length) {
    fail(
      `"${user.username}" is the last active administrator, so demoting it would lock everyone out.\n` +
        '  Promote a replacement first:  npm run admin -- --promote <other-name>'
    );
  }
  store.setUserRole(user.id, 'user');
  store.deleteUserSessions(user.id);
  store.logAuthEvent({ username: user.username, kind: 'admin_role', ip: null, detail: '→ user by CLI' });
  console.log(`\n  "${user.username}" is now a normal user and was signed out.\n`);
}

function unlock() {
  const user = requireName('unlock');
  const removed = guard.unlockAccount(store, user.username);
  console.log(
    removed
      ? `\n  Sign-in lock for "${user.username}" cleared and the failed-attempt count reset.\n`
      : `\n  "${user.username}" has no failed-sign-in counter to clear.\n`
  );
}

function setStatus() {
  const user = requireName('status');
  if (!['active', 'disabled'].includes(extra)) fail('Usage: npm run admin -- --status <name> active|disabled');
  if (user.role === 'admin' && extra === 'disabled') {
    const others = store
      .listUsers()
      .filter((u) => u.role === 'admin' && u.status === 'active' && u.id !== user.id);
    if (!others.length) fail(`Refusing to disable "${user.username}": it is the last active administrator.`);
  }
  store.setUserStatus(user.id, extra);
  if (extra === 'disabled') store.deleteUserSessions(user.id);
  store.logAuthEvent({ username: user.username, kind: 'admin_status', ip: null, detail: `${extra} by CLI` });
  console.log(`\n  "${user.username}" is ${extra}.${extra === 'disabled' ? ' Its sessions were removed.' : ''}\n`);
}

function markup() {
  if (extra === undefined) fail('Usage: npm run admin -- --markup <percent>');
  try {
    store.setMarkupPercent(extra);
  } catch (err) {
    fail(err.message);
  }
  store.logAuthEvent({ username: null, kind: 'admin_markup', ip: null, detail: `markup → ${store.getMarkupPercent()}% by CLI` });
  console.log(`\n  Markup is now ${store.getMarkupPercent()}%. Reload the admin panel or the calculator to see it.\n`);
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
