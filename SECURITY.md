# Security

How this project handles secrets, what to do when one leaks, and how to report a
problem. Read the "A secret has been published" section first if you are here
because something is already in a repository — rotating the credential matters
more than deleting the commit.

## What this application is

A bring-your-own-key proxy. The server holds no AI provider account of its own:
each signed-in user supplies their own `sk-` key, and every upstream request is
signed with that user's key and billed to their wallet. A key is either sent with
one request and forgotten, or stored encrypted at the user's explicit choice.

Trust boundaries:

| Holds | Never holds |
| --- | --- |
| Username, password hash, role, status | Plaintext passwords |
| Encrypted API key + a masked hint (the last four characters), only for a key the user chose to store | The plaintext key, at rest or in a response |
| Session tokens as SHA-256 hashes, with an expiry | Raw session tokens |
| Usage rows: model, token counts, cost, duration | Prompt or answer text |
| Audit rows: event, account, IP, timestamp | Request bodies, API keys |

A key sent in the `X-DevChat-Key` header lives for one request. The server does
not decrypt anything to use it, writes it to no row, and repeats it in no
response. The session cookie still identifies the account, so usage rows and
budgets attribute correctly. Closing the tab or signing out drops the key with
it — there is nothing left on disk or in the database to clean up afterwards.

Chat history and generated files live in the **browser** — conversations in an IndexedDB object
store (`public/chatstore.js`), workspace files in another — scoped per account by the key it is
stored under. They are not uploaded and not shared between accounts on the same device. Attachments
are stripped from what is written, image data URLs included, so a transcript holds the text that
travelled and not the picture. An export writes the chats as plain text with no key, no token and no
session in it. Nothing is deleted without being asked for: history older than a chosen age is only
removed once that choice has been made in the pane, and signing out keeps it unless the box to forget
this device was ticked.

## Where secrets belong

Nothing secret is ever in a file in this repository. Configuration comes from the
environment; `.env.example` documents the names with no values.

| Variable | Protects |
| --- | --- |
| `MASTER_KEY` | Decrypts every stored user API key. Losing it makes them unreadable; publishing it is equivalent to publishing them all. |
| `TURSO_URL`, `TURSO_TOKEN` | Read-write access to the hosted database. |
| `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET` | Sign-in flows; a leaked one allows forged callbacks. |
| `ADMIN_PASSWORD` | Bootstraps the administrator. Read `.env.example` before setting it — the file copy is treated as a real password. |

`data/` is runtime state, not source: the SQLite database and, on a disk-backed
install, `master.key`. It is in `.gitignore`, and `npm run ship` refuses to stage
it.

## A secret has been published

Deleting the file in a new commit does not help. The value stays in history, in
GitHub's cached views, and in anything that already cloned the repository.

1. **Assume it is compromised.** Everything it protects is now public.
2. **Make the repository private**, or restrict it, before anything else.
3. **Rotate in this order:**
   - `MASTER_KEY` — see the rotation command below. It re-encrypts existing keys,
     so nobody loses their account.
   - `TURSO_TOKEN` — issue a new token scoped to this database only, then revoke
     the old one.
   - OAuth client secrets — roll them in the provider console.
   - Administrator password — change it, then sign out every session.
   - Users' `sk-` keys — if the encrypted keys or the master key were exposed,
     tell every user to revoke their key at the provider and paste a new one.
     This is the one step that cannot be done from the server.
4. **Then** clean history, on a fresh clone:
   `git filter-repo --invert-paths --path data --path server.log --path "<file>.lnk"`
   followed by a force-push. Ask GitHub Support to clear cached views and any
   pull-request refs that still point at the old commits.
5. **Verify the leak is actually closed** — search the repository and its
   commits for the value, from a machine that is not signed in.

## Rotating the master key

`MASTER_KEY` is versioned inside each stored blob, so rotation is a re-encryption
pass, not a swap of the file.

```
npm run admin -- --rotate-master
```

Put the new value in the environment, keep the previous one available as
`MASTER_KEY_PREV` for the duration of the pass, then remove it. Rows written
before the rotation are re-encrypted with the new key and a new version tag; a
row that cannot be decrypted is reported by id and left untouched rather than
silently destroyed. Never replace `MASTER_KEY` without this pass first — the
stored keys would become unreadable, which looks identical to losing them.

## Hardening the repository

On GitHub, for this repository: **Settings → Code security and analysis** →
enable **Secret scanning** and **Push protection** (free for public repos). Push
protection blocks a `sk-` or a token at push time, which is the only defence that
matters when most of the work is done in a browser tab.

Then stop uploading folders through the web UI. GitHub's "Add files via upload"
ignores `.gitignore`, so a `data/` folder dragged into the box is committed as
easily as source. Push with `git`, or stage first:

```
npm run ship
```

That writes `.ship/` containing only the files listed in `INCLUDE` inside
`scripts/ship.mjs`, drops anything matching `EXCLUDE` (databases, logs, `.env`,
shortcuts, TLS keys), refuses to finish if a file holds a key that looks real,
and prints what it kept out. Whitelisting means a new secret has to be added to
that list on purpose before it can be published.

`ci.yml` under `.github/workflows/` runs the syntax check, the smoke suites and a
secret scan on every push, and fails if a forbidden path appears.

## Runtime limits already in place

- Password hashing with a per-account salt, and a bounded number of concurrent
  hashes, so a sign-in burst cannot exhaust the process.
- Failed sign-in lockout per account and per address, plus request ceilings per
  address, per account and per day.
- A daily spend budget per account, plus an optional per-conversation ceiling,
  enforced on the server before the provider is contacted — not only by disabling
  the send button. It counts what the provider charged the user's own key, never
  the admin's simulated margin, so the stop and the number in the panel are the
  same money.
- Session cookies are `HttpOnly`, `SameSite=Lax`, `Secure` when the site is
  served over HTTPS, and every stored session is dropped when a password or a
  key changes.
- Step-up confirmation for administrator writes.
- Responses carry a Content-Security-Policy chosen per document: only the media
  studio may load a provider-hosted picture or clip, only the chat page may load a
  remote wallpaper, and an API reply may load nothing at all. `script-src` and
  `style-src` are `'self'` everywhere, with no `unsafe-inline` or `unsafe-eval`.
- Model answers are sanitised with DOMPurify before they reach the DOM, and a
  remote image in an answer is turned into a link rather than fetched.
- Nothing blocks F12, the right-click menu or view-source, and DevTools is not
  surveilled. That was tried and removed: it cannot stop anyone who owns their own
  browser, and it only punished ordinary use. The controls are the ones above.
- The upstream proxy accepts a fixed parameter list, so it cannot be aimed at an
  arbitrary URL and turned into an open relay.

## Reporting a problem

Open a **private** advisory under Security → Report a vulnerability rather than a
public issue, so the report is not itself a disclosure. Include the version or
commit, what you did, and what you expected instead. Nothing secret needs to be
in the report: no API keys, no session cookies, no database rows.
