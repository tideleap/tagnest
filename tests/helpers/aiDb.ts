/**
 * In-memory D1 mock for the AI tagging workflow tests.
 *
 * This is intentionally *not* a SQL engine. It understands the exact statement
 * shapes issued by `functions/_lib/ai/store.ts`, `config.ts` and `engine.ts`
 * (via `loadVocabulary`), and keeps a few tables in memory so we can assert on
 * the rows the pipeline actually writes — pending suggestions, accepted
 * `bookmark_tags` with `source = 'ai'`, rejected rows that must not re-appear,
 * and so on.
 *
 * Routes are matched by leading verb + target table. Every handler is given the
 * bound positional parameters for the specific query it models, so adding a new
 * statement is a matter of recognising its shape and mapping its parameters.
 */

export interface TagRow {
  id: string;
  user_id: string;
  name: string;
  color_index: number;
  parent_id: string | null;
  sort_order: number;
  created_at: string;
  aliases?: string | null;
}

export interface BookmarkRow {
  id: string;
  user_id: string;
  url: string;
  title: string;
  description: string | null;
  deleted_at: string | null;
  ai_summary: string | null;
  created_at: string;
}

export interface BookmarkTagRow {
  bookmark_id: string;
  tag_id: string;
  source: string | null;
  confidence: number | null;
  created_at: string;
}

export interface SuggestionRow {
  id: string;
  user_id: string;
  bookmark_id: string;
  job_id: string | null;
  tag_name: string;
  tag_id: string | null;
  confidence: number;
  source: string;
  reason: string | null;
  /** Topic phrase for the bookmark, used for in-job clustering. */
  topic?: string | null;
  /** Model flagged this proposal as needing a human sanity check. */
  needs_review?: number;
  /** Confidence was lifted by the user's feedback history. */
  feedback_boosted?: number;
  status: 'pending' | 'accepted' | 'rejected';
  decided_at: string | null;
  created_at: string;
}

export interface FeedbackRow {
  id: string;
  user_id: string;
  bookmark_id: string;
  tag_name: string;
  action: string;
  final_tag_id: string | null;
  source: string | null;
  confidence: number | null;
  domain: string | null;
  context: string | null;
  created_at: string;
}

export interface JobRow {
  id: string;
  user_id: string;
  kind: string;
  status: string;
  scope: string | null;
  total: number;
  processed: number;
  suggested: number;
  failed: number;
  engine: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  prompt_version: string | null;
}

export interface SettingsRow {
  user_id: string;
  provider: string;
  base_url: string | null;
  model: string;
  api_key_encrypted: string | null;
  auto_tag: number;
  auto_summarize: number;
  auto_apply_threshold: number;
  heuristics_enabled: number;
  max_tags: number;
}

export interface AiDbState {
  tags: TagRow[];
  bookmarks: BookmarkRow[];
  bookmark_tags: BookmarkTagRow[];
  tag_suggestions: SuggestionRow[];
  ai_feedback: FeedbackRow[];
  ai_jobs: JobRow[];
  ai_settings: SettingsRow[];
}

export interface AiDb {
  db: unknown;
  state: AiDbState;
}

let counter = 0;
function genId(prefix = 'id'): string {
  counter += 1;
  return `${prefix}_${counter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function norm(sql: string): string {
  return sql
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

export function createAiDb(seed?: Partial<AiDbState>): AiDb {
  const state: AiDbState = {
    tags: seed?.tags ?? [],
    bookmarks: seed?.bookmarks ?? [],
    bookmark_tags: seed?.bookmark_tags ?? [],
    tag_suggestions: seed?.tag_suggestions ?? [],
    ai_feedback: seed?.ai_feedback ?? [],
    ai_jobs: seed?.ai_jobs ?? [],
    ai_settings: seed?.ai_settings ?? [],
  };

  function prepare(sql: string) {
    const normalized = norm(sql);
    const rawSql = sql;
    return {
      sql: normalized,
      rawSql,
      bind(...params: unknown[]) {
        return makeStmt(normalized, rawSql, params);
      },
    };
  }

  function makeStmt(sql: string, rawSql: string, params: unknown[]) {
    const stmt = {
      sql,
      rawSql,
      params,
      all() {
        return { results: getRows(sql, rawSql, params) };
      },
      first() {
        const rows = getRows(sql, rawSql, params);
        return rows.length > 0 ? rows[0] : null;
      },
      run() {
        applyMutation(sql, rawSql, params);
        return { success: true, meta: {} };
      },
    };
    return stmt;
  }

  /** Pure SELECTs. Returns rows already shaped as the caller expects. */
  function getRows(sql: string, rawSql: string, params: unknown[]) {
    // countPending — must be checked before the listPendingSuggestions branch,
    // which shares the "FROM TAG_SUGGESTIONS S JOIN BOOKMARKS B" signature.
    if (sql.startsWith('SELECT COUNT')) {
      const userId = String(params[0]);
      const n = state.tag_suggestions.filter(
        (s) => s.user_id === userId && s.status === 'pending',
      ).length;
      return [{ n }];
    }

    // ai_settings lookup
    if (sql.startsWith('SELECT * FROM AI_SETTINGS')) {
      const userId = String(params[0]);
      const row = state.ai_settings.find((r) => r.user_id === userId);
      return row ? [row] : [];
    }

    // loadVocabulary: tag + usage count
    if (sql.includes('FROM TAGS T') || (sql.includes('FROM TAGS') && sql.includes('LEFT JOIN'))) {
      return state.tags
        .filter((t) => t.user_id === String(params[0]))
        .map((t) => ({
          id: t.id,
          name: t.name,
          aliases: t.aliases ?? null,
          cnt: state.bookmark_tags.filter((bt) => bt.tag_id === t.id).length,
        }));
    }

    // resolveScope: explicit ids
    if (sql.startsWith('SELECT ID FROM BOOKMARKS') && sql.includes('ID IN')) {
      const userId = String(params[0]);
      const ids = params.slice(1).map(String);
      return state.bookmarks
        .filter((b) => b.user_id === userId && b.deleted_at === null && ids.includes(b.id))
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .map((b) => ({ id: b.id }));
    }

    // resolveScope / loadBookmarkInputs base listing
    if (sql.startsWith('SELECT B.ID AS ID FROM BOOKMARKS B') || sql.startsWith('SELECT B.ID FROM BOOKMARKS B')) {
      const userId = String(params[0]);
      let rows = state.bookmarks.filter((b) => b.user_id === userId && b.deleted_at === null);
      // The `untagged` scope is the ONLY one that hides tagged bookmarks. Match
      // its exact subquery (alias `bt WHERE`) so the unrelated PRIVATE_BOOKMARK_CLAUSE
      // (alias `bt_pv JOIN tags t_pv ...`) does not get misread as untagged and
      // silently drop every normally-tagged bookmark from an `all`/explicit scope.
      if (sql.includes('NOT EXISTS (SELECT 1 FROM BOOKMARK_TAGS BT WHERE')) {
        rows = rows.filter((b) => !state.bookmark_tags.some((bt) => bt.bookmark_id === b.id));
      }
      return rows.map((b) => ({ id: b.id }));
    }

    if (sql.startsWith('SELECT ID, URL, TITLE, DESCRIPTION FROM BOOKMARKS')) {
      const userId = String(params[0]);
      const ids = params.slice(1).map(String);
      return state.bookmarks
        .filter((b) => b.user_id === userId && b.deleted_at === null && ids.includes(b.id))
        .map((b) => ({
          id: b.id,
          url: b.url,
          title: b.title,
          description: b.description,
        }));
    }

    // getJob
    if (sql.startsWith('SELECT * FROM AI_JOBS') && sql.includes('LIMIT 1')) {
      const jobId = String(params[0]);
      const userId = String(params[1]);
      const row = state.ai_jobs.find((j) => j.id === jobId && j.user_id === userId);
      return row ? [row] : [];
    }

    // listJobs
    if (sql.startsWith('SELECT * FROM AI_JOBS') && sql.includes('ORDER BY')) {
      const userId = String(params[0]);
      return state.ai_jobs
        .filter((j) => j.user_id === userId)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .slice(0, Number(params[1] ?? 1000));
    }

    // listPendingSuggestions — note the FEEDBACK_BOOSTED column, which the
    // decideSuggestions fetch does not select, so the two queries stay distinct.
    if (
      sql.includes('FROM TAG_SUGGESTIONS S') &&
      sql.includes('JOIN BOOKMARKS B') &&
      sql.includes('FEEDBACK_BOOSTED')
    ) {
      const userId = String(params[0]);
      const jobClause = sql.includes('S.JOB_ID = ?');
      const jobId = jobClause ? String(params[1]) : null;
      const rows = state.tag_suggestions
        .filter((s) => s.user_id === userId && s.status === 'pending' && (!jobClause || s.job_id === jobId))
          .map((s) => {
          const b = state.bookmarks.find((x) => x.id === s.bookmark_id);
          return {
            id: s.id,
            bookmark_id: s.bookmark_id,
            bookmark_title: b?.title ?? '',
            bookmark_url: b?.url ?? '',
            tag_name: s.tag_name,
            tag_id: s.tag_id,
            confidence: s.confidence,
            source: s.source,
            reason: s.reason,
            topic: s.topic ?? null,
            needs_review: s.needs_review ?? 0,
            feedback_boosted: s.feedback_boosted ?? 0,
            created_at: s.created_at,
          };
        })
        .sort((a, b) => b.confidence - a.confidence);
      return rows;
    }

    // loadFeedbackProfile
    if (sql.startsWith('SELECT TAG_NAME, ACTION, DOMAIN, FINAL_TAG_ID, CONTEXT FROM AI_FEEDBACK')) {
      const userId = String(params[0]);
      return state.ai_feedback
        .filter((f) => f.user_id === userId)
        .map((f) => ({
          tag_name: f.tag_name,
          action: f.action,
          domain: f.domain,
          final_tag_id: f.final_tag_id,
          context: f.context,
        }));
    }

    // Phase 5: feedback action tally (accept/reject/modify counts)
    if (
      sql.startsWith('SELECT ACTION, COUNT(*) AS C FROM AI_FEEDBACK') &&
      sql.includes('GROUP BY ACTION')
    ) {
      const userId = String(params[0]);
      const counts = new Map<string, number>();
      for (const f of state.ai_feedback.filter((x) => x.user_id === userId)) {
        counts.set(f.action, (counts.get(f.action) ?? 0) + 1);
      }
      return [...counts.entries()].map(([action, c]) => ({ action, c }));
    }

    // Phase 5: tag_suggestions status tally (accepted/rejected/pending/...)
    if (
      sql.startsWith('SELECT STATUS, COUNT(*) AS C FROM TAG_SUGGESTIONS') &&
      sql.includes('GROUP BY STATUS')
    ) {
      const userId = String(params[0]);
      const counts = new Map<string, number>();
      for (const s of state.tag_suggestions.filter((x) => x.user_id === userId)) {
        counts.set(s.status, (counts.get(s.status) ?? 0) + 1);
      }
      return [...counts.entries()].map(([status, c]) => ({ status, c }));
    }

    // Phase 5: 30-day accept/reject trend by day
    if (sql.startsWith('SELECT DATE(CREATED_AT) AS DAY, ACTION, COUNT(*) AS C FROM AI_FEEDBACK')) {
      const userId = String(params[0]);
      const cutoff = params[1] != null ? String(params[1]) : '';
      const counts = new Map<string, { accepted: number; rejected: number }>();
      for (const f of state.ai_feedback.filter(
        (x) => x.user_id === userId && (cutoff === '' || x.created_at >= cutoff),
      )) {
        const day = String(f.created_at).slice(0, 10);
        const bucket = counts.get(day) ?? { accepted: 0, rejected: 0 };
        if (f.action === 'accepted') bucket.accepted += 1;
        else if (f.action === 'rejected') bucket.rejected += 1;
        counts.set(day, bucket);
      }
      const rows: Array<{ day: string; action: string; c: number }> = [];
      for (const [day, b] of counts) {
        if (b.accepted > 0) rows.push({ day, action: 'accepted', c: b.accepted });
        if (b.rejected > 0) rows.push({ day, action: 'rejected', c: b.rejected });
      }
      return rows;
    }

    // decideSuggestions / autoApply row fetch
    if (sql.startsWith('SELECT S.ID, S.BOOKMARK_ID, S.TAG_NAME, S.TAG_ID, S.CONFIDENCE, S.SOURCE')) {
      const userId = String(params[0]);
      const ids = params.slice(1).map(String);
      return state.tag_suggestions
        .filter((s) => s.user_id === userId && s.status === 'pending' && ids.includes(s.id))
        .map((s) => {
          const b = state.bookmarks.find((x) => x.id === s.bookmark_id);
          return {
            id: s.id,
            bookmark_id: s.bookmark_id,
            tag_name: s.tag_name,
            tag_id: s.tag_id,
            confidence: s.confidence,
            source: s.source,
            bookmark_url: b?.url ?? '',
            bookmark_title: b?.title ?? '',
          };
        });
    }

    if (sql.startsWith('SELECT ID FROM TAG_SUGGESTIONS') && sql.includes('CONFIDENCE >= ?')) {
      const userId = String(params[0]);
      const jobId = String(params[1]);
      const threshold = Number(params[2]);
      return state.tag_suggestions
        .filter(
          (s) =>
            s.user_id === userId &&
            s.job_id === jobId &&
            s.status === 'pending' &&
            s.confidence >= threshold,
        )
        .map((s) => ({ id: s.id }));
    }

    // ensureTags existing lookup
    if (sql.startsWith('SELECT ID, NAME FROM TAGS') && sql.includes('IN')) {
      const userId = String(params[0]);
      const names = params.slice(1).map((n) => String(n).toLowerCase());
      return state.tags
        .filter((t) => t.user_id === userId && names.includes(t.name.toLowerCase()))
        .map((t) => ({ id: t.id, name: t.name }));
    }

    return [];
  }

  /** INSERT / UPDATE / DELETE side effects. */
  function applyMutation(sql: string, rawSql: string, params: unknown[]) {
    // createJob — columns: id, user_id, kind, status('queued'), scope, total,
    // processed(0), suggested(0), failed(0), created_at, updated_at, prompt_version.
    // processed/suggested/failed are literal 0 in the SQL, so the bound params
    // are [id, user_id, kind, scope, total, created_at, updated_at, prompt_version].
    if (sql.startsWith('INSERT INTO AI_JOBS')) {
      state.ai_jobs.push({
        id: String(params[0]),
        user_id: String(params[1]),
        kind: String(params[2]),
        status: 'queued',
        scope: String(params[3]),
        total: Number(params[4]),
        processed: 0,
        suggested: 0,
        failed: 0,
        engine: null,
        error: null,
        created_at: String(params[5]),
        updated_at: String(params[6]),
        prompt_version: params[7] == null ? null : String(params[7]),
      });
      return;
    }

    // updateJob — generic SET parser
    if (sql.startsWith('UPDATE AI_JOBS SET')) {
      const jobId = String(params[params.length - 1]);
      const job = state.ai_jobs.find((j) => j.id === jobId);
      if (!job) return;
      const setPart = sql.substring(sql.indexOf(' SET ') + 5, sql.indexOf(' WHERE '));
      const columns = setPart.split(',').map((c) => c.split('=')[0].trim().toLowerCase());
      // Param order mirrors the SET order; the last param is the id.
      const values = params.slice(0, -1);
      columns.forEach((col, i) => {
        const v = values[i];
        if (col === 'updated_at') job.updated_at = String(v);
        else if (col === 'status') job.status = String(v);
        else if (col === 'processed') job.processed = Number(v);
        else if (col === 'suggested') job.suggested = Number(v);
        else if (col === 'failed') job.failed = Number(v);
        else if (col === 'engine') job.engine = v == null ? null : String(v);
        else if (col === 'error') job.error = v == null ? null : String(v);
      });
      return;
    }

    // saveSuggestions: DELETE pending for a bookmark
    if (sql.startsWith('DELETE FROM TAG_SUGGESTIONS') && sql.includes('STATUS =')) {
      const bookmarkId = String(params[0]);
      const userId = String(params[1]);
      state.tag_suggestions = state.tag_suggestions.filter(
        (s) => !(s.bookmark_id === bookmarkId && s.user_id === userId && s.status === 'pending'),
      );
      return;
    }

    // saveSuggestions: INSERT ... SELECT ... WHERE NOT EXISTS (...)
    if (sql.startsWith('INSERT INTO TAG_SUGGESTIONS') && sql.includes('WHERE NOT EXISTS')) {
      const bookmarkId = String(params[2]);
      const tagName = String(params[4]);
      const tagId = params[5] == null ? null : String(params[5]);
      // Guard 1: bookmark already carries this tag.
      if (tagId && state.bookmark_tags.some((bt) => bt.bookmark_id === bookmarkId && bt.tag_id === tagId)) {
        return;
      }
      // Guard 2: a rejected suggestion with the same name already exists.
      const alreadyRejected = state.tag_suggestions.some(
        (s) =>
          s.bookmark_id === bookmarkId &&
          s.status === 'rejected' &&
          s.tag_name.toLowerCase() === tagName.toLowerCase(),
      );
      if (alreadyRejected) return;
      state.tag_suggestions.push({
        id: String(params[0]),
        user_id: String(params[1]),
        bookmark_id: bookmarkId,
        job_id: params[3] == null ? null : String(params[3]),
        tag_name: tagName,
        tag_id: tagId,
        confidence: Number(params[6]),
        source: String(params[7]),
        reason: (params[8] as string | null) ?? null,
        topic: (params[9] as string | null) ?? null,
        needs_review: params[10] == null ? 0 : Number(params[10]),
        feedback_boosted: params[11] == null ? 0 : Number(params[11]),
        status: 'pending',
        decided_at: null,
        created_at: String(params[12]),
      });
      return;
    }

    // recordFeedback: INSERT INTO AI_FEEDBACK
    if (sql.startsWith('INSERT INTO AI_FEEDBACK')) {
      state.ai_feedback.push({
        id: String(params[0]),
        user_id: String(params[1]),
        bookmark_id: String(params[2]),
        tag_name: String(params[3]),
        action: String(params[4]),
        final_tag_id: params[5] == null ? null : String(params[5]),
        source: params[6] == null ? null : String(params[6]),
        confidence: params[7] == null ? null : Number(params[7]),
        domain: params[8] == null ? null : String(params[8]),
        context: params[9] == null ? null : String(params[9]),
        created_at: String(params[10]),
      });
      return;
    }

    // saveSuggestions / autoApply-style summary write
    if (sql.startsWith('UPDATE BOOKMARKS SET AI_SUMMARY = ?')) {
      const summary = String(params[0]);
      const bookmarkId = String(params[1]);
      const b = state.bookmarks.find((x) => x.id === bookmarkId);
      if (b && (b.ai_summary == null || b.ai_summary === '')) b.ai_summary = summary;
      return;
    }

    // decideSuggestions reject / accept mark (markDecided binds status first)
    if (sql.startsWith('UPDATE TAG_SUGGESTIONS SET STATUS =')) {
      const status = String(params[0]) as SuggestionRow['status'];
      const userId = String(params[2]);
      const ids = params.slice(3).map(String);
      for (const s of state.tag_suggestions) {
        if (s.user_id === userId && ids.includes(s.id)) {
          s.status = status;
          s.decided_at = String(params[1]);
        }
      }
      return;
    }

    // ensureTags insert
    if (sql.startsWith('INSERT INTO TAGS')) {
      state.tags.push({
        id: String(params[0]),
        user_id: String(params[1]),
        name: String(params[2]),
        color_index: Number(params[3]),
        parent_id: null,
        sort_order: Number(params[5]),
        created_at: String(params[6]),
      });
      return;
    }

    // decideSuggestions bookmark_tags insert ('ai' source)
    if (sql.startsWith('INSERT OR IGNORE INTO BOOKMARK_TAGS')) {
      const bookmarkId = String(params[0]);
      const tagId = String(params[1]);
      const confidence = Number(params[2]);
      const createdAt = String(params[3]);
      const exists = state.bookmark_tags.some(
        (bt) => bt.bookmark_id === bookmarkId && bt.tag_id === tagId,
      );
      if (!exists) {
        state.bookmark_tags.push({
          bookmark_id: bookmarkId,
          tag_id: tagId,
          source: 'ai',
          confidence,
          created_at: createdAt,
        });
      }
      return;
    }
  }

  const db = {
    prepare,
    batch(statements: Array<{ run: () => unknown }>) {
      for (const s of statements) s.run();
      return Promise.resolve([]);
    },
  };

  return { db, state };
}

export { genId };
