import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lib = (name) => import(pathToFileURL(join(ROOT, 'lib', name)).href);

const { loadEnv } = await lib('env.js');
loadEnv(ROOT);

const { Store } = await lib('db.js');

const apply = process.argv.includes('--apply');
const inactiveDays = Number(process.env.PRUNE_INACTIVE_DAYS || 7);
const dataDays = Number(process.env.PRUNE_DATA_DAYS || 3);

const store = await Store.open();
try {
  const result = await store.pruneInactiveUsers({ inactiveDays, dataDays, apply });
  console.log(JSON.stringify(result, null, 2));
  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to delete the listed data.');
  }
} finally {
  await store.close();
}
