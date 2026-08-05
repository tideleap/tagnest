-- 0010_collections.sql
-- User-curated named sets of bookmarks (distinct from free-form tags and
-- from tab groups). A collection is the persistent, shareable "reading list".

CREATE TABLE IF NOT EXISTS collections (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  color_index  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_collections_user ON collections(user_id);

CREATE TABLE IF NOT EXISTS collection_bookmarks (
  collection_id TEXT NOT NULL,
  bookmark_id   TEXT NOT NULL,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (collection_id, bookmark_id)
);
CREATE INDEX IF NOT EXISTS idx_collection_bookmarks_collection ON collection_bookmarks(collection_id);
CREATE INDEX IF NOT EXISTS idx_collection_bookmarks_bookmark ON collection_bookmarks(bookmark_id);
