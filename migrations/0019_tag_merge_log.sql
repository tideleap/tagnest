-- 0019: tag merge audit log (T1 tag governance)
--
-- Every merge through POST /api/tags/merge writes one row here. Source tags
-- are deleted by the merge itself, so the row snapshots names rather than
-- relying on ids that would soon point at nothing.
CREATE TABLE IF NOT EXISTS tag_merge_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  target_tag_id TEXT NOT NULL,
  target_tag_name TEXT NOT NULL,
  source_tag_names TEXT NOT NULL,
  merged_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tag_merge_log_user ON tag_merge_log (user_id, created_at DESC);
