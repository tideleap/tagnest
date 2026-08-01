-- TagNest migration 0002
--
-- Adds the storage for four features that shipped together:
--   * login throttling      (auth_attempts)
--   * personal access keys  (api_keys)
--   * manual drag ordering  (bookmarks.manual_order)
--   * public share pages    (shares)
--
-- Conventions follow 0001: ISO-8601 UTC text timestamps, INTEGER booleans,
-- user_id on every owned row.

PRAGMA foreign_keys = ON;

/* ------------------------------------------------------------------ *
 * Login throttling
 *
 * One row per failed attempt, bucketed by IP and by email. Counting rows in
 * a time window is cheap enough at this scale and needs no background job:
 * expired rows are deleted opportunistically on each check.
 * ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS auth_attempts (
  id         TEXT PRIMARY KEY,
  -- "ip:<addr>" or "email:<addr>"; the prefix keeps the two namespaces apart.
  bucket     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_attempts_bucket ON auth_attempts (bucket, created_at);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_created ON auth_attempts (created_at);

/* ------------------------------------------------------------------ *
 * Personal access keys
 *
 * Issued for the browser extension and scripts, which cannot run the
 * 15-minute JWT refresh dance. Only the SHA-256 digest is stored, so a
 * database leak yields no usable credential; the plaintext is shown once.
 * ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  -- Leading characters of the plaintext, kept so the UI can identify a key
  -- without being able to reconstruct it.
  prefix       TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  -- Comma-separated subset of {read,write}.
  scopes       TEXT NOT NULL DEFAULT 'read,write',
  last_used_at TEXT,
  created_at   TEXT NOT NULL,
  expires_at   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (token_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id, created_at DESC);

/* ------------------------------------------------------------------ *
 * Manual ordering
 *
 * Sparse integers (steps of 1000) so a single reorder rewrites only the moved
 * rows in the common case. 0 means "never positioned"; those sort last and
 * fall back to created_at.
 * ------------------------------------------------------------------ */

ALTER TABLE bookmarks ADD COLUMN manual_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_bm_user_manual ON bookmarks (user_id, deleted_at, manual_order DESC);

/* ------------------------------------------------------------------ *
 * Public shares
 *
 * A share is a saved query, not a snapshot: it stores the tag filter and
 * renders live results. Revoking is therefore instant and there is no copy of
 * the data to keep in sync.
 * ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS shares (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- URL segment; unique across all users because the public route is flat.
  slug           TEXT NOT NULL,
  title          TEXT NOT NULL,
  description    TEXT,
  -- JSON array of tag ids. An empty array means "every live bookmark".
  tag_ids        TEXT NOT NULL DEFAULT '[]',
  match_all_tags INTEGER NOT NULL DEFAULT 0,
  include_notes  INTEGER NOT NULL DEFAULT 0,
  theme          TEXT NOT NULL DEFAULT 'default',
  is_active      INTEGER NOT NULL DEFAULT 1,
  view_count     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  expires_at     TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_slug ON shares (slug);
CREATE INDEX IF NOT EXISTS idx_shares_user ON shares (user_id, created_at DESC);
