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
  // A .env holding the live TURSO_URL is precisely what a scratch run must not
  // inherit: loadEnv() fills in any variable the command line left unset, so
  // overriding DATA_DIR alone still opens the production database. This switch is
  // read here rather than in hostedConfigured() because the driver picks its
  // database by this function — one answer, and the guard and the store agree.
  if (String(process.env.DEVCHAT_LOCAL_DB || '').trim() === '1') return '';
  return firstEnv(URL_NAMES);
}

export function hostedToken() {
  if (String(process.env.DEVCHAT_LOCAL_DB || '').trim() === '1') return '';
  return firstEnv(TOKEN_NAMES);
}

export function hostedConfigured() {
  return hostedUrl() !== '';
}

// Variable names only, never values. An operator staring at a 503 needs to know
// whether the platform injected anything at all, because that is a different fix
// from injecting nothing. A name present but empty is not injected — reporting it
// would send someone looking for a value that is not there.
export function visibleTursoVars() {
  return Object.keys(process.env)
    .filter((name) => /^TURSO[A-Z0-9_]*$/.test(name) && String(process.env[name]).trim() !== '')
    .sort();
}

// Image models say so themselves in the public catalogue, but no video model does:
// the provider's own setup page names them and /v1/models omits them entirely, so
// the studio list has to come from configuration. These two are as documented.
const DEFAULT_VIDEO_MODELS = ['MiniMax-H3', 'MiniMax-H3-Max'];

// Dong per picture. Set to 0 in .env to offer every model the provider lists.
const DEFAULT_PICTURE_CEILING = 300;

export function videoModels() {
  const listed = String(process.env.VIDEO_MODELS || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return listed.length ? listed : DEFAULT_VIDEO_MODELS;
}

// The picture ceiling is a product rule, not a safety bound, so it belongs next to
// the other studio configuration and can be raised without touching the routes.
// The provider's list runs from 65 dong to 1800 dong for one image, and the studio
// is meant for everyday use on the user's own key — so anything at or above this
// ceiling is not offered, and refused if a client asks for it anyway.
export function pictureCeilingDong() {
  const raw = String(process.env.MAX_PICTURE_DONG || '').trim();
  // An empty line means "not set", the way every other line of .env.example reads.
  // Number('') is 0, and 0 means "no ceiling" — a blank would quietly put the
  // 1800 dong models back into the studio.
  if (!raw) return DEFAULT_PICTURE_CEILING;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_PICTURE_CEILING;
}
