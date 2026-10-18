#!/usr/bin/env node
// Copy a local data/devchat.db into a hosted database so the same accounts, the
// same encrypted keys and the same usage history keep working on a host with no
// disk.
//
//   npm run migrate:turso
//   npm run migrate:turso -- --dry-run     print what would happen, change nothing
//   npm run migrate:turso -- --force       write into a target that already has accounts
//
// The target should be an empty database: a partial copy into one that already
// has users produces ids that collide. Password hashes and encrypted key blobs
// travel unchanged, so the MASTER_KEY on the new host must be the one this
// machine already uses, or every stored sk- becomes unreadable:
//
//   npm run admin -- --print-master-key
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lib = (name) => import(pathToFileURL(join(ROOT, 'lib', name)).href);

const { loadEnv } = await lib('env.js');
loadEnv(ROOT);

const { Store, DB_FILE } = await lib('db.js');
const { createLocalDriver } = await lib('driver-local.js');
const { createTursoDriver } = await lib('driver-turso.js');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');

// Users first: every other table references it, and a per-request hosted
// connection cannot be told to defer foreign keys.
const TABLES = ['users', 'sessions', 'usage_log', 'settings', 'login_guard', 'auth_events'];
const CHUNK = 50;

const targetUrl = String(process.env.TURSO_URL || '').trim();
if (!targetUrl) fail('TURSO_URL is not set. Put the hosted database URL and token in .env first.');
if (!existsSync(DB_FILE)) fail(`No local database at ${DB_FILE} — nothing to copy.`);

const source = await createLocalDriver(DB_FILE);
const target = createTursoDriver({
  url: targetUrl,
  token: String(process.env.TURSO_TOKEN || '').trim(),
  timeoutMs: 30_000
});
const targetStore = new Store(target);
if (!dryRun) await targetStore.initSchema();

const existing = dryRun ? { n: 0 } : await target.get('SELECT COUNT(*) AS n FROM users');
if (Number(existing?.n) > 0 && !force) {
  await target.close();
  await source.close();
  fail(
    `The target already has ${existing.n} account(s). Refusing to mix them with this copy.\n` +
      '  Create an empty database, or pass --force to write anyway.'
  );
}

console.log('');
console.log(`  from  ${DB_FILE}`);
console.log(`  to    ${redact(targetUrl)}`);
if (dryRun) console.log('  mode  dry run — nothing is written');
console.log('');

let total = 0;
for (const table of TABLES) {
  const rows = await source.all(`SELECT * FROM ${table}`);
  if (!dryRun && rows.length) {
    const columns = Object.keys(rows[0]);
    const placeholders = columns.map(() => '?').join(', ');
    const sql = `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;
    // Chunked rather than one giant pipeline: the hosted API caps how many
    // statements a single request may carry.
    for (let i = 0; i < rows.length; i += CHUNK) {
      await target.batch(
        rows.slice(i, i + CHUNK).map((row) => ({ sql, params: columns.map((c) => normalise(row[c])) }))
      );
    }
  }
  total += rows.length;
  console.log(`  ${table.padEnd(12)} ${String(rows.length).padStart(5)} row(s)`);
}

if (!dryRun) {
  const markup = await targetStore.getMarkupPercent();
  const sample = await target.all('SELECT id, username, role, api_key_hint FROM users ORDER BY id LIMIT 5');
  console.log('');
  console.log(`  Copied ${total} row(s). Markup on the target: ${markup}%`);
  console.log(`  Accounts so far: ${sample.map((u) => `${u.username} (${u.role}${u.api_key_hint ? ', key set' : ', no key'})`).join(', ') || 'none'}`);
  console.log('');
  console.log('  Set TURSO_URL, TURSO_TOKEN and MASTER_KEY on the host, then sign in there.');
  console.log('  Keep this file as the backup until the hosted site is confirmed working.');
}
console.log('');

await target.close();
await source.close();

// Booleans and undefined are what node:sqlite refuses on the way in; the hosted
// driver needs a value it can assign a type to.
function normalise(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

// The token is sometimes carried inside the URL, and this output is pasted into
// issue trackers more often than anyone admits.
function redact(url) {
  return String(url).replace(/\/\/[^/@]*@/, '//');
}

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}
