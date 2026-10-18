#!/usr/bin/env node
// Start DevChat on this machine and tell you the URLs other devices can use.
//
//   npm run host                     listen on every interface (0.0.0.0)
//   npm run host -- --port 8080      a different port
//   npm run host -- --private        this computer only (what npm start does)
//   npm run host -- --firewall       open the Windows firewall port (asks for admin)
//
// This is a wrapper: it sets HOST/PORT, prints the reachability information, and
// then hands over to server.js so Ctrl+C, logs and exit codes stay normal.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lib = (name) => import(pathToFileURL(join(ROOT, 'lib', name)).href);

const { loadEnv } = await lib('env.js');
const fileEnv = loadEnv(ROOT);

const { reachableUrls, lanAddresses, windowsFirewallCommand } = await lib('net.js');

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

if (has('--help') || has('-h')) {
  console.log(`
  npm run host                      bind 0.0.0.0 so phones and other laptops can connect
  npm run host -- --port 8080       pick a port
  npm run host -- --host 192.168.1.20
                                    bind one interface only
  npm run host -- --private         stay on 127.0.0.1
  npm run host -- --firewall        add the Windows inbound rule (needs an admin terminal)
`);
  process.exit(0);
}

const PORT = Number(valueOf('--port', process.env.PORT || 5173)) || 5173;
const HOST = has('--private')
  ? '127.0.0.1'
  : valueOf('--host', process.env.HOST || '0.0.0.0');

process.env.PORT = String(PORT);
process.env.HOST = HOST;

if (!existsSync(join(ROOT, 'server.js'))) {
  console.error('  server.js is missing next to this script; run it from the project folder.');
  process.exit(1);
}

// An admin password in .env beats a generated one, because a generated password
// printed here would be lost the moment this terminal closes.
let announcedAdmin = null;
if (HOST !== '127.0.0.1' && !process.env.ADMIN_PASSWORD && !fileEnv.ADMIN_PASSWORD) {
  announcedAdmin = await ensureAdminPassword();
}

banner();
if (has('--firewall')) openFirewall(PORT);

const child = spawn(process.execPath, [join(ROOT, 'server.js')], {
  cwd: ROOT,
  stdio: 'inherit',
  env: process.env
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
child.on('exit', (code, signal) => process.exit(signal ? 0 : (code ?? 0)));

function banner() {
  const urls = reachableUrls(HOST, PORT);
  const netmaskNote = lanAddresses();

  console.log('');
  console.log(`  DevChat — hosting on this machine (port ${PORT})`);
  console.log('  ' + '─'.repeat(58));
  for (const url of urls.local) console.log(`   this computer      ${url}`);
  for (const item of urls.lan) console.log(`   other devices   ${item.url}   (${item.name})`);
  console.log('');
  console.log(`   admin panel        ${urls.local[0]}/admin.html`);
  console.log('');

  if (HOST === '127.0.0.1') {
    console.log('   Bound to 127.0.0.1: only this computer can connect.');
    console.log('   Drop --private (or run "npm run host") to share it on the network.');
  } else {
    console.log('   Anyone who can reach this machine can open the site, sign up, and use');
    console.log('   their own sk- key. Nothing of yours is spent by them, but your screen');
    console.log('   is not private on that network. Stop with Ctrl+C when you are done.');
    if (urls.lan.length) {
      console.log('');
      console.log('   Windows blocks inbound TCP by default. From an elevated terminal:');
      console.log(`     ${windowsFirewallCommand(PORT)}`);
      console.log('   Or re-run with --firewall to do it now.');
    } else {
      console.log('');
      console.log('   No LAN IPv4 adapter was found, so this machine may be offline or use');
      console.log('   one interface only; the localhost URL above still works.');
    }
  }

  if (netmaskNote.length > 1 && HOST !== '127.0.0.1') {
    console.log('');
    console.log(`   ${netmaskNote.length} interfaces are exposed (${netmaskNote.map((i) => i.name).join(', ')}).`);
    console.log('   If one is a VPN, WSL or Docker adapter, prefer --host <the LAN address>.');
  }

  if (announcedAdmin) {
    console.log('');
    console.log(`   Administrator sign-in: ${announcedAdmin.username} / ${announcedAdmin.password}`);
    console.log('   Generated for this run. Store it in .env (ADMIN_PASSWORD) before the next restart,');
    console.log('   or change it after signing in so it survives.');
  }

  console.log('');
  console.log('   Forgot the admin password later?   npm run admin');
  console.log('');
}

// Reuses the server's own bootstrap so the CLI and the server cannot disagree
// about the username, the policy, or where the password came from.
async function ensureAdminPassword() {
  const { Store, DB_FILE } = await lib('db.js');
  const { randomAdminPassword } = await lib('guard.js');
  if (!existsSync(DB_FILE)) return null;

  const store = await Store.open();
  try {
    const username = String(process.env.ADMIN_USERNAME || 'admin').trim() || 'admin';
    const existing = await store.getUserByName(username);
    if (existing) return null;
    const password = randomAdminPassword(username);
    process.env.ADMIN_PASSWORD = password;
    return { username, password };
  } finally {
    await store.close();
  }
}

// Only ever run when asked for: this changes system firewall state, and Windows
// refuses it without elevation, so the command is echoed when that happens.
function openFirewall(port) {
  const parts = windowsFirewallCommand(port).match(/^(netsh.*)$/);
  const argv = parts[1].split(/\s+/);
  const res = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit' });
  if (res.status === 0) {
    console.log(`   Firewall rule added for TCP ${port}.`);
  } else {
    console.log('   The firewall rule was not added (needs an administrator terminal).');
    console.log(`   Run this yourself: ${windowsFirewallCommand(port)}`);
  }
}
