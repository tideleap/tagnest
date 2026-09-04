-- 0028_suggestion_job_index.sql
--
-- D-6（第二轮审计）: composite (user_id, job_id, status, kind) index on
-- tag_suggestions.
--
-- The job-scoped hot paths all filter `user_id = ? AND job_id = ?` plus
-- status/kind, but no existing index starts with that pair:
--   - autoApply / autoApplyCategories:
--       WHERE user_id=? AND job_id=? AND kind=? AND status='pending' ...
--   - countJobNewTags:
--       WHERE user_id=? AND job_id=? AND tag_id IS NULL
--   - listPendingSuggestions / countPending with a jobId (B-20):
--       WHERE user_id=? AND status='pending' AND job_id=? [AND kind=?]
--
-- idx_sugg_job (job_id) alone forces a scan of every user's rows for the job
-- before the user filter; idx_sugg_user_status (user_id, status, ...) cannot
-- narrow by job without scanning all of the user's pending rows across every
-- historical job. With all four leading columns as equality predicates the
-- auto-apply paths become a direct seek; countJobNewTags uses the
-- (user_id, job_id) prefix.
--
-- The job-less nav-badge path (countPending without jobId) keeps using
-- idx_sugg_user_status; this index complements rather than replaces it.

CREATE INDEX IF NOT EXISTS idx_sugg_user_job_status_kind
  ON tag_suggestions (user_id, job_id, status, kind);
