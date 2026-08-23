-- 0024_primary_category.sql
--
-- CategorySync P1: from "tagging" to "placing".
--
-- The AI organiser so far produced *tags*: several loose labels per bookmark,
-- with no notion of where a bookmark uniquely belongs. The CategorySync
-- upgrade (docs/CATEGORY-SYNC-CS-2026-08-22.md, decisions D2/D4) needs
-- exactly one primary category per bookmark, because that single placement is
-- what later maps to a folder position in the browser's bookmark bar.
--
-- Two structural changes:
--
--  1. `bookmark_primary_category` — the single-placement table. One row per
--     bookmark (PRIMARY KEY on bookmark_id), pointing at a node of the tag
--     tree. The category *path* is never stored: it is derived by walking
--     `tags.parent_id` upwards, so the tree and the placement can never
--     disagree (same derivation principle as sync-pull's categoryPath).
--
--  2. `tag_suggestions.kind` — the review queue now carries two species of
--     proposal: 'tag' (the existing behaviour) and 'category' (a primary
--     placement). Keeping them in one table keeps the review UI unified
--     (PRD §10-1 decision). The pending-unique index is rebuilt to include
--     kind so a category proposal and a same-named tag proposal no longer
--     collide.
--
-- Note on `ai_jobs.kind`: migration 0006's comment lists 'organize'|'audit',
-- but the shipped code has always written 'tagging'. This migration adds no
-- schema change for jobs (kind is free-form TEXT); the live value set is now
-- 'tagging' | 'categorize'.

/* ------------------------------------------------------------------ *
 * 1) Single primary category per bookmark (decision D2)
 * ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS bookmark_primary_category (
  bookmark_id  TEXT PRIMARY KEY REFERENCES bookmarks (id) ON DELETE CASCADE,
  -- The category-tree node the bookmark belongs to: the deepest node of its
  -- path (a leaf, or an intermediate node when the path is short). The full
  -- path is derived via tags.parent_id — never stored here.
  tag_id       TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  -- AI confidence 0..1; NULL for manual / browser-folder placements.
  confidence   REAL,
  -- How the placement was decided: 'ai' | 'manual' | 'browser_folder' | 'import'.
  -- 'browser_folder' placements are protected from categorize jobs by default
  -- (PRD §10-6): a human move in the managed folder outranks the model (D5).
  source       TEXT NOT NULL DEFAULT 'ai',
  -- The categorize job that produced this placement, if any (undo support).
  job_id       TEXT,
  -- 'accepted' is the only live state today; pending/rejected are reserved
  -- so a future flow can review placements without another migration.
  status       TEXT NOT NULL DEFAULT 'accepted',
  decided_at   TEXT,
  updated_at   TEXT NOT NULL
);

-- Powers "every bookmark in this category" and category-tree counters.
CREATE INDEX IF NOT EXISTS idx_bpc_tag ON bookmark_primary_category (tag_id);
CREATE INDEX IF NOT EXISTS idx_bpc_status ON bookmark_primary_category (status);

/* ------------------------------------------------------------------ *
 * 2) Review queue: distinguish tag proposals from category proposals
 * ------------------------------------------------------------------ */
ALTER TABLE tag_suggestions ADD COLUMN kind TEXT NOT NULL DEFAULT 'tag';

-- The old index guaranteed one live proposal per (bookmark, name). With two
-- kinds sharing the table, a category proposal named "开发技术" would collide
-- with a same-named tag proposal. Rebuild with kind as the leading column so
-- each kind keeps its own one-live-proposal guarantee.
DROP INDEX IF EXISTS idx_sugg_pending_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sugg_pending_unique
  ON tag_suggestions (kind, bookmark_id, tag_name COLLATE NOCASE)
  WHERE status = 'pending';
