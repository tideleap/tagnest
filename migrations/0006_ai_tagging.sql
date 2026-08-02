-- 0006_ai_tagging.sql
--
-- Promote AI tagging from a fire-and-forget side effect to a reviewable,
-- auditable workflow.
--
-- Three things were structurally impossible before this migration, and each
-- one capped how much responsibility the model could be given:
--
--  1. **No provenance.** `bookmark_tags` held only (bookmark_id, tag_id), so a
--     tag the model invented was indistinguishable from one the user typed.
--     Without that distinction you cannot offer "undo everything the AI did",
--     cannot show a confidence, and cannot honestly measure whether the AI is
--     contributing anything. Letting a model write directly into an
--     indistinguishable store is exactly why it had to stay switched off.
--
--  2. **No holding area.** A suggestion had to be either applied immediately
--     or discarded. Human-in-the-loop review needs a place for a proposal to
--     sit while the user decides.
--
--  3. **No progress.** Organising 5,000 bookmarks is a long job. With no job
--     record the UI could only spin, and a disconnect lost everything.
--
-- Together these turn the model from "a thing that may quietly mutate your
-- library" into "a thing that proposes, shows its reasoning, and waits".

/* ------------------------------------------------------------------ *
 * 1) Provenance on the bookmark <-> tag join
 *
 * `source` is the load-bearing column: 'user' | 'ai' | 'import'.
 * Existing rows default to 'user' — they were all either typed or explicitly
 * confirmed during import, so attributing them to the human is correct and
 * keeps the AI contribution metric honest (it starts at zero).
 * ------------------------------------------------------------------ */
ALTER TABLE bookmark_tags ADD COLUMN source TEXT NOT NULL DEFAULT 'user';

-- Model-reported confidence, 0..1. NULL for anything a human applied.
ALTER TABLE bookmark_tags ADD COLUMN confidence REAL;

-- When the link was made. Nullable: back-filling a real timestamp for historic
-- rows would be a fabrication, and NULL reads as "before we tracked this".
ALTER TABLE bookmark_tags ADD COLUMN created_at TEXT;

-- Powers "show me everything the AI tagged" and the contribution stats.
CREATE INDEX IF NOT EXISTS idx_bt_source ON bookmark_tags (source);

/* ------------------------------------------------------------------ *
 * 2) Aliases: the taxonomy's memory
 *
 * A JSON array of alternative spellings folded into this tag, e.g. the tag
 * "前端" carrying ["frontend", "front-end", "前端开发"]. The normaliser
 * consults it before creating anything new, so a merge performed once keeps
 * paying off: every future model run that emits "Frontend" resolves to the
 * existing tag instead of splitting the taxonomy again.
 * ------------------------------------------------------------------ */
ALTER TABLE tags ADD COLUMN aliases TEXT;

/* ------------------------------------------------------------------ *
 * 3) Suggestions: the holding area between model and library
 *
 * A row here is a proposal, not a fact. Nothing in the library changes until
 * the user accepts it (or auto-accept is switched on above a confidence
 * threshold).
 * ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS tag_suggestions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  bookmark_id TEXT NOT NULL REFERENCES bookmarks (id) ON DELETE CASCADE,
  -- Which batch produced this. NULL for one-off single-bookmark suggestions.
  job_id      TEXT,
  -- The proposed name as it will be written. Already normalised against the
  -- existing taxonomy, so accepting it usually reuses a tag rather than
  -- creating one.
  tag_name    TEXT NOT NULL,
  -- Resolved when the proposal matched an existing tag; NULL means accepting
  -- creates a new tag.
  tag_id      TEXT REFERENCES tags (id) ON DELETE SET NULL,
  confidence  REAL NOT NULL DEFAULT 0,
  -- Which engine produced it: 'model' | 'heuristic' | 'taxonomy'.
  -- Kept so the UI can label a suggestion's origin and so we can compare
  -- engine quality from acceptance rates.
  source      TEXT NOT NULL DEFAULT 'model',
  -- Short human-readable justification, shown in the review UI. Trust in an
  -- automated suggestion collapses without one.
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TEXT NOT NULL,
  decided_at  TEXT
);

-- One live proposal per (bookmark, name). Re-running the organiser refreshes
-- rather than piling up duplicates for the user to reject one by one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sugg_pending_unique
  ON tag_suggestions (bookmark_id, tag_name COLLATE NOCASE)
  WHERE status = 'pending';

-- The review queue: one user's pending items, newest first.
CREATE INDEX IF NOT EXISTS idx_sugg_user_status
  ON tag_suggestions (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sugg_job ON tag_suggestions (job_id);

/* ------------------------------------------------------------------ *
 * 4) Jobs: progress that survives a page reload
 *
 * The client polls this row. Because state lives in the database rather than
 * in a request, closing the tab mid-run loses nothing — the counters are still
 * there when the user comes back.
 * ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS ai_jobs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- 'organize' (suggest tags for a set of bookmarks) | 'audit' (taxonomy health).
  kind       TEXT NOT NULL,
  -- 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  status     TEXT NOT NULL DEFAULT 'queued',
  -- JSON snapshot of what was requested, so a run is reproducible and the UI
  -- can describe an old job without re-deriving the filter.
  scope      TEXT,
  total      INTEGER NOT NULL DEFAULT 0,
  processed  INTEGER NOT NULL DEFAULT 0,
  suggested  INTEGER NOT NULL DEFAULT 0,
  failed     INTEGER NOT NULL DEFAULT 0,
  -- 'model' | 'heuristic' | 'mixed' — which engine actually did the work.
  -- Surfaced in the UI so a run that silently fell back to local heuristics
  -- (bad key, provider outage) is visible rather than passed off as AI.
  engine     TEXT,
  error      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_user ON ai_jobs (user_id, created_at DESC);

/* ------------------------------------------------------------------ *
 * 5) Settings the new workflow needs
 *
 * These exist because "AI decides" and "human decides" is a dial, not a
 * boolean. A user who trusts the model wants high-confidence tags applied
 * without ceremony; a cautious user wants to see everything first.
 * ------------------------------------------------------------------ */

-- Suggestions at or above this confidence are applied without review.
-- Default 1.0 = review everything, which is the safe way to meet a new user:
-- trust is earned by watching it be right, then raising the dial.
ALTER TABLE ai_settings ADD COLUMN auto_apply_threshold REAL NOT NULL DEFAULT 1.0;

-- Whether the local heuristic engine may run. On by default, and deliberately
-- so: it means tag organisation works on day one, with no API key and no cost.
-- The model then upgrades the result rather than being a prerequisite for it.
ALTER TABLE ai_settings ADD COLUMN heuristics_enabled INTEGER NOT NULL DEFAULT 1;

-- Per-bookmark ceiling on suggested tags. Five tags on every bookmark is not
-- organisation, it is noise.
ALTER TABLE ai_settings ADD COLUMN max_tags INTEGER NOT NULL DEFAULT 4;
