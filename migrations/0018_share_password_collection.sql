-- 0018_share_password_collection.sql
-- H1 share enhancements: password protection + collection-level shares.
--
-- password_hash: PBKDF2 digest in the same `pbkdf2$iterations$salt$digest`
-- format as users.password_hash (functions/_lib/auth.ts). NULL = the share is
-- open to anyone with the link, exactly as before this migration.
--
-- collection_id: when set, the share renders that collection's bookmarks
-- (ordered by collection_bookmarks.position) instead of running a tag query.
-- NULL = the legacy tag-filter mode. The two modes are mutually exclusive;
-- the API clears tag_ids when a collection is chosen.

ALTER TABLE shares ADD COLUMN password_hash TEXT;
ALTER TABLE shares ADD COLUMN collection_id TEXT;
