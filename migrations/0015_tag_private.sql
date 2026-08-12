-- 0015: tag-level privacy.
--
-- Marking a tag private hides every bookmark that carries it (and, via the
-- cascade in setTagPrivate, every descendant tag) from all normal list /
-- search / stats / share / export views. The hiding is derived in SQL
-- (PRIVATE_BOOKMARK_CLAUSE) rather than materialised per bookmark, so it is
-- real-time: adding a bookmark to a private tag hides it instantly, and
-- unsetting the tag restores visibility instantly. No bookmark plaintext is
-- altered — this is a "hide, not encrypt" control distinct from the
-- per-bookmark zero-knowledge vault.

ALTER TABLE tags ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_tags_user_private ON tags (user_id, is_private);
