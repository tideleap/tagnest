-- 0008_snapshot_retention.sql
--
-- Snapshot retention policy (multi-snapshot history + per-user retention cap).
--
-- Two related additions:
--
--  1. `user_settings` — per-user preferences, modelled on `ai_settings`.
--     `snapshot_retention_limit` controls how many snapshots up to which a
--     bookmark may keep (default 5; -1 = unlimited). It is a soft cap: when a
--     new snapshot would push a bookmark past the limit, the OLDEST snapshots
--     are pruned to bring it back under.
--
--  2. `bookmarks.snapshot_keys` — a JSON array of the R2 object keys of a
--     bookmark's CURRENTLY RETAINED snapshots, ordered oldest → newest. Unlike
--     the legacy single `snapshot_key` (the latest, kept for card preview and
--     backward compatibility), this column lists the whole history so the
--     detail panel can show older captures and the pruner knows what to drop.

CREATE TABLE IF NOT EXISTS user_settings (
  user_id                TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  snapshot_retention_limit INTEGER NOT NULL DEFAULT 5,
  updated_at             TEXT NOT NULL
);

-- -1 means "unlimited" and is allowed by design; 0 is rejected by the API.
-- No CHECK here so the default and the -1 sentinel are straightforward, and
-- validation lives in the settings endpoint (mirrors how ai_settings works).

-- NOTE: `snapshot_key` keeps meaning "latest snapshot" for the card; the new
-- list column is authoritative for retention. NULL until snapshots exist.
ALTER TABLE bookmarks ADD COLUMN snapshot_keys TEXT;
