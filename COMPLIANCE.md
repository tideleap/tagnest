# Compliance & Third-Party Notices

_This document is the authoritative record for TagNest's licensing posture and
third-party attribution. It is maintained as part of the codebase so the
commercial-readiness claims it makes are verifiable by inspection._

- **Compliance status:** CLEAN ROOM – independent implementation, MIT licensed.
- **Last audit:** 2026-08-02

---

## 1. Clean-room statement

TagNest is an **independent, from-scratch reimplementation** of the *concept* of
a web bookmark manager. It shares **no source code, no design files, no copy,
no third-party visual assets, and no documentation wording** with the upstream
project it is conceptually inspired by.

The upstream project **tmarks** is distributed under the
**Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)**,
which **prohibits commercial use** of that project's material. TagNest is not a
derivative of tmarks and makes no use of its protected material; it is released
under the permissive **MIT License** (see `LICENSE`) so it can be self-hosted or
used commercially without restriction.

Verification performed during the 2026-08-02 audit:

| Dimension | Finding |
|---|---|
| Directory layout | Shares only the standard Cloudflare Pages / Vite layout (`src`, `functions`, `migrations`, `shared`, `public`, `scripts`). Backend internals differ (`functions/_lib/*` vs upstream `functions/lib/* + middleware/*`). |
| Component / page naming | **Zero same-named files.** Upstream uses domain-based PascalCase modules (`BookmarkListView`, `TabGroupTree`, …); TagNest uses small technical modules (`ui/Button`, `pages/ImportPage`, …). |
| Source comments | No overlapping comment text; different languages and conventions (English in TagNest vs upstream's Chinese header blocks). |
| Utility / core functions | Differently named and differently implemented (`ids.newId`/`randomToken` vs upstream `crypto.generateUUID`; `http.ApiException`/`badRequest` vs upstream `response.success/badRequest`; AES-256-GCM field encryption vs upstream PBKDF2 hashing). |
| Database schema | Different table designs (`sessions`, `shares`, `auth_attempts`, `tag_suggestions`, `ai_jobs` vs upstream `auth_tokens`, `api_key_rate_limits`, `users.public_slug`, …). Only generic domain names overlap (`users`, `bookmarks`, `tags`, `bookmark_tags`). |
| README / docs | TagNest README is an original English document with its own structure, feature set, and explicit clean-room notice. |
| Logo & assets | TagNest ships its own original SVG favicon and generated PWA icons. Upstream ships **no** raster/SVG/logo assets to reuse. |
| Source references | `grep` for `tmarks|TMarks|上游|tmarks team` against `src/`, `functions/`, `shared/`, `migrations/` returns **zero** hits. |

---

## 2. TagNest license

TagNest is licensed under the **MIT License**. See the `LICENSE` file in this
repository root for the full text.

> Copyright (c) 2026 The TagNest Authors
> MIT License — permission granted to use, copy, modify, merge, publish,
> distribute, sublicense, and sell copies of the Software.

---

## 3. Third-party dependency licenses

All runtime and build dependencies are **permissive open-source** licenses
(MIT, ISC, Apache-2.0). There are **no** GPL/AGPL, no CC-BY-NC, and no
commercial-restriction licenses among the dependency set. Each dependency's
license notice remains with its own package under `node_modules`; the table
below records the top-level license for attribution.

### Runtime dependencies

| Package | Version | License |
|---|---|---|
| `@tanstack/react-query` | ^5 | MIT |
| `@tanstack/react-virtual` | ^3 | MIT |
| `clsx` | ^2 | MIT |
| `lucide-react` | ^0.469 | ISC |
| `react` / `react-dom` | ^18.3 | MIT |
| `react-router-dom` | ^7 | MIT |
| `zustand` | ^5 | MIT |

### Build / dev dependencies

| Package | License |
|---|---|
| `@cloudflare/workers-types` | MIT OR Apache-2.0 |
| `@eslint/js`, `eslint`, `eslint-plugin-react-hooks` | MIT |
| `@tailwindcss/vite`, `tailwindcss` | MIT |
| `@testing-library/*` | MIT |
| `@vitejs/plugin-react`, `vite`, `vitest`, `@vitest/coverage-v8` | MIT |
| `globals`, `happy-dom`, `typescript-eslint` | MIT |
| `@types/*` | MIT |
| `typescript` | Apache-2.0 |
| `wrangler` | MIT OR Apache-2.0 |

> **Note on Tailwind CSS and the shadcn/ui design language.** TagNest uses
> Tailwind CSS (MIT) and independently defines its own design tokens. Any
> resemblance of token *names* (e.g. `--primary`, `--background`) to the
> widely-used `shadcn/ui` convention stems from that shared community design
> system, which is MIT-licensed and used across thousands of projects — it is a
> common technical standard, not copied project-specific expression.

---

## 4. Fonts

TagNest uses system font stacks (`Inter`, `-apple-system`, `PingFang SC`,
`Microsoft YaHei`, `Noto Sans SC`, `Segoe UI`) and does not self-host or bundle
any proprietary web-font files. Using system fonts avoids any font-embedding
license obligation.

---

## 5. Icons & imagery

- **App icon / favicon:** an original inline SVG (a rounded-square with a
  bookmark glyph and dot) authored for TagNest. Not derived from any upstream
  asset.
- **PWA icons:** generated locally for TagNest (192px / 512px).
- **Feature/UI icons:** from the `lucide-react` package (ISC license) — an
  open-source icon set, redistributable with attribution under its MIT/ISC
  terms.
- No stock photos, no commercial fonts, no bundled third-party imagery.

---

## 6. Obligations & how TagNest satisfies them

| Obligation | Satisfied by |
|---|---|
| Include this/upstream provenance transparency | Clean-room notice in README + this document |
| Redistribute dependency license texts | Upstream notices ship inside `node_modules` and are republished by the standard build toolchain |
| Notify of non-commercial upstream | Not applicable — TagNest shares no code with the CC BY-NC upstream and thus incurs no CC obligation |
| No tracking/telemetry of user content | TagNest is self-hosted; AI endpoint is opt-in and inert until a provider key is set |

---

## 7. Commercialization checklist (see also docs)

Before a commercial launch, confirm in order: (1) this document and
`LICENSE` are included in any distribution; (2) dependency lockfile is pinned
and its licenses re-audited in CI; (3) all `public/` assets are original or
permissively licensed; (4) any contributed third-party code is audited on
merge. TagNest is cleared on all four as of 2026-08-02.
