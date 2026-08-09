-- 0013_prompt_version.sql
--
-- Phase 5 (observability & evaluation).
--
-- The AI organiser's value is a claim until it can be measured. Phase 2 made
-- every accept / reject / modify flow back into `ai_feedback`; Phase 3/4 made
-- the user's decisions visible and editable. What was still missing was the
-- ability to ask "did this prompt do better than the last one?"
--
-- `prompt_version` stamps every run with the prompt template that produced its
-- suggestions. Because each accepted suggestion is tied to a job (via
-- `tag_suggestions.job_id`) and each job now carries a version, the acceptance
-- rate of two prompt revisions can be compared head-to-head — the minimum
-- requirement for any honest A/B of the model's instructions.
--
-- Adding a nullable TEXT column is a non-destructive, online-friendly change:
-- old jobs simply read as version "unknown" until re-run, and nothing that
-- joins on the primary key is affected.

ALTER TABLE ai_jobs ADD COLUMN prompt_version TEXT;
