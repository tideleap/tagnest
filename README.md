# TagNest

A fast, keyboard-first bookmark manager. TagNest is a from-scratch, MIT-licensed
implementation of the ideas behind the *tmarks* bookmark manager, built on a
modern Cloudflare stack (Pages Functions + D1 + FTS5) with a React/TypeScript
front end.

> **Clean-room notice.** This project is an independent, clean-room reimplementation.
> The upstream *tmarks* project is distributed under **CC BY-NC 4.0**, which
> prohibits commercial use. TagNest shares **no source code** with that project:
> it was designed and written independently against the published feature list,
> and is released under the permissive **MIT** license so it can be self-hosted
> or used commercially without restriction.

## Live

TagNest is deployed and verified end-to-end on Cloudflare Pages:

- **Production URL:** https://tagnest.pages.dev
- **Back end:** Cloudflare Pages Functions + D1 (`tagnest-db`, region APAC) with an
  `fts5` trigram full-text index.
- **Auth:** PBKDF2-HMAC-SHA256 + HS256 JWT access tokens with rotating httpOnly
  refresh cookies, using a production `JWT_SECRET` (set via `wrangler pages secret put`).
- **Verified:** register → list → create → FTS5 search all succeed against the live
  database; `/api/health` reports `{"status":"ok","database":"ok"}`.

## Features

- **Full-text search that works for Chinese.** A D1/SQLite `fts5` index using the
  `trigram` tokenizer, so Chinese substrings and mid-word Latin matches both
  resolve. Queries shorter than three characters fall back to `LIKE` automatically.
- **Keyboard-first UI.** Vim-style navigation, instant command palette, and
  keyset-paginated list views that stay smooth at scale.
- **Folders become tags.** Importing a Netscape bookmark file turns its folder
  hierarchy into tags; duplicates are detected by a normalized URL key that
  strips `utm_*`/`gclid`/`fbclid` and other tracking parameters.
- **Multi-source import.** Netscape HTML, JSON (TagNest / array / `{bookmarks}`
  / `{items}`), and CSV — all staged for a preview before anything is written.
- **Scopes & bulk ops.** Inbox / all / favorites / archive / trash, plus bulk
  tag, soft-delete, restore, and purge.
- **Tenant isolation.** Every query is scoped by `user_id`; cross-account access
  is rejected at the data layer, not by convention.
- **Auth.** PBKDF2-HMAC-SHA256 password hashing and HS256 JWT access tokens with
  rotating, httpOnly refresh cookies.
- **Personal API keys.** Generate scoped (`read`/`write`) access tokens for the
  browser extension or scripts; only a SHA-256 digest is stored, and keys can be
  revoked at any time. A key can never be used to mint more keys.
- **Drag-to-reorder.** Arrange bookmarks manually with drag and drop; the order is
  persisted per user and coexists with sort-by-date/title/visits.
- **Public share pages.** Publish a live, filtered view of your bookmarks at a
  short `/s/:slug` link, with optional expiry, theme, and edge caching.
- **Login throttling.** Failed logins and registrations are rate-limited per IP
  and email to resist brute-force attempts.
- **Field-level encryption.** AI provider keys are sealed with AES-256-GCM before
  they touch the database, so a D1 export never contains live credentials.
- **AI-ready.** The settings UI and API persist an AI provider configuration (and
  only a `hasApiKey` flag is returned to the client); the provider key is stored
  encrypted. Auto-tag / auto-summarize is wired to call the configured provider
  when a key and model are set.

## Tech stack

| Layer        | Choice                                                        |
|--------------|--------------------------------------------------------------|
| Front end    | React 18, TypeScript, Vite 6, Tailwind CSS v4, Zustand, TanStack Query / Virtual |
| Back end     | Cloudflare Pages Functions (Workers), TypeScript            |
| Database     | Cloudflare D1 (SQLite) with `fts5` trigram search           |
| Auth         | WebCrypto PBKDF2 + HMAC-SHA256 (JWT)                         |
| Tests        | Vitest (unit) + `scripts/smoke.sh` (end-to-end)             |

## Project layout

```
tagnest/
  src/                 React front end (UI, store, API client)
  functions/           Cloudflare Pages Functions
    _lib/              Shared back-end logic (auth, db, urlkey, import-parsers, ids)
    api/               Route handlers (auth, bookmarks, tags, import, export, stats, ai)
  migrations/          D1 schema (0001_init.sql)
  shared/              Types shared by front end and back end
  scripts/smoke.sh     End-to-end smoke test
  tests/               Vitest unit tests (backend logic)
  wrangler.toml        Pages + D1 binding config
```

## Local development

Prerequisites: Node 22+, and the Cloudflare CLI (`wrangler`) which is installed
as a dev dependency.

```bash
npm install

# Run the front end (Vite dev server on :5173, proxies /api to :8788)
npm run dev

# In a second terminal, run the API + D1 locally (Miniflare)
npm run dev:api

# Apply the D1 schema to the local database (idempotent)
npm run db:migrate:local

# Front-end unit tests
npm test

# End-to-end smoke test (expects `npm run dev:api` running on :8788)
bash scripts/smoke.sh
```

> **Secrets.** Locally, `JWT_SECRET` falls back to an insecure development secret
> (a warning is printed). Before deploying, set a real secret:
> `wrangler pages secret put JWT_SECRET`.

## Database migrations

```bash
npm run db:migrate:local     # local (Miniflare SQLite)
npm run db:migrate           # remote (Cloudflare D1)
```

The schema lives in `migrations/0001_init.sql` and includes the `bookmarks_fts`
trigram virtual table with insert/delete/update triggers kept in sync with
`bookmarks`.

## Deployment (Cloudflare Pages)

1. Create the D1 database once: `npm run db:create` (note the database ID).
2. Apply the schema remotely: `npm run db:migrate`.
3. Set the JWT secret: `wrangler pages secret put JWT_SECRET`.
4. Build and deploy: `npm run deploy` (runs `vite build` then `wrangler pages deploy`).

`wrangler.toml` binds the database as `DB` and sets `DISABLE_SIGNUP` (default
`false`); flip it to `true` after creating your account to close public
registration.

> This project is already deployed to **https://tagnest.pages.dev**. To ship an
> update, just run `npm run deploy` (it builds `dist/` and runs
> `wrangler pages deploy`). The D1 schema and `JWT_SECRET` are already provisioned;
> only code changes need redeploying.

## License

[MIT](./LICENSE). TagNest is a clean-room, independent implementation and is not
affiliated with the upstream *tmarks* project.
