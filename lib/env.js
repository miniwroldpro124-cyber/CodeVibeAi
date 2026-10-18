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
