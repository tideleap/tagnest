-- 0017_collections_name_unique.sql
--
-- Make duplicate collection names a database guarantee instead of an
-- application race.
--
-- Background: POST /api/collections and PUT /api/collections/:id both did a
-- check-then-write with no database constraint, so two concurrent requests for
-- the same name could both pass the lookup and write duplicate rows. Tags have
-- had idx_tags_user_name since migration 0001 and bookmarks got a partial
-- unique index in migration 0004 — collections were the remaining named-entity
-- table with no uniqueness backstop.
--
-- We add a unique index on (user_id, name COLLATE NOCASE), matching the
-- case-insensitive duplicate check the API already performs.
--
-- First we resolve any rows that already slipped in before this constraint
-- existed. Nothing is hard-deleted: the NEWEST row per (user, name) keeps the
-- name, and each older duplicate is renamed with a " (<rowid>)" suffix so all
-- data survives and the index can be created. rowid is unique per row, so the
-- renamed rows cannot collide with one another.

-- 1) Rename older duplicates. A row is an "older duplicate" when another row
--    with the same (user_id, name COLLATE NOCASE) is newer — higher updated_at,
--    or the same updated_at but a higher rowid. The newest row of each group has
--    no newer peer, so it is never renamed and keeps the original name.
UPDATE collections
SET name = name || ' (' || rowid || ')'
WHERE EXISTS (
  SELECT 1
  FROM collections AS newer
  WHERE newer.user_id = collections.user_id
    AND newer.name = collections.name COLLATE NOCASE
    AND newer.rowid != collections.rowid
    AND (
      newer.updated_at > collections.updated_at
      OR (newer.updated_at = collections.updated_at AND newer.rowid > collections.rowid)
    )
);

-- 2) After 1), each (user_id, name COLLATE NOCASE) has at most one row, so the
--    unique index becomes satisfiable.
CREATE UNIQUE INDEX IF NOT EXISTS idx_collections_user_name
  ON collections (user_id, name COLLATE NOCASE);
