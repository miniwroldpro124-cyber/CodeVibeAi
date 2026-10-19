# DevChat — streaming AI chat for coders, with accounts

A local web app that talks to the [xah.io](https://api.xah.io) OpenAI-compatible API and renders
answers the way coding assistants do: streamed markdown, syntax-highlighted code blocks, a copy
button on every snippet, and a **Files** button that zips every file in an answer.

It is multi-user: each person signs up, pastes **their own** `sk-` key, and every request is signed
with that key, so the operator never spends their own balance. Prices come from the provider's own
model catalogue, and an admin panel shows real spend per user and per model. The same key also drives
a media studio (pictures and clips) and a setup page that hands you paste-ready config for the coding
tools that read `ANTHROPIC_BASE_URL` or an OpenAI-compatible endpoint.

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
| `/studio.html`       | signed-in users   | image and video generation against the same account key          |
| `/coder.html`        | signed-in users   | paste-ready setup for Cursor, Claude Code, Codex, Droid, OpenCode and OpenClaw |
| `/pricing.html`      | signed-in users   | cost calculator and the full ckey.vn price list                  |
| `/admin.html`        | admins only       | markup, users, spend per user/model, recent requests, and the protection card — locks, live sessions and the audit trail |

A non-admin who opens `/admin.html` gets an "Admin only" card, and the API itself answers `403`
regardless of what the page shows.

## Studio and coder setup

`/studio.html` has four tabs — Picture, Edit, Video, Voice — and every one of them is charged to the
signed-in account's own key. What each offers is derived from the live catalogue instead of typed in:
a model appears under **Picture** if `/v1/models` says it answers `/v1/images/generations` (10 of
them do on today's list), under **Edit** if it both takes a picture as input and returns one —
`chat/completions` plus `images/generations`, which is one model at 65 dong — and under **Voice** if
it answers `audio/speech`. **Video** can only come from `VIDEO_MODELS`, because no video model
appears in `/v1/models` at all.

**Picture** is words in, image out — and it can carry a reference: a screenshot or capture you pick,
paste or drop, or a link you type, travels with the prompt as `image_url`. Not every picture model
reads one, and the price is the same either way, so the tab says so rather than promising a match.
**Edit** is an image in, image out: you pick a file from disk, paste one straight off the clipboard or
drag one in from the file manager, it is shrunk to 1100 px in the browser, and it travels to the
vision model as an `image_url` part with your instruction — the shape that works on this gateway,
since its `images/edits` endpoint refuses every body tried against it. The picture comes back either
as a markdown image or as its own content part, and both are read. **Voice** posts to
`/v1/audio/speech` and plays the answer through a `blob:` URL, because an `<audio src>` can carry
neither a POST nor a session cookie.

A picture you attach to either tab is kept **in that browser** for three days — IndexedDB
(`devchat.studio`), keyed by account id, capped at the size the send already allows, evicted when read
if it has gone stale. Nothing is uploaded, and *Forget* next to the preview drops it. The point is the
boring part of the workflow: re-picking the same capture after every reload.

Money is never spent by a dropdown. One picture costs between 65 and 1800 dong on the provider's
list, so anything at or above `MAX_PICTURE_DONG` (300 by default) is left out of the Picture list
*and* refused on the route that spends, because a filtered list is a hint rather than a control.
Editing sits outside that ceiling on purpose — it costs what the vision model charges, which can be
more — so the Edit tab names the price and waits for a confirm click first. Every tab shows the
provider's rate and the marked-up figure under the prompt before you press Go, and a prompt-writing
button rewrites what you typed into a fuller description (that rewrite is a normal chat request and
is billed as one). Results keep the base64 or CDN URL the provider returned — pictures inline, clips
as a `no-referrer` link, because those CDN hosts are not a published allowlist and the CSP cannot
name them in advance.

`/coder.html` is the provider's setup page turned into copyable config for the tools people actually
paste a key into. Every snippet is the published shape with three tokens replaced: `{V1}` becomes
this deployment's `/v1` base URL, `{ROOT}` becomes the same URL without `/v1` (Claude Code wants the
root, and leaving `/v1` in is how you get `/v1/v1/messages`), and `{MODEL}` becomes whichever model
you pick from the chips or type into the box. The key stays a `sk-YOUR_API_KEY` placeholder, because
a stored key is never sent back to the browser — and a model id that is not in the live price book
says so instead of quoting a number for it.

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
| `APP_URL`               | —                         | Public origin of this site, no trailing slash. Provider sign-in is built from it; empty means no buttons. |
| `GOOGLE_CLIENT_ID`      | —                         | OAuth client from Google Cloud Console. Needs its secret *and* `APP_URL`. |
| `GOOGLE_CLIENT_SECRET`  | —                         | Client secret. A provider with only one half configured is not offered at all. |
| `GITHUB_CLIENT_ID`      | —                         | OAuth app from GitHub → Developer settings.                    |
| `GITHUB_CLIENT_SECRET`  | —                         | Its secret.                                                    |
| `VIDEO_MODELS`          | `MiniMax-H3,MiniMax-H3-Max` | The studio's video list. Comma-separated model ids; needed because `/v1/models` does not contain any video model. |
| `MAX_PICTURE_DONG`      | `300`                     | Ceiling for the Picture tab, in dong per image. Models at or over it are not listed and are refused when asked for. `0` offers every picture model; editing is never covered by it. |
| `DEVCHAT_LOCAL_DB`      | —                         | `1` ignores `TURSO_*` and uses the local file database even when this `.env` has a live URL. See "Testing without touching live data". |
| anti-abuse knobs        | see below                 | `WINDOW_*`, `DAILY_BUDGET_*`, `MAX_STREAMS_*`, `MAX_MEDIA_*` and the `*_TIMEOUT_MS` deadlines — every default and what it counts is in the Anti-abuse table. |

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

## Testing without touching live data

`.env` on this machine holds the **live** `TURSO_URL`, `TURSO_TOKEN` and `MASTER_KEY`, and
`lib/env.js` lets any variable the command line left unset fall through to that file. So
`DATA_DIR=C:\tmp\scratch node server.js` is not a scratch run: the log still says `hosted`, and every
write lands on the real accounts. Override the database with a switch the code honours, not a path:

```bash
npm run test:ui
```

That starts an isolated instance on `http://127.0.0.1:5199` — `DEVCHAT_LOCAL_DB=1`, a fresh temp
`DATA_DIR`, a throwaway `MASTER_KEY`, the fake provider from `.smoketest/fake-upstream.mjs`, and an
`admin` / `UiScratch2026xy` login it prints with the scratch folder path. It refuses to boot at all
if a hosted database is still reachable, because reaching that branch means the switch broke. Sign
in there and try the chat, the studio and the coder page; the real `data/` folder and Turso database
are never opened.

`DEVCHAT_LOCAL_DB` is for that one command. Do not put it in `.env` — it would make `npm start`
ignore the hosted database and grow a second, divergent copy of the accounts on disk.

The suites run against the same stand-ins and never need a real key:

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 node .smoketest/driver-unit.mjs    # one driver contract, both drivers
NODE_TLS_REJECT_UNAUTHORIZED=0 node .smoketest/hosted-run.mjs     # the Vercel function end to end
node .smoketest/boot-guard.mjs                                   # a function with no database refuses
node .smoketest/migrate-run.mjs                                  # the copy into a hosted database
node .smoketest/limits-run.mjs                                   # the anti-abuse layer, over two instances
```

`NODE_TLS_REJECT_UNAUTHORIZED=0` is there because the fake provider answers over HTTPS with a
self-signed certificate; it is a property of the harness, not of the app. `hosted-run.mjs` also
checks the frontend against the pages on disk — every asset a page links to exists, every `#id` a
page script reads is in its html, every `window.Page` helper it destructures is exported, and both
new pages are in the folder that gets uploaded. Those four checks are what a browser shows as a blank
pane and a deploy log does not.

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
reads and 10 M row writes a month — DevChat reads one session row per request).

The shortest route is Vercel itself: **Project → Settings → Integrations → browse for Turso Cloud**
installs the integration, which creates the database and injects its own variables. This build reads
`TURSO_DB_URL` and `TURSO_DB_AUTH_TOKEN` as well as the names below, so a Marketplace database needs
no renaming — only `MASTER_KEY` is still yours to add.

Otherwise, choose the region nearest your users and take the URL and a token from the database page,
or with the [CLI](https://github.com/tursodatabase/turso-cli):

```bash
turso auth signup                        # or: turso auth login
turso db create devchat                  # also creates the group it belongs to
turso db show devchat --url              # libsql://devchat-<yourname>.turso.io
turso group tokens create devchat        # paste this as TURSO_TOKEN
```

`--http-url` prints the `https://` form instead; either works, the driver converts `libsql://`.

**2. Move the accounts over** — only if this machine already has a `data/devchat.db` worth keeping.
Read the master key first, because the new host must decrypt with exactly that key:

```bash
npm run admin -- --print-master-key          # the key that unlocks every stored sk-
npm run migrate:turso -- --dry-run           # shows what would be copied, writes nothing
npm run migrate:turso                        # users, sessions, usage, settings, guards, audit, identities
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

`APP_URL` plus a provider's two variables are optional too, and turn on that provider's button —
`APP_URL` has to be the address Vercel actually serves (`https://<project>.vercel.app`, or your own
domain) because the callback registered with the provider is built from it. See
[Sign in with Google or GitHub](#sign-in-with-google-or-github).

**4. Push.** In the Vercel build log, check two lines: the Functions list must contain
`api/index.js`, and the Routes list must contain a rewrite from `/api/:path*` to `/api/index`. If
the function is missing, the deployment treated `public/` as the whole project — set Root Directory
to the repository root (the output directory only says where static files live).

Then check it from a terminal. Variables added in the dashboard reach a function only on the next
deployment, so an unchanged answer after editing usually means "not redeployed yet", not "wrong
value":

```bash
curl -i https://your-app.vercel.app/api/health
```

`200` with `"users":3` means the API is talking to the hosted database. A `503` names the
`TURSO_*` variables the function can actually see — none of them means the environment did not
arrive, and a name that is not `TURSO_URL` means the platform injected one this build does not read.

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
  least 8 characters — or a Google or GitHub account, if the deployment has credentials for one.
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
  sessions, stored key, usage rows and provider identities.

## Sign in with Google or GitHub

Optional, and separately optional per provider. With `APP_URL` empty, or a provider missing either
half of its credentials, its button is not rendered and username-and-password sign-in behaves exactly
as it always did. `/api/health` answers `"oauth":["google","github"]` for what an instance actually
offers, so the wiring can be checked without a browser.

**Register the app.** Each console wants one callback URL, and that URL is built from `APP_URL`, so
register it against the address people really open — `https://your-app.vercel.app` in production,
`http://127.0.0.1:5173` on your own machine:

```
https://your-app.vercel.app/api/auth/oauth/google/callback
https://your-app.vercel.app/api/auth/oauth/github/callback
```

- **Google**: Cloud Console → APIs & Services → Credentials → *Create OAuth client ID → Web
  application*, then add the URI under *Authorized redirect URIs*. The consent screen has to be
  **Published**, or your own address added as a test user, or Google interposes its
  "app isn't verified" page first.
- **GitHub**: Settings → Developer settings → *Developer OAuth Apps* → new application, and the URI
  goes in *Authorization callback URL*.

Both providers accept a plain `http://127.0.0.1` callback, so local testing needs no tunnel.

**What an account created by a provider looks like.** The identity stored is the provider's own
stable id — Google's `sub`, GitHub's numeric `id` — never the email and never the username, because
an address can be reassigned and a GitHub login renamed while a subject cannot. The first sign-in
creates the account with a password of 32 random bytes that is hashed and immediately discarded, so
there is nothing to guess: `/api/auth/login` answers that account the same way it answers any wrong
password, until someone sets one. A provider name that is already taken gets a suffix (`ada` →
`ada1`) rather than being handed the account that owns it.

The key is unaffected: it still lives on the account, still encrypted with `MASTER_KEY`, still never
returned to the browser, and the provider is never told it exists.

**The handshake.** `GET /api/auth/oauth/<provider>` sends the browser to the provider with a random
`state` (plus a PKCE verifier for Google; GitHub's confidential-client exchange has no PKCE, and
inventing one there is a second way to get it wrong). Both are sealed into one short cookie —
AES-256-GCM under the same `MASTER_KEY` that guards the key vault, `HttpOnly`, `SameSite=Lax`,
`Path=/api/auth/oauth`, 10 minutes — rather than kept in process memory or a database row, because a
serverless begin and its callback usually land on different instances and must still be able to
finish the same handshake.

`GET /api/auth/oauth/<provider>/callback` spends that cookie before anything else, which is what makes
a callback unusable twice, then checks `state`, exchanges the code, and reads the profile. Anything
that goes wrong comes back to `/` with one of seven fixed words
(`?oauth=cancelled`, `incomplete`, `tampered`, `expired`, `mismatch`, `provider`, `disabled`) and the
page shows the matching sentence, so a provider cannot put its own text in front of a user. Begins are
throttled to 15 per 10 minutes per address and callbacks to 30, and every step is recorded in the audit
trail under its own kind — `oauth_begin`, `oauth_cancel`, `oauth_fail`, `oauth_signup`, `oauth_login`,
`oauth_disabled` — like any other sign-in.

Same-origin deploys finish by setting the session cookie and landing on `/`. A split deploy (layout B)
cannot rely on a third-party cookie, so the callback returns the session in the URL fragment
(`#devchat_oauth=<token>`); the page writes it to `localStorage` and erases it from the address bar in
the same tick. A fragment is never sent to a server, so it stays out of access logs.

**No migration step.** `identities` is created by the same `CREATE TABLE IF NOT EXISTS` pass that runs
on every cold start, and it only *adds* a table — no existing column is touched — so a live database
picks it up on the next deployment. `npm run migrate:turso` copies it along with the rest.

**Testing it without Google or GitHub.** `npm run test:ui` shows both buttons against
[.smoketest/fake-oauth.mjs](.smoketest/fake-oauth.mjs), and `node .smoketest/hosted-run.mjs` walks the
whole flow there — both providers, a hidden GitHub address, a taken username, a mismatched `state`, a
replayed callback and a disabled account. The stand-in is stricter than most: a code is single-use, the
token call must present a verifier whose S256 matches the challenge it was issued with, and the profile
is returned only for a token that server handed out. `OAUTH_<PROVIDER>_<ENDPOINT>_URL` is what points
[lib/oauth.js](lib/oauth.js) at it; never set those in production, since they would send real sign-ins
wherever you typed.

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

Two origins are opened, and only for display: `img-src 'self' data: https:` and
`media-src 'self' blob: https:`. A generated picture arrives as `data:` and a generated clip is
served from whichever CDN the provider happens to use for that model — those hosts are not published
anywhere, so naming them is not possible, and the alternative is to route every byte through the
function and pay the transfer twice. `blob:` is there for spoken audio: the voice route answers a
POST with mp3 bytes that belong to the session that paid for them, so they are turned into a blob URL
for `<audio>` rather than put into a URL the browser could cache or share.
Note the asymmetry: `img-src` has no `blob:`. Any picture read off the visitor's own disk therefore
goes through `FileReader.readAsDataURL` before it reaches an `<img>`, in the studio and in the look
panel alike. A `blob:` URL there is not merely refused — a CSP-blocked image fires no `error` event,
so the load hangs forever and the file picker looks like it does nothing.
The carve-out is display-only: `connect-src` stays `'self'`, so nothing in a media URL can be fetched,
posted to, or turned into a request; clips and picture links also carry `rel="noopener"` and
`referrerpolicy="no-referrer"`, so the CDN is not told who was looking.

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

`warn` is the default on all five pages. Detection is deliberately quiet: one report per kind per
minute on the client, and the same again on the server, so the audit list cannot be flooded.

## Anti-abuse

The economics here are unusual, so say the obvious part first: **every chat, picture and clip is
signed with the signed-in account's own `sk-` key.** An attacker burning tokens spends their own
credit. What a request does cost *you* is a Vercel function invocation and its execution seconds, a
couple of Turso round trips, a connection held open for up to the 300 s `maxDuration`, and the provider
round trip. The ceilings in [lib/limits.js](lib/limits.js) are sized against that, not against tokens.

**Layer 1 — this process.** A fixed-window bucket per address over every `/api/*` path, run before the
route table is searched, so a scanner walking URLs that do not exist still spends from it. A per-tier
bucket on the routes that cost something. A per-account rate on the paid ones. In-flight slot counters
for answers streaming and media jobs generating, capped per account and for the whole instance.
Immediate and free — and it honestly covers one warm instance, which on Vercel is one container's share
of the traffic, nothing more.

**Layer 2 — the database.** `throttle_window` keeps a fixed-window hit count per tier per address and
per account, written and read back by one `INSERT … ON CONFLICT … RETURNING`, so the ceiling survives a
cold start and adds up over every instance at once. The daily budget is not a counter at all:
`usage_log` already holds a row per paid request, so an account's last 24 hours is one indexed read
against two ceilings, and nothing new has to be written to keep it true. Rows older than a day are
deleted on every cold start, because a flood is what fills the table. That table is created by the same
`CREATE TABLE IF NOT EXISTS` pass that has always run at boot, so shipping this needs no migration on
the live database — and if the table is ever dropped, layer 1 keeps working on its own.

Both layers refuse the same way: `429` with `Retry-After`, and a sentence naming what ran out —
`Too many paid requests from this address. Wait 43s.` or `This account has used its 200.000 ₫ daily
limit.` Never a `401`, because the browser reads that as "your session died" and signs people out in
the middle of being attacked. Each refusal also leaves one `throttled` row in the audit list the admin
page reads — at most one per bucket per five minutes, because a defence that buys a database write for
every rejected request is the attack wearing a defence's clothes.

The durable reads **fail open**. A Turso that cannot be reached is logged and the request goes through:
layer 1 still holds that instance, and turning a counter outage into "nobody can chat" is the worse bug.

| Knob                             | Default        | What it counts                                                |
| -------------------------------- | -------------- | ------------------------------------------------------------- |
| `MAX_REQUESTS_PER_MINUTE`        | 300            | every `/api/*` request per address, including 404s             |
| `MAX_EXPENSIVE_PER_IP_MINUTE`    | 60             | paid requests per address                                      |
| `MAX_AUTH_PER_IP_MINUTE`         | 40             | sign-in attempts per address                                   |
| `MAX_PER_USER_MINUTE`            | 40             | paid requests per account                                      |
| `WINDOW_SECONDS` / `WINDOW_MAX`  | 300 / 150      | paid requests, per address **and** per account, in the database |
| `AUTH_WINDOW_SECONDS` / `_MAX`   | 900 / 100      | sign-in attempts per address, in the database                  |
| `DAILY_BUDGET_DONG` / `_REQUESTS`| 200000 / 5000  | per account over a rolling 24 h, read from `usage_log`         |
| `MAX_STREAMS_PER_USER` / `_TOTAL`| 3 / 12         | answers streaming at the same time                             |
| `MAX_MEDIA_PER_USER` / `_TOTAL`  | 2 / 4          | picture and video jobs at the same time                        |

The paid window counts an address and an account in **separate rows** — one address can be inside a
sign-in window and a paid-request window at the same time with different budgets, and sharing a row
would let the cheaper one spend the dearer one's. Every value is a default you can raise or lower in
`.env`; it needs a restart (or a redeploy) to reach a running server.

`server.js` adds the deadlines for clients that are slow on purpose. `api/index.js` does not need them:
Vercel owns those sockets and enforces its own.

| Deadline                 | Default  | What it bounds                                              |
| ------------------------ | -------- | ----------------------------------------------------------- |
| `REQUEST_TIMEOUT_MS`     | 120000 | how long a client may take to *deliver* the request — not to be answered |
| `HEADERS_TIMEOUT_MS`     | 20000  | headers, then the start of the body                                  |
| `KEEP_ALIVE_TIMEOUT_MS`  | 5000   | a reused connection doing nothing                                     |
| `MAX_REQUESTS_PER_SOCKET`| 32     | requests queued on one connection at the same time                    |
| `SOCKET_TIMEOUT_MS`      | 30000  | socket inactivity — the one that actually drops a slowloris           |
| `BODY_TIMEOUT_MS`        | 60000  | one request body — a body that never arrives is answered `408`, then the connection is closed |

Two of those are not what the Node documentation makes them sound like, and both were measured rather
than assumed: a connection that sends half a header block and goes quiet is left open by
`headersTimeout` *and* `requestTimeout`, because neither starts counting until a request has begun.
Only the socket-level timer drops it — which would also reap a legitimate chat, silent while the model
reasons, or a picture that is three minutes with nothing on the wire. So the three long routes clear it
for their own socket (`clearIdleTimeout` in [lib/http.js](lib/http.js)) and Node re-arms
`keepAliveTimeout` when the answer finishes. `.smoketest/limits-run.mjs` proves both halves on one
instance: a stream with a 2.6 s pause in the middle arrives complete, and a half-sent header block on
that same server is closed without a reply.

### What only the platform can do

Nothing in this repository stops a flood. The code sees what the edge let through, and 10 000
addresses each staying under a per-address ceiling still cost 10 000 function invocations. That shape
is the platform's job, and it is a handful of switches — in this order:

1. **Vercel → Project → Settings → Firewall.** Layer-7 DDoS mitigation runs on every request already;
   what follows is the opt-in part.
2. **Attack Challenge Mode** — the lever to pull *while* something is happening. It asks every visitor
   for a browser check, so a scripted flood stops at the edge and real users pass through in a second.
   Switch it back off afterwards; left on forever it charges every visitor a round trip.
3. **Firewall rules → rate limiting** on the routes that hold a connection: `POST /api/chat`,
   `/api/image`, `/api/video`. An edge rule counts across all of an attacker's addresses at once,
   which is the one thing the two layers above cannot do.
4. **Managed rulesets (WAF)** set to *Block* rather than *Log only* for `/api/*`, so a scanner never
   reaches the function that would answer it politely.
5. **Bot protection**, and an **IP or country rule** if your users are where you think they are.
6. **Notifications and a spend cap** on the Vercel account. A flood that does get through arrives as
   function invocations; you want an email that day, not an invoice at the end of the month.
7. Optional and strongest: put **Cloudflare in front of a custom domain** (DNS → Proxied). Its
   rate-limiting rule, bot fight mode and *Under Attack* mode then sit in front of Vercel, and
   `TRUST_PROXY=1` still reads the right address, because the visitor is the first entry of
   `X-Forwarded-For` — which is what `clientIp()` takes.

Plan tiers move, so treat the list as the shape and the dashboard as the truth: check which of these
your plan actually includes before you rely on it. Then verify from a shell — loop `curl -i` at a paid
route and watch whose answer you get: your own `429` means the request reached the app, a `403` or a
challenge page with `cf-ray` / `x-vercel-*` headers means the edge took it. The **Security** tab of
`/admin.html` shows `Answers streaming now` beside its ceiling, the accounts locked for failed
passwords, and the `throttled` rows, which is where you will see which layer is doing the work.

Do not set `TRUST_PROXY=1` on a `node server.js` that anyone can reach directly. A client could then
name its own address and choose which bucket it lands in, which is every limiter at once turned off.

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
  upstream request, so you stop paying for tokens you will not read. While the answer is arriving
  it is written as plain text and parsed as markdown once, when it ends, so a long stream stays
  smooth instead of re-parsing the whole reply several times a second.
- **Large files, split.** A toggle beside the composer: when it is on, an attachment past 100 KB is
  sent as consecutive parts, cut at line breaks and labelled `part 1/2`, instead of one giant
  message. When it is off, the file travels whole (up to 250 KB).
- **Pictures in chat.** Drop, paste or pick an image anywhere on the page; it is scaled to 1280 px
  in the browser, shown as a thumbnail chip, and sent as an `image_url` part. Picture bytes are not
  written to chat history.
- **One-click code copy.** Every block has a language label, a Copy button, and a Download button
  that names the file from the block's language or a leading comment (`// filename: src/a.js`, or
  a bare `# path/to/file.py`).
- **Files (.zip).** One button per answer bundles every code block into a zip named from the
  conversation, de-duplicating clashes and flattening any `../` a model invents.
- **Thinking time.** Models that emit `reasoning_content` get a collapsible *Thought process* panel
  and a chip such as `3706 tok · 2,02 ₫ · thought 43.0s · 47.8s`. Reasoning is stochastic: the same
  prompt may or may not produce a trace, so the chip omits it when the model did not think.
- **Effort.** One control beside the composer — *auto*, *off*, *low*, *medium*, *high* — sent to the
  provider as `reasoning_effort`, with *off* meaning `none`. *Auto* reads the request: a pasted trace,
  a refactor or a long message gets *high*, a one-line question gets *low*, everything else *medium*.
  A model that rejects the field is retried once without it instead of failing the send.
- **Improve the prompt.** The star button rewrites what you typed into a brief — goal, givens,
  constraints, the shape of the answer wanted — in your language, keeping every path, version and
  error string. The burst button does the same automatically before every send and tags the message
  *improved*. Either way it is one small chat request on your own key.
- **Real cost per reply** — token counts and the provider's actual charge (`usage.x_ckey.cost`, ₫).
- **500+ models** in a searchable picker, plus a filterable, sortable price list on the pricing page.
- **Media studio** — four tabs, pictures, edits, clips and spoken audio, all generated with the
  account's own key and listed only for models the provider's catalogue says can answer the endpoint,
  with the price shown before you press Generate and a confirm click on the one tab whose price can
  surprise you. A clip is a job rather than a request: the proxy takes the task id back from the
  provider and the page polls it until a file appears, so a long render does not have to hold one
  request open. Picture and Edit both take a picture *in* — picked, pasted or dragged in — and the one
  you attach is remembered by that browser for three days and by no server.
- **Coder setup** — the provider's integration guide turned into copyable config for Cursor,
  Claude Code, VS Code, Codex, Droid, OpenCode and OpenClaw, with this deployment's base URL already
  filled in (root for Claude Code, `/v1` for everything OpenAI-shaped) and the key left as a
  placeholder, since a stored key never comes back to the browser.
- **Sign in with Google or GitHub** — optional, per provider, and the button only exists once that
  provider's credentials are set. The account is found by the provider's own stable id, so a renamed
  login or a reassigned address cannot hand somebody else's account over, and a first sign-in never
  takes a username that is already in use.
- **Ceilings, not queues** — the routes that cost something are limited per address and per account,
  in memory for this instance and in the database across all of them, with a rolling 24-hour spending
  budget read straight off the usage ledger. A refusal is a `429` with `Retry-After` and a sentence
  naming what ran out. See [Anti-abuse](#anti-abuse).
- **Chat history** in `localStorage`, grouped by day, searchable, and namespaced per user account.
- **File attachments** — attach source files, drop them onto the page from the file manager, or paste
  more than 3000 characters, and the text is sent as a fenced block with its filename. A drop that
  lands outside the composer is still read, never opened: the browser's own default is prevented, and
  anything this chat cannot read as text says so instead of silently filling the tray. An attachment
  alone is a complete message: with the box empty, one chip unlocks Send, the file's name becomes the
  chat title, and the attachment survives a sign-in or key prompt that interrupts the send.
- Markdown tables, task lists, inline code, links opened safely with `rel="noopener"`, and all model
  output passed through DOMPurify before it reaches the DOM.
- **Dark and light themes** on all five pages, following your system preference until you override
  it. The choice is stored under one key, so the chat, the price list and the admin panel never
  disagree about which theme you picked.
- **Look & feel** — a **Look** button beside the theme one on all five pages, for the background,
  the ambient sound and the interface clicks. See [Look & feel](#look--feel).
- **The interface** — a fixed sidebar with the model picker and history, a soft aurora and grid
  behind glass panels, a composer that grows with the text, starter prompt cards on an empty chat,
  and wide tables that scroll inside their own card instead of dragging the whole page sideways.
- **The thread reads as a conversation** — your turns sit on the right in a bubble, answers on the
  left, each with its avatar, so you can tell whose words you are looking at without reading the name.
- **A rail over your prompts** — the strip down the right edge puts one mark per prompt exactly where
  that prompt sits in the thread. Tap a mark to jump to it, or drag the strip and the thread follows
  your pointer; a label previews the turn you are hovering. It appears once there are four turns worth
  navigating and hides below 720 px, where there is no room beside a right-aligned bubble.
- **Long threads stay scrollable** — turns that are off screen keep their last measured height but
  skip layout and painting (`content-visibility`), pressing Send rebuilds only the rows that actually
  changed instead of re-parsing every answer in the chat, and following a streaming tail writes
  `scrollTop` directly rather than asking for an animated scroll. Measured on a seeded 120-turn
  thread, one forced layout of the message list costs single-digit milliseconds; with those three
  levers off it was over a second — paid once for every paint of every reply.

### Keyboard shortcuts

| Keys                         | Action                        |
| ---------------------------- | ----------------------------- |
| `Enter`                      | Send                          |
| `Shift` + `Enter`            | Newline                       |
| `Esc`                        | Stop generating / close panel |
| `Ctrl`/`Cmd` + `K`           | Open the model picker         |
| `Ctrl`/`Cmd` + `Shift` + `O` | New chat                      |

## Look & feel

`public/style.js` adds one panel to every page, opened by the **Look** button next to the theme
button. It holds four groups, and nothing in it is a server setting: the choice is stored in the
browser under `devchat.look.v1`, so another device stays on the defaults and the account list never
sees any of it.

- **Background** — *Aurora* (what the site ships with), *Grid*, *Plain*, or *Picture*. A picture is
  yours, in one of two ways: an `https` address, or **From this device**, which reads a file you
  pick, shrinks it to 1440 px and re-encodes it as a JPEG on a canvas, then keeps that as the
  backdrop. Both stay inside your browser — nothing is fetched or uploaded by this server — and a
  typed address wins over a kept file, so clearing the box brings the file back. Every value is
  checked before it is used, because it ends up inside a CSS `url("…")`: the address must be `https`
  with no character that could break out of it, and a stored file must be a base64 image of a listed
  mime type under one million characters. `theme.js` applies the choice before the first paint, so a
  saved backdrop does not flash in as the aurora. **Dim for reading** puts a scrim of the page's own
  background colour over whichever picture is showing, so text keeps the contrast it has elsewhere.
- **Ambient sound** — *Drone*, *Rain*, *Keys*, or *Your file*, with a level slider.
- **Interface sounds** — a tick on buttons, a short whoosh as a message goes out, a two-note chime
  when an answer lands, a low pair of tones when the request fails. One checkbox turns all of them
  off, and a level slider sets how loud.
- **Cursor** — off by default. Turned on, a click throws a ring of snowflakes that gravity then
  takes over, and dragging the mouse sheds a trail along the path the pointer came. *How much* is
  the gap between flakes, so a slow drag loses a few and a fast flick loses a ribbon. Flakes are
  drawn once into a sprite in the theme's own `--accent`, `--accent-2` and `--text` and blitted
  after that, the layer is a `pointer-events: none` canvas that only enters the document on the
  first click that needs it, and the animation loop cancels itself the moment nothing is alive
  rather than redrawing an empty screen.

No audio file is shipped with the site. Every sound is synthesised in the browser with WebAudio,
which is why there is nothing to licence and nothing to download. Two things do come from the
visitor's own disk, and neither of them leaves it: a track picked under *Your file* is decoded
and played locally for that visit only, and has to be chosen again after a reload — the
page only remembers that you wanted it. A picture picked under *Picture* is re-encoded first, and is
the one file that does survive a reload. Spoken answers from the studio are why `media-src` carries
`blob:`.

Browsers refuse to let a page make sound before you have interacted with it, so an ambient bed starts
on your first click or keypress rather than on load, and *Keys* stays quiet while the tab is in the
background.

## Project layout

```
server.js              boot, static file serving, ETag caching
api/index.js           the same API as one Vercel function (needs TURSO_URL)
lib/
  db.js                schema and all queries, async over a pluggable driver
  driver-local.js      file-backed SQLite: WAL, foreign keys ON, busy timeout
  driver-turso.js      hosted libSQL over /v2/pipeline, no dependency
  auth.js              scrypt, sessions, key vault (AES-256-GCM), first-run admin
  oauth.js             Google and GitHub: endpoints, PKCE, the code → profile exchange
  guard.js             lockout ladder, password policy, step-up and audit rules
  limits.js            per-address and per-account ceilings, durable windows, in-flight slots
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
  studio.html studio.js
  coder.html  coder.js
  pricing.html pricing.js
  admin.html  admin.js
  auth.js              sign-in/sign-up overlay, the API-key gate and the session token
  page.js              helpers shared by the pages other than the chat
  style.js             the look & feel panel: backdrop, ambient bed, synthesised interface cues
  config.js            which API origin this page talks to ('' = the server that sent it)
  theme.js             sets the theme and the chosen backdrop before first paint (no inline script)
  watchdog.js          inspector and automation deterrent, reports to /api/guard/event
  styles.css
  logo.jpg             the brand artwork as supplied — it carries its own "Vibe coding ai" wordmark
  logo-mark.jpg        the brain cropped square out of it: favicon, sidebar and every page header
  zip.js               dependency-free ZIP writer (store method)
  vendor/              marked, DOMPurify, highlight.js + theme (no CDN at runtime)
data/                  devchat.db + master.key — git-ignored, delete to reset
vercel.json            static public/, the /api rewrite, function duration, security headers
Dockerfile             the API image; /data is a volume, nothing stateful in the layers
docker-compose.yml     run the API with a named volume and ALLOWED_ORIGINS
.dockerignore          keeps data/ and .env out of the image
.smoketest/            throwaway provider and database stand-ins, and the suites that use them
```

## Notes

- `data/` and `.env` are git-ignored. `data/master.key` decrypts every stored user key; losing it
  means every user pastes their key again, leaking it means pasting it anywhere is unsafe. Once
  `TURSO_URL` is set, the accounts are not in `data/` at all — so clearing that folder does not reset
  a deployed site, and nothing on it should be cleared without meaning to. Use `npm run test:ui` for
  a scratch instance instead.
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
