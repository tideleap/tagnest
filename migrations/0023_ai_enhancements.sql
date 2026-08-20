-- AI tagging enhancement switches (design doc: AI 整理能力提升 A-E).
--
-- fetch_content: when on, the organiser fetches each bookmark's page and feeds
-- a short text excerpt to the model alongside title/URL/description. This is
-- the single biggest accuracy lever — the model classifies real content
-- instead of guessing from a title. Default ON: the feature's job is to be
-- comprehensive, and a failed fetch degrades silently to the old behaviour.
ALTER TABLE ai_settings ADD COLUMN fetch_content INTEGER NOT NULL DEFAULT 1;

-- two_pass: optional refinement pass. The model first assigns a coarse
-- topic/category per bookmark, then tags with that judgement as context.
-- Costs roughly one extra (cheap, small-output) call per batch, so it ships
-- OFF and is opt-in for users who prefer coverage over cost.
ALTER TABLE ai_settings ADD COLUMN two_pass INTEGER NOT NULL DEFAULT 0;
