-- 0026_tag_pending_status.sql
--
-- P2-3 (PRD-TAG-QUALITY-2026-08-30): the single-save "pending promotion"
-- mechanism.
--
-- Tags the AI mints on a one-bookmark save have no proof they are reusable —
-- historically each became a permanent library entry, which is exactly how the
-- owner's library accumulated 157 one-bookmark tags (70% singletons, see the
-- §4.7 baseline). A fresh AI-minted tag now starts `pending` and only becomes
-- a first-class `active` tag once a second live bookmark adopts it.
--
-- The column defaults to 'active' so every tag that already exists — and every
-- tag created outside the AI accept path (manual create, import, sync, feeds)
-- — keeps its current standing. Only `decideSuggestions` (the AI accept choke
-- point) ever writes 'pending', and it only ever demotes tags it created in
-- the same decision; it never re-grades a tag the user already had (P0-7).

ALTER TABLE tags ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

-- The promotion/reconciliation pass filters on status; pending tags are rare
-- but the scan happens on every AI accept, so keep it cheap.
CREATE INDEX IF NOT EXISTS idx_tags_user_status ON tags (user_id, status);
