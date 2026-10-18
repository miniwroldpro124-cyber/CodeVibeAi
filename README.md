# DevChat — streaming AI chat for coders, with accounts

A local web app that talks to the [xah.io](https://api.xah.io) OpenAI-compatible API and renders
answers the way coding assistants do: streamed markdown, syntax-highlighted code blocks, a copy
button on every snippet, and a **Files** button that zips every file in an answer.

It is multi-user: each person signs up, pastes **their own** `sk-` key, and every request is signed
with that key, so the operator never spends their own balance. Prices come from the provider's own
model catalogue, and an admin panel shows real spend per user and per model.

## Quick start

```bash
npm start          # this computer only  →  http://127.0.0.1:5173
npm run host       # also reach it from phones and other machines on the LAN
npm run admin      # admin account and markup, from the terminal
```

There is nothing to install — the server uses only the Node standard library (including
`node:sqlite`) and the browser libraries are vendored in `public/vendor/`. Requires Node 24 or
newer, because the database is `node:sqlite`.

On the very first start the server prints an **administrator account** and its password once:

```
  ┌─ Administrator account ────────────────────────────────
  │  username : admin
  │  password : <random, shown only here>
  │  This password is shown once. Sign in, then change it in Settings.
  │  Lost it?  npm run admin
  └─────────────────────────────────────────────────────────
```

Set `ADMIN_PASSWORD` in `.env` before the first start if you would rather choose it yourself.
To begin over, stop the server and delete the `data/` folder — that deletes every account, stored
key and usage row, so it is only ever a deliberate act.

## Getting back into the admin account

`npm run admin` works on the database directly, so it still functions when the server is stopped,
the admin password is forgotten, or the admin account is locked out by its own protection:

```bash
npm run admin                      # what exists, who is admin, what is locked
npm run admin -- --list            # every account, with role, lock and key state
npm run admin -- --reset admin     # new password (generated if you omit it), printed once
npm run admin -- --unlock alice    # clear a failed-sign-in lock
npm run admin -- --promote bob     # make an account an administrator (--create makes it)
npm run admin -- --demote bob      # take administrator rights away
npm run admin -- --status bob disabled     # or active
npm run admin -- --markup 25       # set the markup used by reports and the calculator
npm run admin -- --json            # machine-readable, for scripts
```

Add `--write-env` to `--reset` to store the new password in `.env` instead of reading it off the
terminal. `--help` lists everything. Two guard rails apply here too, because they are the point:
the last active administrator cannot be demoted or disabled, and a password reset does not lift a
lock — otherwise a stolen password would also unlock the brute-force defence.

The reset needs a moment if the server is running: the database is shared and the CLI waits up to
five seconds for a lock, then tells you to try again.

## Pages

| Page                 | Who sees it       | What it does                                                    |
| -------------------- | ----------------- | --------------------------------------------------------------- |
| `/`                  | signed-in users   | the chat                                                         |
| `/pricing.html`      | signed-in users   | cost calculator and the full ckey.vn price list                  |
| `/admin.html`        | admins only       | markup, users, spend per user/model, recent requests, and the protection card — locks, live sessions and the audit trail |

A non-admin who opens `/admin.html` gets an "Admin only" card, and the API itself answers `403`
regardless of what the page shows.

## Configuration

Settings live in `.env` (copy `.env.example` to start):

| Variable                | Default                   | Purpose                                                    |
| ----------------------- | ------------------------- | ---------------------------------------------------------- |
| `PORT`                  | `5173`                    | Port to listen on.                                          |
| `HOST`                  | `127.0.0.1`               | Bind address. See the warning below.                        |
| `XAH_API_BASE`          | `https://api.xah.io/v1`   | Any OpenAI-compatible endpoint.                             |
| `DEFAULT_MODEL`         | `deepseek-v4.1-flash`     | Model used before a user picks one.                         |
| `ADMIN_USERNAME`        | `admin`                   | Account created on first run.                               |
| `ADMIN_PASSWORD`        | —                         | First-run password, 12+ characters. Empty means generate and print one. |
| `ADMIN_REAUTH`          | `sensitive`               | Step-up password prompt: `sensitive`, `always`, or `off`.   |
| `ADMIN_REAUTH_MINUTES`  | `10`                      | How long a sign-in or confirmation counts as recent (1–240).|
| `MASTER_KEY`            | —                         | 32 bytes of base64 that decrypt stored keys. Empty means generate `data/master.key`. |
| `TURSO_URL`             | —                         | Hosted database URL (`libsql://…`). Set it and the app uses that instead of `data/devchat.db` — and `MASTER_KEY` stops being optional. |
| `TURSO_TOKEN`           | —                         | API token for that database. Required with `TURSO_URL`.        |
| `TURSO_TIMEOUT_MS`      | `10000`                   | How long one database round trip may take.                     |
| `ALLOWED_ORIGINS`       | —                         | Frontend origins allowed to call this API, comma-separated. Only for layout B below. |
| `TRUST_PROXY`           | `0`                       | `1` reads the client address from `X-Forwarded-For`. Set it only behind a proxy you control. The Vercel function sets it for you. |

`XAH_API_KEY` is **no longer used**. Keys belong to the accounts that use them; there is no shared
server key. If yours is still sitting in `.env` from an earlier version, delete the line.

**Do not set `HOST=0.0.0.0` on a network you do not trust.** Anyone who can reach the app can
register an account and burn *their own* balance through your server, and the first-run admin
password is printed to the console of whoever starts it.

## Sharing it on your network

```bash
npm run host                      # binds 0.0.0.0, prints every address
npm run host -- --port 8080       # different port
npm run host -- --host 192.168.1.20   # one adapter, instead of every interface
npm run host -- --private         # back to this computer only
npm run host -- --firewall        # also open the Windows Firewall rule
```

This is `npm start` with the bind decision made for you. It prints the loop-back URL, one URL per
network adapter with the adapter's name (`http://192.168.1.102:5173  (Ethernet)`), the admin panel
address, and the exact `netsh` command that opens the port on Windows — `--firewall` runs it for
you, and it is the only part that needs an elevated terminal.

Read the printed addresses before you share anything. A laptop on both Wi-Fi and Ethernet lists
both, and a `169.254.*` address means that adapter has no network. Anyone on the chosen network
can reach the sign-up page, so treat a shared instance like an open registration: it is fine at
home, not fine on a café VLAN. `HOST=0.0.0.0` keeps the loud warning in the log for exactly this
reason, and `--private` is always one flag away.

## Deploying it

DevChat is a Node server with a database beside it, and a frontend-only host has nowhere to put
either. Vercel gives a function a read-only filesystem that is wiped between cold starts, so
`data/master.key` would be regenerated on the next request — which does not merely lose the
accounts, it makes every stored `sk-` key permanently undecryptable. The function therefore refuses
to serve at all without a hosted database, and says so in its response instead of quietly minting a
new key.

Two layouts work. Pick one:

| Layout                                                                   | Needs                     | Session travels as        |
| ------------------------------------------------------------------------ | ------------------------- | ------------------------- |
| **A. Everything on Vercel** — page and API on one origin, data on Turso    | a free Turso database     | an `HttpOnly` cookie      |
| **B. Page on Vercel, API on a disk** — Docker, Railway, Fly.io or a VPS    | a host with a real volume | an `Authorization` header |

### A. Everything on Vercel

`vercel.json` already does the wiring: `public/` is served as static files, `api/index.js` is one
Node function, and a rewrite sends every `/api/…` path to it. One origin means no CORS, no
`localStorage` token, and no second service to keep alive.

**1. Create a database.** [turso.tech](https://turso.tech) has a free plan (5 GiB storage, 500 M row
reads and 10 M row writes a month — DevChat reads one session row per request). Choose the region
nearest your users, then copy the database URL and create an API token. With the
[CLI](https://github.com/tursodatabase/turso-cli) that is four commands:

```bash
turso auth signup                        # or: turso auth login
turso db create devchat                  # also creates the group it belongs to
turso db show devchat --url              # libsql://devchat-<yourname>.turso.io
turso group tokens create devchat        # paste this as TURSO_TOKEN
```

`--http-url` prints the `https://` form instead; either works, the driver converts `libsql://`.
Signing up in the browser and reading the URL and token off the database page does the same thing.

**2. Move the accounts over** — only if this machine already has a `data/devchat.db` worth keeping.
Read the master key first, because the new host must decrypt with exactly that key:

```bash
npm run admin -- --print-master-key          # the key that unlocks every stored sk-
npm run migrate:turso -- --dry-run           # shows what would be copied, writes nothing
npm run migrate:turso                        # users, sessions, usage, settings, guards, audit
```

Put `TURSO_URL`, `TURSO_TOKEN` and `MASTER_KEY` in `.env` for the copy, or pass them inline. The
script refuses a target that already has accounts, because merging two id sequences produces
collisions; `--force` overrides that if you know why.

Keep those three values in your local `.env` afterwards too. A `npm start` that points at
`data/devchat.db` while the deployed site points at Turso is two databases that drift apart from
the first signup — accounts created on one are invisible to the other, and neither can be promoted
into the other without a second copy.

**3. Set the environment in Vercel** — Project → Settings → Environment Variables (Production at
minimum, Preview if you want both to work):

```
TURSO_URL=libsql://your-db-yourname.turso.io
TURSO_TOKEN=eyJhbGciOi…
MASTER_KEY=<the base64 printed by --print-master-key>
ADMIN_USERNAME=admin
DEFAULT_MODEL=deepseek-v4.1-flash
```

`ADMIN_PASSWORD` is optional; left empty the first cold start generates one and prints it to the
function log, which is harder to read than a local console. Set it, sign in, then change it in
Settings and remove the variable.

**4. Push.** In the Vercel build log, check two lines: the Functions list must contain
`api/index.js`, and the Routes list must contain a rewrite from `/api/:path*` to `/api/index`. If
the function is missing, the deployment treated `public/` as the whole project — set Root Directory
to the repository root (the output directory only says where static files live).

`public/config.js` keeps `DEVCHAT_API = ''`: same origin, so nothing to point at. Sign in on the
live URL and the "No server behind this page" pane should be gone.

What the serverless shape changes underneath:

- **Duration.** `maxDuration` is 300 s, enough for a long answer. A stream that is cut off still
  records its usage, because the write is awaited before the function returns — a fire-and-forget
  write would be frozen with the process and lost.
- **The login limiter is per instance.** The in-memory fixed-window counter sees only what one warm
  instance saw. The account lockout ladder is different: it lives in the database, so ten bad
  passwords lock that account wherever they came from.
- **One round trip per call.** Every request to a hosted database is an HTTPS call, so the hot
  paths are written as one statement. Put the Vercel project region (Project → Settings → Region)
  next to the Turso group, or each request pays for the crossing.
- **Schema on cold start.** The function runs `CREATE TABLE IF NOT EXISTS` on every boot, so a
  brand-new database needs nothing but the URL and the token.

### B. Page on Vercel, API on a disk

`Dockerfile` and `docker-compose.yml` are ready. The compose file mounts a named volume at `/data`,
and that volume is the whole deployment story — a free tier that restarts the container with an
empty filesystem is not a host, it is a timer that deletes every account. Railway, Fly.io and a
small VPS give you a real volume; Render's free web service does not.

```bash
docker compose up -d --build     # then point a domain and TLS at port 8080
```

Set in the environment, or in `docker-compose.yml`:

```
ALLOWED_ORIGINS=https://your-project.vercel.app
TRUST_PROXY=1
ADMIN_USERNAME=admin
```

`TRUST_PROXY=1` makes the app read the client address from `X-Forwarded-For`. Without it every
visitor is recorded as the proxy's own address, so one person's mistyped password counts against
the whole service in the login limiter. Set it only when a proxy you control is in front of the
process — otherwise a client can pick its own IP and step around the limiter.

Then two places have to agree on the same origin, one line each:

| File                | Set                                                                        |
| ------------------- | -------------------------------------------------------------------------- |
| `public/config.js`  | `const DEVCHAT_API = 'https://api.your-domain.com'`                        |
| `vercel.json`       | add that origin to the CSP `connect-src` entry, after `'self'`             |

If you edit only one of them the browser blocks every request and the UI says `Cannot reach the
server`; that is a CSP violation rather than a network failure, so read the browser console before
debugging the backend. Leave `DEVCHAT_API` empty and the app uses the server that delivered the page
— that is `npm start`, `npm run host`, and layout A.

### How you stay signed in

Same-origin — this machine, your LAN, and layout A — keeps the `HttpOnly` session cookie as always:
JavaScript cannot read it, so injected code cannot steal it. Across origins (layout B) a cookie set
by the API host is third-party storage, which Safari drops outright, so the login response returns
the token in JSON instead and the page replays it as `Authorization: Bearer`. That token lives in
`localStorage` where page script can reach it — the honest cost of the split is trading cookie theft
for XSS theft, and the CSP that forbids inline script is what keeps that trade worth making. Never
add `'unsafe-inline'` to `script-src` to silence a warning.

Because the credential is a header rather than an ambient cookie, no cross-site request can carry it
by accident, so the CSRF defence becomes a plain origin allowlist.

### Before you push anything

`data/` and `.env` are git-ignored, but GitHub's **Add files via upload** ignores `.gitignore` and
ships whatever you drag. If that is how the code got there, open the repository and look for
`.env`, `data/devchat.db` and `data/master.key`. If any are present, treat the vault as public:
rotate the `sk-` keys, delete the files along with their history, and switch to `git push` from a
clone.

## Accounts and API keys

- Sign-up is open: username (3–32 characters: letters, numbers, `.` `-` `_`) and a password of at
  least 8 characters.
- Sessions are random 32-byte tokens, stored only as a SHA-256 hash, delivered in an `httpOnly`,
  `SameSite=Lax` cookie, and valid for 30 days. Changing or resetting a password signs that user
  out everywhere.
- Passwords use scrypt (N=16384, r=8) with a per-user salt and a constant-time compare.
- Each `sk-` key is encrypted with AES-256-GCM before it touches the database. The browser is only
  ever shown a masked hint, e.g. `sk-b27••••••62a6`, and the stored value is never returned.
- A key is verified against the provider before it is saved, so a typo fails with
  *"The provider rejected this key"* instead of failing on the first message.
- Admins can disable an account (instant lockout on every request, not just the login form),
  promote or demote, reset a password, and delete a user — deleting cascades to that user's
  sessions, stored key and usage rows.

## Admin account protection

The administrator can read every masked key hint, disable any account and change the markup, so
it is guarded harder than a normal account. All of this is stored in the database, so restarting
the server does not reset a lock and a second process cannot brute-force around it.

- **Sign-in lockout.** Five wrong passwords lock the administrator for 15 minutes, eight for an
  hour, twelve for six hours. Ordinary accounts get 10 and 25 attempts instead, because a person
  fumbling on a phone is not an attack. The lock is checked *before* the password hash is
  computed, so a locked account also stops the scrypt work that a timing attack would want.
- **Shorter sessions.** An administrator cookie lives for 12 hours; a user's lives for 30 days.
- **Step-up confirmation.** Changing a role, a password, an account status, a lock, anyone's
  sessions, or the markup (`ADMIN_REAUTH=always`) asks for the admin password a second time, unless
  that browser signed in or confirmed within `ADMIN_REAUTH_MINUTES`. A stolen cookie left on a
  shared machine therefore cannot edit users on its own — the panel prompts, and the prompt is
  enforced by the server, not the page.
- **Stronger passwords, everywhere it matters.** 12 characters minimum for an administrator (8 for
  a user), a letter and a number, not the username, and not one of the obvious strings. The same
  rules apply when an admin resets someone else's password, and a password that would fail them is
  refused rather than silently accepted. `ADMIN_PASSWORD` in `.env` is no exception: a weak one is
  replaced with a random one at boot and the console says why.
- **You cannot lock yourself out of the whole app.** The last active administrator cannot be
  demoted, disabled or deleted — from the panel or from `npm run admin`. You cannot disable or
  delete the account you are signed in as either; sign out first, or use a second admin.
- **Sessions you can see and end.** `/admin.html` lists every live session per account, and one
  button signs them all out. Revoking your *own* sessions ends every other device and hands this
  browser a fresh cookie, so the button never strands the admin who pressed it.
- **An audit trail.** Sign-ins, failures, locks, role changes, password changes, step-ups, key
  changes and markup changes are recorded with the username, kind and IP, and shown newest first
  on the protection card. It keeps the last 3000 events.
- **No account probing.** An unknown username and a wrong password return the same status and the
  same wording as each other, per-IP throttling is aligned to fixed 10–15 minute buckets, and a
  password reset for a locked account is refused on purpose: otherwise a leaked password would
  also clear the lockout it was used to bypass.

A locked administrator is still reachable: the lock stops *sign-ins*, not sessions that already
exist, and another admin (or `npm run admin -- --unlock <name>`) can clear it.

## Inspector and extension defences

Two layers, with honestly different strengths.

**The layer that works: response headers** ([lib/security.js](lib/security.js)). Every page and API
reply carries a Content-Security-Policy of `default-src 'self'` with `script-src 'self'`,
`style-src 'self'`, `connect-src 'self'`, `object-src 'none'`, `base-uri 'none'`,
`frame-ancestors 'none'`, plus `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: same-origin`, `Cross-Origin-Opener-Policy: same-origin` and a
`Permissions-Policy` that denies camera, microphone, geolocation, payment, USB and clipboard reads.
That means:

- no inline `<script>` or `style="…"` attribute anywhere, so a pasted bookmarklet, a `javascript:`
  URL or an injected `<script>` tag is refused by the browser;
- nothing the page loads can talk to another origin, so stolen session data has nowhere to go;
- the site cannot be framed, which kills the clickjacking route into the key settings panel.

Because inline script is forbidden, the theme bootstrap that used to sit in each page's `<head>` is
now [public/theme.js](public/theme.js), and the admin sparkline sets bar heights through the CSSOM
instead of a `style` attribute.

**The layer that only discourages: [public/watchdog.js](public/watchdog.js)**. It swallows F12,
Ctrl/Cmd+Shift+I / J / C, Ctrl+U and Ctrl+S, suppresses right-click except in fields and on selected
text (so pasting a key and copying code still work), notices a docked inspector by the pixels it
steals, spots automation hooks such as `navigator.webdriver` and driver-injected globals, blurs the
API key hint while tools are open, and reports what it saw to `POST /api/guard/event`, which writes
`devtools_open`, `automation_detected` or `guard_removed` into the same audit list the admin page
shows. Say so plainly: **a determined person beats all of this**, because their browser is their
machine. It is a speed bump and a tripwire, not a lock.

Three knobs:

| What you want                | How                                                        |
| ---------------------------- | ---------------------------------------------------------- |
| a bit stronger                | `data-mode="strict"` on the `watchdog.js` tag — also blanks the page and probes the console |
| get out of your own way       | `localStorage.setItem('devchat.guard', 'off')` in the console, or delete that key to turn it back on |
| change what counts as secret  | add or remove `data-guard="secret"` on the elements to blur |

`warn` is the default on all three pages. Detection is deliberately quiet: one report per kind per
minute on the client, and the same again on the server, so the audit list cannot be flooded.

## Pricing

`GET /v1/models` on this provider is public and carries each model's own price list in **₫ per
million tokens**, so the calculator quotes real ckey.vn rates instead of a hand-maintained table
that would silently go stale. It refreshes hourly.

Two details make a quote agree with the bill:

- **Minimum charge.** Measured against the live provider, a 6-token request and a 156-token request
  were both charged 2,02 ₫. Anything below that floor costs the floor, and the calculator says so.
- **Markup.** The default `+20%` is a display figure — this site is not a reseller and every user
  pays the provider directly. An admin can change it live in `/admin.html`, and the calculator,
  the price list and the cost chip under each answer all update at once. Usage rows keep the
  markup that was in force when the request ran, so the audit trail stays honest; the dashboard
  aggregates are re-derived from the live figure.

## Why there is a server

Calling the API straight from the browser does not work here: the endpoint sends no CORS headers,
and a static page would have to embed each secret key where anyone could read it. `server.js` sits
in between — or `api/index.js`, the same routes packaged as one Vercel function — holds keys only in
the encrypted database, and rebuilds every chat body from a whitelist of recognised parameters, so
it cannot be abused as an open relay to the rest of the upstream API.

## Features

- **Streaming** answers over SSE, with a live caret and a Stop button that also cancels the
  upstream request, so you stop paying for tokens you will not read.
- **One-click code copy.** Every block has a language label, a Copy button, and a Download button
  that names the file from the block's language or a leading comment (`// filename: src/a.js`, or
  a bare `# path/to/file.py`).
- **Files (.zip).** One button per answer bundles every code block into a zip named from the
  conversation, de-duplicating clashes and flattening any `../` a model invents.
- **Thinking time.** Models that emit `reasoning_content` get a collapsible *Thought process* panel
  and a chip such as `3706 tok · 2,02 ₫ · thought 43.0s · 47.8s`. Reasoning is stochastic: the same
  prompt may or may not produce a trace, so the chip omits it when the model did not think.
- **Real cost per reply** — token counts and the provider's actual charge (`usage.x_ckey.cost`, ₫).
- **500+ models** in a searchable picker, plus a filterable, sortable price list on the pricing page.
- **Chat history** in `localStorage`, grouped by day, searchable, and namespaced per user account.
- **File attachments** — attach source files, or paste more than 3000 characters, and the text is
  sent as a fenced block with its filename. An attachment alone is a complete message: with the box
  empty, one chip unlocks Send, the file's name becomes the chat title, and the attachment survives
  a sign-in or key prompt that interrupts the send.
- Markdown tables, task lists, inline code, links opened safely with `rel="noopener"`, and all model
  output passed through DOMPurify before it reaches the DOM.
- **Dark and light themes** on all three pages, following your system preference until you override
  it. The choice is stored under one key, so the chat, the price list and the admin panel never
  disagree about which theme you picked.
- **The interface** — a fixed sidebar with the model picker and history, a soft aurora and grid
  behind glass panels, a composer that grows with the text, starter prompt cards on an empty chat,
  and wide tables that scroll inside their own card instead of dragging the whole page sideways.

### Keyboard shortcuts

| Keys                         | Action                        |
| ---------------------------- | ----------------------------- |
| `Enter`                      | Send                          |
| `Shift` + `Enter`            | Newline                       |
| `Esc`                        | Stop generating / close panel |
| `Ctrl`/`Cmd` + `K`           | Open the model picker         |
| `Ctrl`/`Cmd` + `Shift` + `O` | New chat                      |

## Project layout

```
server.js              boot, static file serving, ETag caching
api/index.js           the same API as one Vercel function (needs TURSO_URL)
lib/
  db.js                schema and all queries, async over a pluggable driver
  driver-local.js      file-backed SQLite: WAL, foreign keys ON, busy timeout
  driver-turso.js      hosted libSQL over /v2/pipeline, no dependency
  auth.js              scrypt, sessions, key vault (AES-256-GCM), first-run admin
  guard.js             lockout ladder, password policy, step-up and audit rules
  env.js               .env reader, shared by the server and the scripts
  net.js               LAN addresses for `npm run host`, firewall command
  http.js              JSON body reader with size limits, cookie and error helpers
  security.js          the Content-Security-Policy and the other response headers
  cors.js              the split-deployment origin allowlist and preflight
  routes.js            the /api router: auth, keys, chat, pricing, admin
  pricing.js           price book ingested from the provider, floor and markup maths
  upstream.js          proxy: body whitelist, SSE relay, usage tap
scripts/
  admin.mjs            npm run admin — inspect, reset, promote, unlock, markup, master key
  host.mjs             npm run host  — bind the LAN, print URLs, spawn the server
  migrate-turso.mjs    npm run migrate:turso — copy data/devchat.db into a hosted database
public/
  index.html  app.js   the chat
  pricing.html pricing.js
  admin.html  admin.js
  auth.js              sign-in/sign-up overlay, the API-key gate and the session token
  page.js              helpers shared by the pricing and admin pages
  config.js            which API origin this page talks to ('' = the server that sent it)
  theme.js             sets the theme before first paint (no inline script allowed)
  watchdog.js          inspector and automation deterrent, reports to /api/guard/event
  styles.css
  zip.js               dependency-free ZIP writer (store method)
  vendor/              marked, DOMPurify, highlight.js + theme (no CDN at runtime)
data/                  devchat.db + master.key — git-ignored, delete to reset
vercel.json            static public/, the /api rewrite, function duration, security headers
Dockerfile             the API image; /data is a volume, nothing stateful in the layers
docker-compose.yml     run the API with a named volume and ALLOWED_ORIGINS
.dockerignore          keeps data/ and .env out of the image
```

## Notes

- `data/` and `.env` are git-ignored. `data/master.key` decrypts every stored user key; losing it
  means every user pastes their key again, leaking it means pasting it anywhere is unsafe.
- POSTs are defended by a JSON-only content type, an Origin check (same-origin, or the
  `ALLOWED_ORIGINS` list once split) and, for cookie sessions, `SameSite=Lax`; an oversized body
  is refused with `413` before it is buffered. A bearer-token session needs none of that, because
  a cross-site page cannot attach the header.
- Model output is treated as untrusted: it is sanitised before rendering, and code blocks are
  copied from the raw text rather than the highlighted DOM, so no markup ever leaks into your
  clipboard.
- If a model stalls, the client gives up after 90 seconds without data and shows an error instead
  of spinning forever.
- If your `sk-` key was ever pasted somewhere public — including a chat log — rotate it in the
  provider dashboard.
