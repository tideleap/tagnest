-- 0004_bookmark_urlkey_unique.sql
--
-- Make duplicate detection a database guarantee instead of an application
-- race.
--
-- Background: POST /api/bookmarks and /api/import commit both did a
-- check-then-insert with no database constraint, so two concurrent requests
-- for the same URL (extension one-click + the web app, or a double submit)
-- could both pass the lookup and write duplicate live bookmarks.
--
-- We add a PARTIAL unique index on live (non-deleted) rows:
--   (user_id, url_key) WHERE deleted_at IS NULL
-- A bookmark that has been moved to the trash (soft-deleted) keeps its url_key
-- free, so re-adding something the user trashed is still allowed — matching
-- the pre-existing POST semantics (conflict only against a live duplicate).
-- The old plain index is dropped (the partial one subsumes it).
--
-- The first statement de-duplicates rows that already slipped in before this
-- constraint existed. It keeps the NEWEST surviving copy per (user, url_key)
-- and soft-deletes older duplicates (marking them trashed), so nothing is
-- hard-deleted and the user can still restore from the trash if needed.

-- 1) Soft-delete (move to trash) any pre-existing live duplicates, keeping the
--    NEWEST live copy. Run per (user_id, url_key) that has more than one live row.
--    Soft-delete (not hard DELETE) so the older copies land in the trash and
--    the user can still restore them — no data is permanently lost.
UPDATE bookmarks
SET deleted_at = COALESCE(deleted_at, datetime('now')),
    updated_at = datetime('now')
WHERE id IN (
  SELECT id FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY user_id, url_key
        ORDER BY updated_at DESC, rowid DESC
      ) AS rn
    FROM bookmarks
    WHERE deleted_at IS NULL
  )
  WHERE rn > 1
);

-- 2) After 1), each (user_id, url_key) has at most one LIVE row, so a partial
--    unique index on live rows becomes satisfiable. Trashed duplicates carry
--    deleted_at != NULL and do not collide with the index predicate.
--    Re-adding a trashed bookmark is still allowed (matches POST semantics).

-- 3) Swap the plain index for a partial UNIQUE index.
DROP INDEX IF EXISTS idx_bm_user_urlkey;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bm_user_urlkey ON bookmarks (user_id, url_key) WHERE deleted_at IS NULL;
