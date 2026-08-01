-- TagNest tab groups (O12)
--
-- A tab group is a user-curated ordered set of existing bookmarks — the manual
-- half of "save my open tabs as a session". The browser-extension half (capture
-- the live window) is a separate feature (O10); here we only model the data.
--
-- Tenant isolation follows the same rule as every other table: user_id on the
-- owning row, and every read filters on it. Cascades keep the two tables in
-- lock-step with users and bookmarks.

CREATE TABLE IF NOT EXISTS tab_groups (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color_index INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- The group list is shown per-user, newest activity first within a sort bucket.
CREATE INDEX IF NOT EXISTS idx_tg_user ON tab_groups (user_id, sort_order, created_at DESC);

CREATE TABLE IF NOT EXISTS tab_items (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  group_id    TEXT NOT NULL REFERENCES tab_groups (id) ON DELETE CASCADE,
  bookmark_id TEXT NOT NULL REFERENCES bookmarks (id) ON DELETE CASCADE,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  -- A bookmark may only appear once per group; INSERT OR IGNORE makes the
  -- add endpoint idempotent instead of erroring on a repeat click.
  UNIQUE (group_id, bookmark_id)
);

-- Items are read by group in display order; the index covers the ORDER BY.
CREATE INDEX IF NOT EXISTS idx_ti_group ON tab_items (group_id, position);
CREATE INDEX IF NOT EXISTS idx_ti_user ON tab_items (user_id);
