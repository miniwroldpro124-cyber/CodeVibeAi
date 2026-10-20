// Builds .ship/ — the only folder that is ever safe to drag into GitHub's
// "Add files via upload". That upload ignores .gitignore completely, so the
// repository picked up data/devchat.db and data/master.key, which together
// decrypt every user's stored API key. A whitelist is the fix: nothing is
// copied unless it is listed here, so a secret has to be added to this file on
// purpose before it can leak.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.ship');

// Exact root entries, or directories whose listed sub-entries are copied.
const INCLUDE = [
  'server.js',
  'package.json',
  'vercel.json',
  'README.md',
  'SECURITY.md',
  '.env.example',
  '.gitignore',
  '.dockerignore',
  '.gitleaks.toml',
  'Dockerfile',
  'docker-compose.yml',
  'LICENSE',
  '.github/workflows',
  'api',
  'lib',
  'scripts',
  '.smoketest',
  'public',
];

// Kept out even if a parent directory is whitelisted. A self-signed test key and
// a live database have the same problem: they are runtime state, not source.
const EXCLUDE = [
  /(^|\/)\.env$/,
  /(^|\/)\.env\.(?!example)/,
  /(^|\/)data\//,
  /(^|\/)node_modules\//,
  /(^|\/)\.git\//,
  /(^|\/)\.ship\//,
  /(^|\/)\.audit\//,
  /\.log$/i,
  /\.lnk$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.db(-shm|-wal)?$/i,
  /\.sqlite$/i,
  /(^|\/)\.DS_Store$/,
];

const excluded = [];
const copied = [];

// Any real-looking sk- in a file that is about to be published stops the build.
// Test fixtures are allowed to look like keys, so only an exact repeat of one
// key across two files, or a key longer than the fixtures, is treated here as a
// report rather than a guess; the report is a path, never the value.
const suspicious = [];

function isExcluded(rel) {
  return EXCLUDE.some((re) => re.test(rel));
}

function walk(abs, rel, out) {
  if (isExcluded(rel)) {
    excluded.push(rel);
    return;
  }
  const st = statSync(abs);
  if (st.isDirectory()) {
    for (const name of readdirSync(abs)) walk(join(abs, name), `${rel}/${name}`, out);
    return;
  }
  if (st.isFile()) out.push({ abs, rel });
}

function collect() {
  const files = [];
  for (const entry of INCLUDE) {
    const abs = join(ROOT, entry);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) {
      // Whitelisted directories are still filtered entry by entry, so a stray
      // data/ inside one of them cannot ride along.
      for (const name of readdirSync(abs)) walk(join(abs, name), `${entry}/${name}`, files);
    } else {
      walk(abs, entry, files);
    }
  }
  return files;
}

function scanForSecrets(files) {
  for (const { abs, rel } of files) {
    if (!/\.(js|mjs|cjs|json|md|html|css|txt|ya?ml|example)$/i.test(rel)) continue;
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(/sk-[A-Za-z0-9]{28,}/g)) {
      if (/^sk-(super-secret|hostedsm|migrated|not_a_real)/i.test(match[0])) continue;
      suspicious.push(rel);
      break;
    }
  }
}

const files = collect();
scanForSecrets(files);

if (suspicious.length) {
  console.error('\n  Refusing to build the upload folder. These files hold a key that');
  console.error('  looks real, not a test fixture:');
  for (const rel of suspicious) console.error(`    ${rel}`);
  console.error('  Remove the key, then run this again.\n');
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const { abs, rel } of files) {
  const dest = join(OUT, rel);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(abs, dest);
  copied.push(rel);
}

console.log(`\n  ${copied.length} files staged in .ship/ — this is what you drag into GitHub.\n`);
for (const rel of copied.slice(0, Number(process.env.SHIP_VERBOSE ? 1e9 : 40))) console.log(`    ${rel}`);
if (!process.env.SHIP_VERBOSE && copied.length > 40) console.log(`    … ${copied.length - 40} more (SHIP_VERBOSE=1 to list)`);
if (excluded.length) {
  console.log('\n  Kept out on purpose:');
  for (const rel of [...new Set(excluded)].slice(0, 12)) console.log(`    ${rel}`);
}
console.log('\n  Missing from the whitelist? Add it to INCLUDE in scripts/ship.mjs first.');
console.log('  Never drag the project root itself into the upload page.\n');
