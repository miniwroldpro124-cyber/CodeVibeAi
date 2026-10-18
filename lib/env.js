import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// One .env reader for the server and the CLI scripts, so `npm run admin` and
// `npm start` can never disagree about DATA_DIR or the port. Real environment
// variables always win over the file.
export function loadEnv(rootDir) {
  let raw = '';
  try {
    raw = readFileSync(join(rootDir, '.env'), 'utf8');
  } catch {
    return {};
  }

  const read = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^['"]|['"]$/g, '');
    read[match[1]] = value;
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
  return read;
}

// A hosted database arrives under one of several names: TURSO_URL is what this
// project's .env.example, README and Docker image use, while a database
// provisioned from the Vercel Marketplace is injected under the integration's
// own name. First non-empty wins, so one-click provisioning does not need a
// round of renaming in the dashboard.
const URL_NAMES = ['TURSO_URL', 'TURSO_DB_URL'];
const TOKEN_NAMES = ['TURSO_TOKEN', 'TURSO_DB_AUTH_TOKEN', 'TURSO_AUTH_TOKEN'];

function firstEnv(names) {
  for (const name of names) {
    const value = String(process.env[name] || '').trim();
    if (value) return value;
  }
  return '';
}

export function hostedUrl() {
  return firstEnv(URL_NAMES);
}

export function hostedToken() {
  return firstEnv(TOKEN_NAMES);
}

export function hostedConfigured() {
  return hostedUrl() !== '';
}

// Variable names only, never values. An operator staring at a 503 needs to know
// whether the platform injected anything at all, because that is a different fix
// from injecting nothing.
export function visibleTursoVars() {
  return Object.keys(process.env)
    .filter((name) => /^TURSO[A-Z0-9_]*$/.test(name))
    .sort();
}
