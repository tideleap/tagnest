-- TagNest initial schema (Cloudflare D1 / SQLite)
--
-- Design notes:
--   * All timestamps are ISO-8601 UTC strings. SQLite has no native date type
--     and text sorts lexicographically in chronological order, so ORDER BY on
--     these columns is correct without any conversion.
--   * Booleans are INTEGER 0/1.
--   * Every user-owned table carries user_id and every query filters on it.
--     Tenant isolation is enforced in the WHERE clause, not by convention.

PRAGMA foreign_keys = ON;

/* ------------------------------------------------------------------ *
 * Users & sessions
 * ------------------------------------------------------------------ */

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  avatar_url    TEXT,
  -- Format: pbkdf2$<iterations>$<salt_b64>$<hash_b64>. Storing the parameters
  -- alongside the digest lets the cost be raised later without a flag day.
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Case-insensitive uniqueness: Foo@x.com and foo@x.com are the same account.
CREATE UNIQUE INDEX idx_users_email ON users (email COLLATE NOCASE);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- SHA-256 of the refresh token. A database leak must not yield usable
  -- session credentials.
  token_hash TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_sessions_token ON sessions (token_hash);
CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

/* ------------------------------------------------------------------ *
 * Tags
 * ------------------------------------------------------------------ */

CREATE TABLE tags (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color_index INTEGER NOT NULL DEFAULT 0,
  parent_id   TEXT REFERENCES tags (id) ON DELETE SET NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

-- Prevents the "work" / "Work" duplicate pair that plagues tag systems.
CREATE UNIQUE INDEX idx_tags_user_name ON tags (user_id, name COLLATE NOCASE);
CREATE INDEX idx_tags_parent ON tags (parent_id);

/* ------------------------------------------------------------------ *
 * Bookmarks
 * ------------------------------------------------------------------ */

CREATE TABLE bookmarks (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  url             TEXT NOT NULL,
  -- Normalised form (scheme/host lowercased, tracking params and trailing
  -- slash stripped) used only for duplicate detection on import.
  url_key         TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  description     TEXT,
  favicon_url     TEXT,
  cover_url       TEXT,
  note            TEXT,
  -- Reserved for the AI feature. Written by nothing today.
  ai_summary      TEXT,
  is_favorite     INTEGER NOT NULL DEFAULT 0,
  is_archived     INTEGER NOT NULL DEFAULT 0,
  visit_count     INTEGER NOT NULL DEFAULT 0,
  last_visited_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  -- Soft delete. NULL means live; a timestamp means it sits in the trash.
  deleted_at      TEXT
);

-- Covers the default library view: one user, not deleted, newest first.
CREATE INDEX idx_bm_user_live_created ON bookmarks (user_id, deleted_at, created_at DESC);
CREATE INDEX idx_bm_user_live_updated ON bookmarks (user_id, deleted_at, updated_at DESC);
CREATE INDEX idx_bm_user_live_visits ON bookmarks (user_id, deleted_at, visit_count DESC);
CREATE INDEX idx_bm_user_urlkey ON bookmarks (user_id, url_key);
CREATE INDEX idx_bm_user_favorite ON bookmarks (user_id, is_favorite, deleted_at);
CREATE INDEX idx_bm_user_archived ON bookmarks (user_id, is_archived, deleted_at);

CREATE TABLE bookmark_tags (
  bookmark_id TEXT NOT NULL REFERENCES bookmarks (id) ON DELETE CASCADE,
  tag_id      TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (bookmark_id, tag_id)
);

-- The reverse lookup (all bookmarks carrying a tag) needs its own index;
-- the composite primary key only serves bookmark_id lookups.
CREATE INDEX idx_bt_tag ON bookmark_tags (tag_id);

/* ------------------------------------------------------------------ *
 * Full-text search
 *
 * The trigram tokenizer is deliberate: the default unicode61 tokenizer treats
 * an entire run of CJK characters as a single token, which makes Chinese
 * search useless. Trigram indexes 3-character windows, so substring matching
 * works for Chinese and for mid-word Latin matches alike.
 *
 * Queries shorter than 3 characters cannot use a trigram index; the API falls
 * back to LIKE for those, and also if MATCH raises at runtime.
 * ------------------------------------------------------------------ */

CREATE VIRTUAL TABLE bookmarks_fts USING fts5 (
  title,
  description,
  note,
  url,
  content = 'bookmarks',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);

CREATE TRIGGER bookmarks_fts_ai AFTER INSERT ON bookmarks BEGIN
  INSERT INTO bookmarks_fts (rowid, title, description, note, url)
  VALUES (new.rowid, new.title, COALESCE(new.description, ''), COALESCE(new.note, ''), new.url);
END;

CREATE TRIGGER bookmarks_fts_ad AFTER DELETE ON bookmarks BEGIN
  INSERT INTO bookmarks_fts (bookmarks_fts, rowid, title, description, note, url)
  VALUES ('delete', old.rowid, old.title, COALESCE(old.description, ''), COALESCE(old.note, ''), old.url);
END;

CREATE TRIGGER bookmarks_fts_au AFTER UPDATE ON bookmarks BEGIN
  INSERT INTO bookmarks_fts (bookmarks_fts, rowid, title, description, note, url)
  VALUES ('delete', old.rowid, old.title, COALESCE(old.description, ''), COALESCE(old.note, ''), old.url);
  INSERT INTO bookmarks_fts (rowid, title, description, note, url)
  VALUES (new.rowid, new.title, COALESCE(new.description, ''), COALESCE(new.note, ''), new.url);
END;

/* ------------------------------------------------------------------ *
 * AI settings — persisted, inert
 *
 * The UI writes here and reads back. No request is ever made to a provider.
 * ------------------------------------------------------------------ */

CREATE TABLE ai_settings (
  user_id           TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  provider          TEXT NOT NULL DEFAULT 'none',
  base_url          TEXT,
  model             TEXT,
  -- Never returned to the client; the API only exposes hasApiKey.
  api_key_encrypted TEXT,
  auto_summarize    INTEGER NOT NULL DEFAULT 0,
  auto_tag          INTEGER NOT NULL DEFAULT 0,
  enabled           INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL
);

/* ------------------------------------------------------------------ *
 * Import staging
 *
 * Preview parses the file once and stages the result; commit reads it back.
 * Without this the file would have to be uploaded twice, and the counts shown
 * in the preview could differ from what actually gets written.
 * ------------------------------------------------------------------ */

CREATE TABLE import_staging (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source     TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_import_expires ON import_staging (expires_at);
