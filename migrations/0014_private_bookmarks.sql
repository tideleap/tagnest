-- 0014_private_bookmarks.sql
--
-- Private (encrypted) bookmarks — a zero-knowledge vault.
--
-- Design: a bookmark the user marks private is encrypted in the BROWSER with a
-- key derived from a user-chosen passphrase (PBKDF2 + AES-GCM). The server
-- never sees the plaintext and never holds the key. It stores only:
--   * the ciphertext blob (`encrypted_blob`), and
--   * `is_private = 1`, which makes the row invisible to every normal query.
--
-- Why store the row at all (rather than delete it)? So the bookmark keeps its
-- tags-less identity, its created_at lineage, and can be restored by the owner
-- after they unlock the vault — the client re-supplies the decrypted fields and
-- we flip is_private back to 0. While private, the readable columns are blanked
-- and the bookmark's tag links are removed, so it cannot surface in any tag
-- view, share, search, or stat.
--
-- 1) Add the privacy columns to bookmarks.
ALTER TABLE bookmarks ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookmarks ADD COLUMN encrypted_blob TEXT;

-- 2) Per-user vault record: holds the PBKDF2 salt and a verifier (an
--    AES-GCM encryption of a known constant) so the client can confirm a
--    typed passphrase is correct before attempting to decrypt anything. The
--    server cannot derive the key — it only stores these opaque values.
CREATE TABLE IF NOT EXISTS private_vault (
  user_id     TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  salt        TEXT NOT NULL,
  verifier    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 3) Index that backs the "list my private bookmarks" and "exclude private
--    from everything else" scans.
CREATE INDEX IF NOT EXISTS idx_bm_user_private ON bookmarks (user_id, is_private, deleted_at);
