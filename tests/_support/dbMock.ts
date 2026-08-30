/**
 * Minimal in-memory D1 mock for unit tests of backend logic that touches the
 * database (api_keys, auth_attempts, ...). It is intentionally tiny: it
 * pattern-matches the handful of SQL statements the libraries actually issue
 * and keeps row state in plain arrays, so tests stay fast and hermetic.
 *
 * This is NOT a SQL engine — only the statements exercised by the code under
 * test are recognised. Any unrecognised statement returns an empty result
 * rather than throwing, so a test fails loudly only when its assertion is
 * wrong, not when the mock is incomplete.
 */

export type MockRow = Record<string, unknown>;

/**
 * Builds a row object from an INSERT statement whose VALUES clause mixes `?`
 * placeholders with literal tokens (`''`, `NULL`, `0`, `1`). Columns and values
 * are parsed positionally; a `?` consumes the next bound param, while a literal
 * token is stored verbatim (NULL → null, `''`/quoted → '', digits → number).
 */
function parseInsertRow(columnSql: string, valueSql: string, params: unknown[]): MockRow {
  const cols = columnSql.split(',').map((c) => c.trim().toLowerCase());
  const vals = valueSql.split(',').map((v) => v.trim());
  const row: MockRow = {};
  let pi = 0;
  for (let i = 0; i < cols.length; i += 1) {
    const v = vals[i] ?? 'NULL';
    if (v === '?') {
      row[cols[i]] = params[pi];
      pi += 1;
    } else if (v === 'NULL') {
      row[cols[i]] = null;
    } else if (v === "''" || v === '""') {
      row[cols[i]] = '';
    } else if (/^-?\d+(\.\d+)?$/.test(v)) {
      row[cols[i]] = Number(v);
    } else {
      row[cols[i]] = v; // unknown literal (e.g. quoted string) — keep as-is
    }
  }
  return row;
}

interface Statement {
  sql: string;
  params: unknown[];
  first<T = MockRow>(): Promise<T | null>;
  all<T = MockRow>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean; meta: unknown }>;
}

export class MockDb {
  api_keys: MockRow[] = [];
  auth_attempts: MockRow[] = [];
  users: MockRow[] = [];
  ai_jobs: MockRow[] = [];
  collections: MockRow[] = [];
  collection_bookmarks: MockRow[] = [];
  bookmarks: MockRow[] = [];
  bookmark_tags: MockRow[] = [];
  bookmark_primary_category: MockRow[] = [];
  tags: MockRow[] = [];
  tag_suggestions: MockRow[] = [];
  ai_feedback: MockRow[] = [];
  ai_settings: MockRow[] = [];
  private_vault: MockRow[] = [];
  shares: MockRow[] = [];
  tag_merge_log: MockRow[] = [];
  backupTargets: MockRow[] = [];
  backupRuns: MockRow[] = [];
  feeds: MockRow[] = [];
  /** Number of rows affected by the most recent mutation statement. */
  lastChanges = 0;

  /** Mirrors PRIVATE_BOOKMARK_CLAUSE's NOT EXISTS half: does the bookmark carry
   *  a tag the given user marked private? */
  hasPrivateTag(bookmarkId: string, userId: string): boolean {
    return this.bookmark_tags.some((bt) => {
      if (bt.bookmark_id !== bookmarkId) return false;
      const t = this.tags.find((x) => x.id === bt.tag_id);
      return Boolean(t && t.user_id === userId && t.is_private === 1);
    });
  }

  /**
   * Rows visible to the public bookmark list for a scope, mirroring
   * scopeClause() + PRIVATE_BOOKMARK_CLAUSE in functions/_lib/db.ts. Scope is
   * detected from the normalized SQL text: the inbox marker uses alias
   * `BT WHERE`, which PRIVATE_BOOKMARK_CLAUSE's `BT_PV JOIN` never matches, so
   * detection is unambiguous. 'all' keeps the historical behaviour (every
   * live, non-private row) so existing tests relying on it are untouched.
   */
  visibleBookmarksForScope(userId: string, u: string): MockRow[] {
    const isInbox = u.includes('NOT EXISTS (SELECT 1 FROM BOOKMARK_TAGS BT WHERE');
    const isTrash = u.includes('B.DELETED_AT IS NOT NULL');
    const isFavorites = u.includes('B.IS_FAVORITE = 1');
    const isArchive = u.includes('B.IS_ARCHIVED = 1');
    return this.bookmarks.filter((b) => {
      if (b.user_id !== userId) return false;
      if (b.is_private === 1) return false;
      if (this.hasPrivateTag(b.id, userId)) return false;
      if (isTrash) return b.deleted_at != null;
      if (b.deleted_at != null) return false;
      if (isFavorites) return b.is_favorite === 1;
      if (isArchive) return b.is_archived === 1;
      if (isInbox) {
        return (
          b.is_archived !== 1 &&
          !this.bookmark_tags.some((bt) => bt.bookmark_id === b.id)
        );
      }
      return true; // 'all'
    });
  }

  prepare(sql: string): Statement {
    // Arrow-function methods capture `this` (the MockDb instance) lexically, so
    // we never alias `this` to a local variable (which trips no-this-alias) and
    // `this.exec` still resolves to the instance method.
    const params: unknown[] = [];
    const stmt: Statement = {
      sql,
      params,
      bind: (...p: unknown[]) => {
        params.length = 0;
        params.push(...p);
        return stmt;
      },
      first: async <T = MockRow>(): Promise<T | null> => {
        const rows = this.exec(sql, params);
        return (rows[0] as T) ?? null;
      },
      all: async <T = MockRow>(): Promise<{ results: T[] }> => {
        return { results: this.exec(sql, params) as T[] };
      },
      run: async () => {
        this.exec(sql, params);
        return { success: true, meta: { changes: this.lastChanges } };
      },
    };
    return stmt;
  }

  async batch(stmts: Statement[]): Promise<void> {
    for (const s of stmts) await s.run();
  }

  exec(sql: string, params: unknown[]): MockRow[] {
    const u = sql.trim().replace(/\s+/g, ' ').toUpperCase();
    // Reset the per-statement change counter; mutation branches below set it
    // to the real affected-row count so `.run()` can report D1's meta.changes.
    this.lastChanges = 0;

    // --- api_keys ---------------------------------------------------
    if (u.startsWith('INSERT INTO API_KEYS')) {
      const [id, user_id, name, prefix, token_hash, scopes, created_at, expires_at] = params as string[];
      this.api_keys.push({
        id,
        user_id,
        name,
        prefix,
        token_hash,
        scopes,
        created_at,
        expires_at: expires_at ?? null,
        last_used_at: null,
      });
      return [];
    }
    if (u.startsWith('SELECT COUNT(*) AS C FROM API_KEYS')) {
      const userId = params[0] as string;
      return [{ c: this.api_keys.filter((r) => r.user_id === userId).length }];
    }
    if (
      u.startsWith(
        'SELECT ID, NAME, PREFIX, SCOPES, LAST_USED_AT, CREATED_AT, EXPIRES_AT FROM API_KEYS',
      )
    ) {
      const userId = params[0] as string;
      return this.api_keys.filter((r) => r.user_id === userId);
    }
    if (u.startsWith('SELECT ID, USER_ID, SCOPES, EXPIRES_AT FROM API_KEYS WHERE TOKEN_HASH')) {
      const hash = params[0] as string;
      return this.api_keys.filter((r) => r.token_hash === hash);
    }
    if (u.startsWith('UPDATE API_KEYS SET LAST_USED_AT')) {
      const [ts, id] = params as string[];
      const row = this.api_keys.find((r) => r.id === id);
      if (row) row.last_used_at = ts;
      return [];
    }

    // --- auth_attempts (throttle) -----------------------------------
    if (u.startsWith('SELECT COUNT(*) AS C FROM AUTH_ATTEMPTS WHERE BUCKET')) {
      const bucket = params[0] as string;
      const since = params[1] as string;
      return [
        {
          c: this.auth_attempts.filter((r) => r.bucket === bucket && r.created_at > since)
            .length,
        },
      ];
    }
    if (u.startsWith('INSERT INTO AUTH_ATTEMPTS')) {
      const [id, bucket, created_at] = params as string[];
      this.auth_attempts.push({ id, bucket, created_at });
      return [];
    }
    if (u.startsWith('DELETE FROM AUTH_ATTEMPTS WHERE BUCKET')) {
      const bucket = params[0] as string;
      this.auth_attempts = this.auth_attempts.filter((r) => r.bucket !== bucket);
      return [];
    }
    if (u.startsWith('DELETE FROM AUTH_ATTEMPTS WHERE CREATED_AT')) {
      const before = params[0] as string;
      this.auth_attempts = this.auth_attempts.filter((r) => r.created_at >= before);
      return [];
    }

    // --- users (password change) -------------------------------------
    if (u.startsWith('SELECT EMAIL, PASSWORD_HASH FROM USERS WHERE ID')) {
      const id = params[0] as string;
      return this.users
        .filter((r) => r.id === id)
        .map((r) => ({ email: r.email, password_hash: r.password_hash }));
    }
    if (u.startsWith('UPDATE USERS SET PASSWORD_HASH')) {
      const [hash, updated_at, id] = params as string[];
      const row = this.users.find((r) => r.id === id);
      if (row) {
        row.password_hash = hash;
        row.updated_at = updated_at;
      }
      return [];
    }

    // --- ai_jobs (run history) ---------------------------------------
    if (u.startsWith('INSERT INTO AI_JOBS')) {
      // Columns: id, user_id, kind, status, scope, total, processed,
      // suggested, failed, created_at, updated_at, prompt_version. `status`
      // is the literal 'queued'; processed/suggested/failed are literal 0.
      const [id, user_id, kind, scope, total, created_at, updated_at, prompt_version] =
        params as string[];
      this.ai_jobs.push({
        id,
        user_id,
        kind,
        status: 'queued',
        scope,
        total: Number(total),
        processed: 0,
        suggested: 0,
        failed: 0,
        engine: null,
        error: null,
        created_at,
        updated_at,
        prompt_version: prompt_version ?? null,
      });
      return [];
    }
    // Detail lookup: `SELECT * FROM AI_JOBS WHERE ID = ? AND USER_ID = ? LIMIT 1`
    if (u.startsWith('SELECT * FROM AI_JOBS') && u.includes('AND USER_ID = ? LIMIT 1')) {
      const id = params[0] as string;
      const userId = params[1] as string;
      return this.ai_jobs.filter((r) => r.id === id && r.user_id === userId);
    }
    // List: `SELECT * FROM AI_JOBS WHERE USER_ID = ? ORDER BY CREATED_AT DESC LIMIT ?`
    if (u.startsWith('SELECT * FROM AI_JOBS WHERE USER_ID')) {
      const userId = params[0] as string;
      const limit = Number(params[1]);
      return this.ai_jobs
        .filter((r) => r.user_id === userId)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, limit);
    }
    if (u.startsWith('UPDATE AI_JOBS SET')) {
      // Params: [updated_at, ...present optional fields..., user_id, id].
      // `updated_at` is always first; the optional columns appear in a fixed
      // order (status, processed, suggested, failed, engine, error) only when
      // the caller set them.
      const columns = ['status', 'processed', 'suggested', 'failed', 'engine', 'error'];
      const updates: Record<string, unknown> = {};
      let idx = 1;
      for (const col of columns) {
        if (u.includes(`${col.toUpperCase()} = ?`)) {
          updates[col] = params[idx];
          idx += 1;
        }
      }
      const userId = params[idx] as string;
      const id = params[idx + 1] as string;
      const row = this.ai_jobs.find((r) => r.id === id && r.user_id === userId);
      if (row) {
        row.updated_at = params[0];
        Object.assign(row, updates);
      }
      return [];
    }

    // --- collections (design plan module) --------------------------
    if (
      u.startsWith(
        'SELECT C.ID, C.NAME, C.COLOR_INDEX, C.KIND, C.QUERY, C.CREATED_AT, C.UPDATED_AT, COUNT(CB.BOOKMARK_ID) AS COUNT FROM COLLECTIONS C',
      )
    ) {
      // `getCollectionRow` filters by id + user; the list query only by user.
      if (u.includes('WHERE C.ID = ? AND C.USER_ID = ?')) {
        const collId = params[0] as string;
        const userId = params[1] as string;
        const coll = this.collections.find((c) => c.id === collId && c.user_id === userId);
        return coll ? [this.toCollectionRow(coll)] : [];
      }
      const userId = params[0] as string;
      return this.collections
        .filter((c) => c.user_id === userId)
        .map((c) => this.toCollectionRow(c))
        .sort((a, b) =>
          String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase()),
        );
    }
    if (u.startsWith('SELECT ID FROM COLLECTIONS WHERE USER_ID = ? AND NAME COLLATE NOCASE = ?')) {
      const userId = params[0] as string;
      const name = String(params[1]).toLowerCase();
      if (u.includes('AND ID != ?')) {
        const id = params[2] as string;
        return this.collections
          .filter(
            (c) =>
              c.user_id === userId && String(c.name).toLowerCase() === name && c.id !== id,
          )
          .slice(0, 1)
          .map((c) => ({ id: c.id }));
      }
      return this.collections
        .filter((c) => c.user_id === userId && String(c.name).toLowerCase() === name)
        .slice(0, 1)
        .map((c) => ({ id: c.id }));
    }
    if (u.startsWith('INSERT OR IGNORE INTO COLLECTIONS')) {
      const [id, user_id, name, color_index, p4, p5, p6, p7] = params as unknown[];
      // Support both the legacy 6-param insert (id, user_id, name, color_index,
      // created_at, updated_at — pre-B-8) and the new 8-param form that carries
      // kind + query. D1 defaults kind to 'manual' when omitted, so the mock does
      // the same for the short form.
      const hasKind = params.length >= 8;
      const kind = hasKind ? (p4 as string) : 'manual';
      const query = hasKind ? ((p5 as string | null) ?? null) : null;
      const created_at = hasKind ? p6 : p4;
      const updated_at = hasKind ? p7 : p5;
      // Mirrors the unique index on (user_id, name COLLATE NOCASE): a concurrent
      // duplicate gets no row back, so the handler surfaces a 409.
      const dup = this.collections.find(
        (c) => c.user_id === user_id && String(c.name).toLowerCase() === String(name).toLowerCase(),
      );
      if (dup) return [];
      this.collections.push({
        id, user_id, name,
        color_index: Number(color_index),
        kind,
        query: (query as string | null) ?? null,
        created_at, updated_at,
      });
      return [{ id }];
    }
    if (u.startsWith('INSERT INTO COLLECTIONS')) {
      const [id, user_id, name, color_index, created_at, updated_at] = params as string[];
      this.collections.push({ id, user_id, name, color_index: Number(color_index), created_at, updated_at });
      return [];
    }
    if (u.startsWith('UPDATE COLLECTIONS SET NAME = ?')) {
      const [name, color_index, query, updated_at, id, user_id] = params as unknown[];
      const coll = this.collections.find((c) => c.id === id && c.user_id === user_id);
      if (coll) {
        coll.name = name;
        coll.color_index = Number(color_index);
        coll.query = (query as string | null) ?? null;
        coll.updated_at = updated_at;
      }
      return [];
    }
    if (u.startsWith('DELETE FROM COLLECTIONS WHERE ID = ?')) {
      const [id, user_id] = params as string[];
      this.collections = this.collections.filter(
        (c) => !(c.id === id && c.user_id === user_id),
      );
      return [];
    }

    // --- collection_bookmarks -----------------------------------------
    if (u.startsWith('SELECT COALESCE(MAX(POSITION), -1) AS M FROM COLLECTION_BOOKMARKS')) {
      const collectionId = params[0] as string;
      const positions = this.collection_bookmarks
        .filter((cb) => cb.collection_id === collectionId)
        .map((cb) => Number(cb.position));
      const m = positions.length ? Math.max(...positions) : -1;
      return [{ m }];
    }
    if (u.startsWith('INSERT OR IGNORE INTO COLLECTION_BOOKMARKS')) {
      const [collection_id, bookmark_id, position, created_at] = params as string[];
      if (
        !this.collection_bookmarks.find(
          (cb) => cb.collection_id === collection_id && cb.bookmark_id === bookmark_id,
        )
      ) {
        this.collection_bookmarks.push({ collection_id, bookmark_id, position: Number(position), created_at });
      }
      return [];
    }
    if (u.startsWith('DELETE FROM COLLECTION_BOOKMARKS')) {
      if (u.includes('AND BOOKMARK_ID = ?')) {
        const [collection_id, bookmark_id] = params as string[];
        this.collection_bookmarks = this.collection_bookmarks.filter(
          (cb) => !(cb.collection_id === collection_id && cb.bookmark_id === bookmark_id),
        );
      } else {
        const [collection_id] = params as string[];
        this.collection_bookmarks = this.collection_bookmarks.filter(
          (cb) => cb.collection_id !== collection_id,
        );
      }
      return [];
    }

    // --- bookmarks (collection membership join + add guard) ----------
    if (
      u.startsWith(
        'SELECT B.ID, B.URL, B.TITLE, B.FAVICON_URL FROM COLLECTION_BOOKMARKS CB JOIN BOOKMARKS B',
      )
    ) {
      const userId = params[0] as string;
      const collId = params[1] as string;
      const joined = this.collection_bookmarks
        .filter((cb) => cb.collection_id === collId)
        .map((cb) =>
          this.bookmarks.find(
            (b) => b.id === cb.bookmark_id && b.deleted_at == null && b.user_id === userId,
          ),
        )
        .filter((b): b is MockRow => Boolean(b))
        .map((b) => ({ id: b.id, url: b.url, title: b.title, favicon_url: b.favicon_url }));
      return joined.sort((a, b) => {
        const pa = this.collection_bookmarks.find((cb) => cb.bookmark_id === a.id)?.position ?? 0;
        const pb = this.collection_bookmarks.find((cb) => cb.bookmark_id === b.id)?.position ?? 0;
        if (Number(pa) !== Number(pb)) return Number(pa) - Number(pb);
        return String(b.created_at).localeCompare(String(a.created_at));
      });
    }
    if (u.startsWith('SELECT ID FROM BOOKMARKS B WHERE B.ID = ? AND B.USER_ID = ? AND B.DELETED_AT IS NULL')) {
      // Collection membership validation: PRIVATE_BOOKMARK_CLAUSE applies, so
      // vaulted or category-private bookmarks must read as "not found".
      const [id, userId] = params as string[];
      return this.bookmarks
        .filter(
          (b) =>
            b.id === id &&
            b.user_id === userId &&
            b.deleted_at == null &&
            b.is_private !== 1 &&
            !this.hasPrivateTag(b.id, userId),
        )
        .slice(0, 1)
        .map((b) => ({ id: b.id }));
    }

    // --- ai_settings (config lookup for estimate/run) ----------------
    if (u.startsWith('SELECT * FROM AI_SETTINGS WHERE USER_ID = ? LIMIT 1')) {
      const userId = params[0] as string;
      return this.ai_settings.filter((r) => r.user_id === userId);
    }

    // --- ai: resolveScope explicit ids -------------------------------
    if (
      u.startsWith('SELECT ID FROM BOOKMARKS B WHERE B.USER_ID = ?') &&
      u.includes('AND B.ID IN')
    ) {
      const userId = params[0] as string;
      const ids = (params.slice(1) as string[]).map(String);
      return this.bookmarks
        .filter(
          (b) =>
            b.user_id === userId &&
            b.deleted_at == null &&
            b.is_private !== 1 &&
            !this.hasPrivateTag(b.id, userId) &&
            ids.includes(b.id),
        )
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .map((b) => ({ id: b.id }));
    }

    // --- ai: resolveScope untagged/all + loadBookmarkInputs ----------
    if (u.startsWith('SELECT B.ID AS ID FROM BOOKMARKS B WHERE B.USER_ID = ?')) {
      const userId = params[0] as string;
      const limit = Number(params[1]);
      let rows = this.bookmarks.filter(
        (b) =>
          b.user_id === userId &&
          b.deleted_at == null &&
          b.is_private !== 1 &&
          !this.hasPrivateTag(b.id, userId),
      );
      // The `untagged` scope hides every bookmark that carries ANY tag. Its
      // subquery uses alias `BT WHERE`, which the PRIVATE_BOOKMARK_CLAUSE's
      // `BT_PV JOIN` never matches, so this detection is unambiguous.
      if (u.includes('NOT EXISTS (SELECT 1 FROM BOOKMARK_TAGS BT WHERE')) {
        rows = rows.filter((b) => !this.bookmark_tags.some((bt) => bt.bookmark_id === b.id));
      }
      rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, limit);
      return rows.map((b) => ({ id: b.id }));
    }
    if (u.startsWith('SELECT ID, URL, TITLE, DESCRIPTION FROM BOOKMARKS B WHERE B.USER_ID = ?')) {
      const userId = params[0] as string;
      const ids = (params.slice(1) as string[]).map(String);
      return this.bookmarks
        .filter(
          (b) =>
            b.user_id === userId &&
            b.deleted_at == null &&
            b.is_private !== 1 &&
            !this.hasPrivateTag(b.id, userId) &&
            ids.includes(b.id),
        )
        .map((b) => ({
          id: b.id,
          url: b.url,
          title: b.title ?? '',
          description: b.description ?? null,
        }));
    }

    // --- GET /api/stats (CS-P4-2): one-pass conditional aggregates ---------
    if (u.startsWith('SELECT SUM(CASE WHEN DELETED_AT IS NULL THEN 1 ELSE 0 END) AS BOOKMARKS')) {
      const since = params[0] as string;
      const userId = params[1] as string;
      const live = this.bookmarks.filter(
        (b) =>
          b.user_id === userId &&
          b.is_private !== 1 &&
          !this.hasPrivateTag(b.id, userId),
      );
      const notDeleted = live.filter((b) => b.deleted_at == null);
      return [
        {
          bookmarks: notDeleted.length,
          favorites: notDeleted.filter((b) => b.is_favorite === 1).length,
          archived: notDeleted.filter((b) => b.is_archived === 1).length,
          trashed: live.filter((b) => b.deleted_at != null).length,
          recent: notDeleted.filter((b) => String(b.created_at) >= since).length,
          untagged: notDeleted.filter(
            (b) => !this.bookmark_tags.some((bt) => bt.bookmark_id === b.id),
          ).length,
          categorized: notDeleted.filter((b) =>
            this.bookmark_primary_category.some((bpc) => bpc.bookmark_id === b.id),
          ).length,
        },
      ];
    }
    if (u.startsWith('SELECT COUNT(*) AS C FROM TAGS WHERE USER_ID = ?')) {
      const userId = params[0] as string;
      return [{ c: this.tags.filter((t) => t.user_id === userId).length }];
    }

    // --- stats trend (A3 report page): per-day additions --------------
    if (u.startsWith('SELECT SUBSTR(CREATED_AT, 1, 10) AS D, COUNT(*) AS C')) {
      const userId = params[0] as string;
      const since = params[1] as string;
      const buckets = new Map<string, number>();
      for (const b of this.bookmarks) {
        if (b.user_id !== userId) continue;
        if (b.deleted_at != null) continue;
        if (String(b.created_at) < since) continue;
        if (b.is_private === 1) continue;
        if (this.hasPrivateTag(b.id, userId)) continue;
        const d = String(b.created_at).slice(0, 10);
        buckets.set(d, (buckets.get(d) ?? 0) + 1);
      }
      return [...buckets.entries()].map(([d, c]) => ({ d, c }));
    }

    // --- ai: loadVocabulary (tags + usage counts + parent_id) --------
    if (
      u.startsWith(
        'SELECT T.ID AS ID, T.NAME AS NAME, T.ALIASES AS ALIASES, T.PARENT_ID AS PARENT_ID, T.STATUS AS STATUS, T.CREATED_AT AS CREATED_AT, COUNT(B.ID) AS CNT FROM TAGS T LEFT JOIN',
      )
    ) {
      const userId = params[0] as string;
      return this.tags
        .filter((t) => t.user_id === userId)
        .map((t) => ({
          id: t.id,
          name: t.name,
          aliases: t.aliases ?? null,
          parent_id: t.parent_id ?? null,
          status: t.status ?? 'active',
          created_at: t.created_at ?? null,
          cnt: this.bookmark_tags.filter((bt) => {
            if (bt.tag_id !== t.id) return false;
            const b = this.bookmarks.find((x) => x.id === bt.bookmark_id && x.deleted_at == null);
            return Boolean(b);
          }).length,
        }));
    }

    // --- ai: undoJob step 1 — delete traceable source='ai' links -----
    if (u.startsWith("DELETE FROM BOOKMARK_TAGS WHERE SOURCE = 'AI'")) {
      const userId = params[0] as string;
      const jobId = params[1] as string;
      const accepted = this.tag_suggestions.filter(
        (s) => s.user_id === userId && s.job_id === jobId && s.status === 'accepted',
      );
      const before = this.bookmark_tags.length;
      this.bookmark_tags = this.bookmark_tags.filter((bt) => {
        if (bt.source !== 'ai') return true;
        return !accepted.some(
          (s) =>
            s.bookmark_id === bt.bookmark_id &&
            this.tags.some(
              (t) =>
                t.id === bt.tag_id &&
                t.user_id === userId &&
                String(t.name).toLowerCase() === String(s.tag_name).toLowerCase(),
            ),
        );
      });
      this.lastChanges = before - this.bookmark_tags.length;
      return [];
    }

    // --- ai: undoJob step 2 — restore accepted → pending -------------
    if (
      u.startsWith("UPDATE TAG_SUGGESTIONS SET STATUS = 'PENDING', DECIDED_AT = NULL") &&
      u.includes('AND JOB_ID = ?')
    ) {
      const userId = params[0] as string;
      const jobId = params[1] as string;
      let changes = 0;
      for (const s of this.tag_suggestions) {
        if (s.user_id !== userId || s.job_id !== jobId || s.status !== 'accepted') continue;
        const blocked = this.tag_suggestions.some(
          (s2) =>
            s2.id !== s.id &&
            s2.bookmark_id === s.bookmark_id &&
            String(s2.tag_name).toLowerCase() === String(s.tag_name).toLowerCase() &&
            s2.status === 'pending',
        );
        if (blocked) continue;
        s.status = 'pending';
        s.decided_at = null;
        changes += 1;
      }
      this.lastChanges = changes;
      return [];
    }

    // --- ai: undoJob step 3 — drop superseded accepted rows ----------
    if (
      u.startsWith('DELETE FROM TAG_SUGGESTIONS WHERE USER_ID = ? AND JOB_ID = ?') &&
      u.includes("STATUS = 'ACCEPTED'")
    ) {
      const userId = params[0] as string;
      const jobId = params[1] as string;
      const before = this.tag_suggestions.length;
      this.tag_suggestions = this.tag_suggestions.filter((s) => {
        if (s.user_id !== userId || s.job_id !== jobId || s.status !== 'accepted') return true;
        const superseded = this.tag_suggestions.some(
          (s2) =>
            s2.id !== s.id &&
            s2.bookmark_id === s.bookmark_id &&
            String(s2.tag_name).toLowerCase() === String(s.tag_name).toLowerCase() &&
            s2.status === 'pending',
        );
        return !superseded;
      });
      this.lastChanges = before - this.tag_suggestions.length;
      return [];
    }

    // --- bookmark_tags (tag re-link on restore) ----------------------
    if (u.startsWith('DELETE FROM BOOKMARK_TAGS WHERE BOOKMARK_ID = ?')) {
      const [bookmarkId] = params as string[];
      this.bookmark_tags = this.bookmark_tags.filter((bt) => bt.bookmark_id !== bookmarkId);
      return [];
    }
    // --- bookmark_tags: merge repoint (INSERT OR IGNORE ... SELECT) --
    // Must precede the plain two-param INSERT OR IGNORE handler below.
    if (
      u.startsWith('INSERT OR IGNORE INTO BOOKMARK_TAGS') &&
      u.includes('SELECT BT.BOOKMARK_ID')
    ) {
      const targetId = params[0] as string;
      const userId = params[1] as string;
      const sourceIds = params.slice(2) as string[];
      for (const bt of [...this.bookmark_tags]) {
        if (!sourceIds.includes(bt.tag_id)) continue;
        const tag = this.tags.find((t) => t.id === bt.tag_id);
        if (!tag || tag.user_id !== userId) continue;
        if (
          !this.bookmark_tags.find(
            (x) => x.bookmark_id === bt.bookmark_id && x.tag_id === targetId,
          )
        ) {
          this.bookmark_tags.push({ bookmark_id: bt.bookmark_id, tag_id: targetId });
        }
      }
      return [];
    }
    if (u.startsWith('INSERT OR IGNORE INTO BOOKMARK_TAGS')) {
      const [bookmark_id, tag_id] = params as string[];
      if (
        !this.bookmark_tags.find(
          (bt) => bt.bookmark_id === bookmark_id && bt.tag_id === tag_id,
        )
      ) {
        this.bookmark_tags.push({ bookmark_id, tag_id });
      }
      return [];
    }
    // --- bookmark_tags: attachTags bridge (tag ids → tags for bookmarks) ---
    if (
      u.startsWith(
        'SELECT BT.BOOKMARK_ID, T.ID, T.NAME, T.COLOR_INDEX, T.PARENT_ID, T.SORT_ORDER, T.STATUS, T.CREATED_AT FROM BOOKMARK_TAGS BT JOIN TAGS T',
      )
    ) {
      const ids = params as string[];
      const rows: MockRow[] = [];
      for (const bt of this.bookmark_tags) {
        if (!ids.includes(bt.bookmark_id)) continue;
        const tag = this.tags.find((t) => t.id === bt.tag_id);
        if (!tag) continue;
        rows.push({
          bookmark_id: bt.bookmark_id,
          id: tag.id,
          name: tag.name,
          color_index: tag.color_index ?? 0,
          parent_id: tag.parent_id ?? null,
          sort_order: tag.sort_order ?? 0,
          status: tag.status ?? 'active',
          created_at: tag.created_at ?? '',
        });
      }
      rows.sort((a, b) => {
        const so = Number(a.sort_order) - Number(b.sort_order);
        if (so !== 0) return so;
        return String(a.name).localeCompare(String(b.name), 'zh-CN');
      });
      return rows;
    }

    // --- tags (ensureTags during restore) ----------------------------
    if (u.startsWith('SELECT ID, NAME FROM TAGS WHERE USER_ID = ? AND NAME COLLATE NOCASE IN')) {
      const userId = params[0] as string;
      const names = (params.slice(1) as string[]).map((n) => String(n).toLowerCase());
      return this.tags
        .filter((t) => t.user_id === userId && names.includes(String(t.name).toLowerCase()))
        .map((t) => ({ id: t.id, name: t.name }));
    }
    if (u.startsWith('INSERT OR IGNORE INTO TAGS')) {
      const m = u.match(/INSERT OR IGNORE INTO TAGS \(([^)]+)\) VALUES \(([^)]*)\)/);
      if (m) {
        const row = parseInsertRow(m[1], m[2], params);
        // Mirrors the unique index on (user_id, name COLLATE NOCASE): a
        // concurrent duplicate gets no row back, so the handler surfaces a 409.
        const dup = this.tags.find(
          (t) =>
            t.user_id === row.user_id &&
            String(t.name).toLowerCase() === String(row.name).toLowerCase(),
        );
        if (dup) return [];
        this.tags.push(row);
        return [{ id: row.id }];
      }
    }
    if (u.startsWith('INSERT INTO TAGS')) {
      const m = u.match(/INSERT INTO TAGS \(([^)]+)\) VALUES \(([^)]*)\)/);
      if (m) {
        this.tags.push(parseInsertRow(m[1], m[2], params));
        return [];
      }
    }

    // P2-3: ensureTags marks freshly minted AI tags 'pending' (binds ts/id/user).
    if (u.startsWith("UPDATE TAGS SET STATUS = 'PENDING'")) {
      const [updatedAt, tagId, userId] = params as string[];
      let changes = 0;
      for (const t of this.tags) {
        if (t.id === tagId && t.user_id === userId) {
          t.status = 'pending';
          t.updated_at = updatedAt;
          changes += 1;
        }
      }
      this.lastChanges = changes;
      return [];
    }

    // P2-3: promotePendingTags flips pending tags with live support >= minSupport
    // to 'active' (binds ts/user/minSupport). Live support counts only links to
    // non-trashed bookmarks, mirroring the correlated subquery.
    if (u.startsWith("UPDATE TAGS SET STATUS = 'ACTIVE'") && u.includes("STATUS = 'PENDING'")) {
      const updatedAt = params[0] as string;
      const userId = params[1] as string;
      const minSupport = Number(params[2]);
      let changes = 0;
      for (const t of this.tags) {
        if (t.user_id !== userId || (t.status ?? 'active') !== 'pending') continue;
        const liveSupport = this.bookmark_tags.filter((bt) => {
          if (bt.tag_id !== t.id) return false;
          const b = this.bookmarks.find((x) => x.id === bt.bookmark_id);
          return Boolean(b && b.deleted_at == null);
        }).length;
        if (liveSupport >= minSupport) {
          t.status = 'active';
          t.updated_at = updatedAt;
          changes += 1;
        }
      }
      this.lastChanges = changes;
      return [];
    }

    // --- tags: governance (merge ownership check, bulk ops) ----------
    if (u.startsWith('SELECT ID, NAME FROM TAGS WHERE USER_ID = ? AND ID IN')) {
      const userId = params[0] as string;
      const ids = params.slice(1) as string[];
      return this.tags
        .filter((t) => t.user_id === userId && ids.includes(t.id))
        .map((t) => ({ id: t.id, name: t.name }));
    }
    if (u.startsWith('DELETE FROM TAGS WHERE USER_ID = ? AND ID IN')) {
      const userId = params[0] as string;
      const ids = params.slice(1) as string[];
      const before = this.tags.length;
      this.tags = this.tags.filter((t) => !(t.user_id === userId && ids.includes(t.id)));
      this.lastChanges = before - this.tags.length;
      return [];
    }
    if (u.startsWith('DELETE FROM TAGS WHERE ID = ? AND USER_ID = ?')) {
      const [id, userId] = params as string[];
      const before = this.tags.length;
      this.tags = this.tags.filter((t) => !(t.id === id && t.user_id === userId));
      this.lastChanges = before - this.tags.length;
      return [];
    }

    // --- tag_merge_log (merge audit trail) ---------------------------
    if (u.startsWith('INSERT INTO TAG_MERGE_LOG')) {
      const [id, user_id, target_tag_id, target_tag_name, source_tag_names, merged_count, created_at] =
        params as [string, string, string, string, string, number, string];
      this.tag_merge_log.push({
        id,
        user_id,
        target_tag_id,
        target_tag_name,
        source_tag_names,
        merged_count,
        created_at,
      });
      return [];
    }
    if (u.startsWith('SELECT ID, TARGET_TAG_ID, TARGET_TAG_NAME, SOURCE_TAG_NAMES')) {
      const userId = params[0] as string;
      return this.tag_merge_log
        .filter((r) => r.user_id === userId)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, 50);
    }

    // --- backup: targets & runs (WebDAV / S3 push) -------------------
    if (u.startsWith('SELECT * FROM BACKUP_TARGETS WHERE USER_ID = ?')) {
      const userId = params[0] as string;
      let rows = this.backupTargets.filter((t) => t.user_id === userId);
      if (u.includes('ENABLED = 1')) rows = rows.filter((t) => t.enabled === 1);
      if (u.includes('AND ID = ?')) {
        const id = params[1] as string;
        rows = rows.filter((t) => t.id === id);
      }
      rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      return rows;
    }
    if (u.startsWith('SELECT * FROM BACKUP_TARGETS WHERE ID = ? AND USER_ID = ?')) {
      const id = params[0] as string;
      const userId = params[1] as string;
      return this.backupTargets.filter((t) => t.id === id && t.user_id === userId);
    }
    if (u.startsWith('SELECT ID, ENCRYPTED_SECRET FROM BACKUP_TARGETS WHERE ID = ? AND USER_ID = ?')) {
      const id = params[0] as string;
      const userId = params[1] as string;
      return this.backupTargets
        .filter((t) => t.id === id && t.user_id === userId)
        .map((t) => ({ id: t.id, encrypted_secret: t.encrypted_secret }));
    }
    if (u.startsWith('SELECT ID FROM BACKUP_TARGETS WHERE ID = ? AND USER_ID = ?')) {
      const id = params[0] as string;
      const userId = params[1] as string;
      return this.backupTargets.filter((t) => t.id === id && t.user_id === userId);
    }
    if (u.startsWith('INSERT INTO BACKUP_TARGETS')) {
      const [id, user_id, kind, endpoint, bucket, username, encrypted_secret, remote_path, enabled, frequency, created_at, updated_at] =
        params as [string, string, string, string, string | null, string | null, string | null, string, number, string, string, string];
      this.backupTargets.push({
        id, user_id, kind, endpoint, bucket: bucket ?? null, username: username ?? null,
        encrypted_secret: encrypted_secret ?? null, remote_path, enabled, frequency,
        last_run_at: null, last_status: null, created_at, updated_at,
      });
      return [];
    }
    if (u.startsWith('INSERT INTO BACKUP_RUNS')) {
      // ok: (id,user_id,target_id,started_at,finished_at,bytes,sha256)  status literal 'ok'
      // failed: (id,user_id,target_id,started_at,finished_at,error)      status literal 'failed'
      const status = u.includes("'OK'") ? 'ok' : 'failed';
      const [rid, user_id, target_id, started_at, finished_at] = params as [string, string, string, string, string];
      if (status === 'ok') {
        const bytes = params[5] as number;
        const sha256 = params[6] as string;
        this.backupRuns.push({ id: rid, user_id, target_id, started_at, finished_at, status, bytes, sha256, error: null });
      } else {
        const error = params[5] as string;
        this.backupRuns.push({ id: rid, user_id, target_id, started_at, finished_at, status, bytes: null, sha256: null, error });
      }
      return [];
    }
    if (u.startsWith('UPDATE BACKUP_TARGETS SET')) {
      const id = params[params.length - 2] as string;
      const userId = params[params.length - 1] as string;
      const row = this.backupTargets.find((t) => t.id === id && t.user_id === userId);
      if (!row) return [];
      const setClause = sql.slice(sql.toUpperCase().indexOf('SET') + 3, sql.toUpperCase().indexOf('WHERE')).trim();
      const cols = setClause.split(',').map((c) => c.trim().split('=')[0].trim().toLowerCase());
      for (let i = 0; i < cols.length; i += 1) {
        row[cols[i]] = params[i];
      }
      return [];
    }
    if (u.startsWith('DELETE FROM BACKUP_RUNS WHERE TARGET_ID = ? AND USER_ID = ?')) {
      const targetId = params[0] as string;
      const userId = params[1] as string;
      this.backupRuns = this.backupRuns.filter((r) => !(r.target_id === targetId && r.user_id === userId));
      return [];
    }
    if (u.startsWith('DELETE FROM BACKUP_TARGETS WHERE ID = ? AND USER_ID = ?')) {
      const id = params[0] as string;
      const userId = params[1] as string;
      this.backupTargets = this.backupTargets.filter((t) => !(t.id === id && t.user_id === userId));
      return [];
    }
    if (u.startsWith('SELECT R.ID, R.TARGET_ID, T.KIND, T.ENDPOINT, R.STARTED_AT, R.FINISHED_AT, R.STATUS, R.BYTES, R.SHA256, R.ERROR FROM BACKUP_RUNS R JOIN BACKUP_TARGETS T')) {
      const userId = params[0] as string;
      return this.backupRuns
        .filter((r) => r.user_id === userId)
        .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))
        .slice(0, 50)
        .map((r) => {
          const t = this.backupTargets.find((x) => x.id === r.target_id);
          return {
            id: r.id, target_id: r.target_id, kind: t?.kind ?? null, endpoint: t?.endpoint ?? null,
            started_at: r.started_at, finished_at: r.finished_at, status: r.status,
            bytes: r.bytes, sha256: r.sha256, error: r.error,
          };
        });
    }

    // --- tags: category-private listing (listPrivateTagsWithBookmarks) -
    if (
      u.startsWith(
        'SELECT T.ID, T.NAME, T.COLOR_INDEX, T.PARENT_ID, T.SORT_ORDER, T.IS_PRIVATE, T.CREATED_AT',
      )
    ) {
      const userId = params[0] as string;
      return this.tags
        .filter((t) => t.user_id === userId && t.is_private === 1)
        .sort((a, b) => {
          const so = Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0);
          if (so !== 0) return so;
          return String(a.name).localeCompare(String(b.name), 'zh-CN');
        })
        .map((t) => ({
          id: t.id,
          name: t.name,
          color_index: t.color_index,
          parent_id: t.parent_id ?? null,
          sort_order: Number(t.sort_order ?? 0),
          is_private: t.is_private,
          created_at: t.created_at,
          count: this.bookmark_tags.filter((bt) => {
            if (bt.tag_id !== t.id) return false;
            const b = this.bookmarks.find(
              (x) => x.id === bt.bookmark_id && x.user_id === userId && x.deleted_at == null && x.is_private !== 1,
            );
            return Boolean(b);
          }).length,
        }));
    }

    // --- bookmarks: members of a private tag (listPrivateTagsWithBookmarks)
    if (
      u.startsWith(
        'SELECT DISTINCT BT.TAG_ID AS TAG_ID, B.ID, B.URL, B.TITLE, B.FAVICON_URL, B.NOTE, B.IS_FAVORITE, B.IS_ARCHIVED, B.CREATED_AT',
      )
    ) {
      const tUserId = params[0] as string;
      const bUserId = params[1] as string;
      const qLike =
        params.length > 2 ? String(params[2]).replace(/%/g, '').toLowerCase() : null;
      const matchesQ = (b: MockRow) =>
        !qLike ||
        String(b.title ?? '').toLowerCase().includes(qLike) ||
        String(b.url ?? '').toLowerCase().includes(qLike) ||
        (b.note != null && String(b.note).toLowerCase().includes(qLike));
      const pairs: MockRow[] = [];
      for (const bt of this.bookmark_tags) {
        const t = this.tags.find((x) => x.id === bt.tag_id);
        if (!t || t.user_id !== tUserId || t.is_private !== 1) continue;
        const b = this.bookmarks.find((x) => x.id === bt.bookmark_id);
        if (
          b &&
          b.user_id === bUserId &&
          b.deleted_at == null &&
          b.is_private !== 1 &&
          matchesQ(b)
        ) {
          pairs.push({
            tag_id: bt.tag_id,
            id: b.id,
            url: b.url,
            title: b.title,
            favicon_url: b.favicon_url ?? null,
            note: b.note ?? null,
            is_favorite: b.is_favorite === 1 ? 1 : 0,
            is_archived: b.is_archived === 1 ? 1 : 0,
            created_at: b.created_at,
          });
        }
      }
      pairs.sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh-CN'));
      return pairs;
    }

    // --- tags: setTagPrivate recursive-cascade UPDATE -----------------
    if (u.startsWith('WITH RECURSIVE SUB(ID) AS') && u.includes('UPDATE TAGS SET IS_PRIVATE')) {
      const [tagId, userId, flag, ts] = params as [string, string, number, string];
      // Collect the whole subtree rooted at tagId (the tag itself + every
      // descendant reached by walking parent_id). Mirrors the SQL CTE; the
      // UNION (not UNION ALL) in the real query also de-dups, which guards a
      // theoretical cycle — the visited set here does the same.
      const ids = new Set<string>();
      const stack = [tagId];
      while (stack.length) {
        const cur = stack.pop() as string;
        if (ids.has(cur)) continue;
        ids.add(cur);
        for (const t of this.tags) {
          if (t.user_id === userId && t.parent_id === cur) stack.push(t.id);
        }
      }
      let changes = 0;
      for (const t of this.tags) {
        if (t.user_id === userId && ids.has(t.id) && t.is_private !== flag) {
          t.is_private = flag;
          t.updated_at = ts;
          changes += 1;
        }
      }
      this.lastChanges = changes;
      return [];
    }

    // --- bookmarks: public single read (loadBookmark) ----------------
    if (
      u.startsWith(
        'SELECT B.ID, B.URL, B.TITLE, B.DESCRIPTION, B.FAVICON_URL, B.COVER_URL, B.SNAPSHOT_KEY, B.SNAPSHOT_KEYS, B.NOTE, B.AI_SUMMARY, B.IS_FAVORITE, B.IS_ARCHIVED, B.VISIT_COUNT, B.LAST_VISITED_AT, B.MANUAL_ORDER, B.CREATED_AT, B.UPDATED_AT, B.DELETED_AT FROM BOOKMARKS B WHERE B.ID = ? AND B.USER_ID = ? AND B.IS_PRIVATE = 0 AND NOT EXISTS',
      )
    ) {
      const [id, userId] = params as string[];
      return this.bookmarks
        .filter(
          (b) =>
            b.id === id &&
            b.user_id === userId &&
            b.is_private !== 1 &&
            b.deleted_at == null &&
            !this.hasPrivateTag(b.id, userId),
        )
        .slice(0, 1)
        .map((b) => ({ ...b }));
    }
    // --- bookmarks: similar-bookmarks candidate pool (excludes source) -
    if (
      u.startsWith(
        'SELECT B.ID, B.URL, B.TITLE, B.DESCRIPTION, B.FAVICON_URL, B.COVER_URL, B.SNAPSHOT_KEY, B.SNAPSHOT_KEYS, B.NOTE, B.AI_SUMMARY, B.IS_FAVORITE, B.IS_ARCHIVED, B.VISIT_COUNT, B.LAST_VISITED_AT, B.MANUAL_ORDER, B.CREATED_AT, B.UPDATED_AT, B.DELETED_AT FROM BOOKMARKS B WHERE',
      ) &&
      u.includes('AND B.ID <> ?')
    ) {
      const userId = params[0] as string;
      const sourceId = params[params.length - 1] as string;
      return this.bookmarks
        .filter(
          (b) =>
            b.user_id === userId &&
            b.is_private !== 1 &&
            b.deleted_at == null &&
            b.is_archived !== 1 &&
            !this.hasPrivateTag(b.id, userId) &&
            b.id !== sourceId,
        )
        .map((b) => ({ ...b }));
    }
    // --- bookmarks: public list (runList / listBookmarks) ------------
    if (
      u.startsWith(
        'SELECT B.ID, B.URL, B.TITLE, B.DESCRIPTION, B.FAVICON_URL, B.COVER_URL, B.SNAPSHOT_KEY, B.SNAPSHOT_KEYS, B.NOTE, B.AI_SUMMARY, B.IS_FAVORITE, B.IS_ARCHIVED, B.VISIT_COUNT, B.LAST_VISITED_AT, B.MANUAL_ORDER, B.CREATED_AT, B.UPDATED_AT, B.DELETED_AT FROM BOOKMARKS B WHERE',
      )
    ) {
      const userId = params[0] as string;
      return this.visibleBookmarksForScope(userId, u).map((b) => ({ ...b }));
    }
    // --- bookmarks: public list total (runList COUNT) ----------------
    if (u.startsWith('SELECT COUNT(*) AS C FROM BOOKMARKS B WHERE')) {
      const userId = params[0] as string;
      return [{ c: this.visibleBookmarksForScope(userId, u).length }];
    }

    // --- bookmarks: snapshot monitor list (listBookmarksWithSnapshots) -
    if (
      u.startsWith(
        'SELECT B.ID, B.URL, B.TITLE, B.SNAPSHOT_KEY, B.SNAPSHOT_KEYS, B.VISIT_COUNT, B.LAST_VISITED_AT FROM BOOKMARKS B WHERE',
      )
    ) {
      const userId = params[0] as string;
      return this.bookmarks
        .filter(
          (b) =>
            b.user_id === userId &&
            b.is_private !== 1 &&
            b.deleted_at == null &&
            b.is_archived !== 1 &&
            b.snapshot_key != null &&
            !this.hasPrivateTag(b.id, userId),
        )
        .sort((a, b) => Number(b.visit_count) - Number(a.visit_count))
        .map((b) => ({
          id: b.id,
          url: b.url,
          title: b.title,
          snapshot_key: b.snapshot_key,
          snapshot_keys: b.snapshot_keys,
          visit_count: b.visit_count,
          last_visited_at: b.last_visited_at,
        }));
    }

    // --- bookmarks: snapshot maintenance scan (loadAllBookmarkSnapshotRefs)
    if (
      u.startsWith(
        'SELECT B.ID, B.URL, B.TITLE, B.SNAPSHOT_KEY, B.SNAPSHOT_KEYS, B.VISIT_COUNT, B.LAST_VISITED_AT FROM BOOKMARKS B WHERE B.USER_ID = ? AND B.IS_PRIVATE = 0 AND NOT EXISTS',
      )
    ) {
      const userId = params[0] as string;
      return this.bookmarks
        .filter(
          (b) =>
            b.user_id === userId &&
            b.is_private !== 1 &&
            !this.hasPrivateTag(b.id, userId),
        )
        .map((b) => ({
          id: b.id,
          url: b.url,
          title: b.title,
          snapshot_key: b.snapshot_key,
          snapshot_keys: b.snapshot_keys,
          visit_count: b.visit_count,
          last_visited_at: b.last_visited_at,
        }));
    }

    // --- bookmarks: private single read ------------------------------
    if (
      u.startsWith(
        'SELECT B.ID, B.ENCRYPTED_BLOB, B.IS_FAVORITE, B.IS_ARCHIVED, B.CREATED_AT, B.UPDATED_AT FROM BOOKMARKS B WHERE B.ID = ? AND B.USER_ID = ? AND B.IS_PRIVATE = 1 LIMIT 1',
      )
    ) {
      const [id, userId] = params as string[];
      return this.bookmarks
        .filter((b) => b.id === id && b.user_id === userId && b.is_private === 1)
        .slice(0, 1)
        .map((b) => ({
          id: b.id,
          encrypted_blob: b.encrypted_blob,
          is_favorite: b.is_favorite,
          is_archived: b.is_archived,
          created_at: b.created_at,
          updated_at: b.updated_at,
        }));
    }
    // --- bookmarks: private list (listPrivateBookmarkRows) -----------
    if (
      u.startsWith(
        'SELECT B.ID, B.ENCRYPTED_BLOB, B.IS_FAVORITE, B.IS_ARCHIVED, B.CREATED_AT, B.UPDATED_AT FROM BOOKMARKS B WHERE B.USER_ID = ? AND B.IS_PRIVATE = 1',
      )
    ) {
      const userId = params[0] as string;
      return this.bookmarks
        .filter((b) => b.user_id === userId && b.is_private === 1 && b.deleted_at == null)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .map((b) => ({
          id: b.id,
          encrypted_blob: b.encrypted_blob,
          is_favorite: b.is_favorite,
          is_archived: b.is_archived,
          created_at: b.created_at,
          updated_at: b.updated_at,
        }));
    }

    // --- bookmarks: clash check before restoring a private bookmark --
    if (
      u.startsWith(
        'SELECT ID FROM BOOKMARKS WHERE USER_ID = ? AND URL_KEY = ? AND DELETED_AT IS NULL AND ID <> ?',
      )
    ) {
      const [userId, urlKeyParam, id] = params as string[];
      return this.bookmarks
        .filter(
          (b) =>
            b.user_id === userId &&
            b.url_key === urlKeyParam &&
            b.deleted_at == null &&
            b.id !== id,
        )
        .slice(0, 1)
        .map((b) => ({ id: b.id }));
    }

    // --- bookmarks: set private (blank + flag) -----------------------
    if (u.startsWith('UPDATE BOOKMARKS SET IS_PRIVATE = 1, URL =')) {
      const [urlKeyParam, encryptedBlob, ts, id, userId] = params as string[];
      const row = this.bookmarks.find(
        (b) => b.id === id && b.user_id === userId && b.deleted_at == null && b.is_private !== 1,
      );
      if (row) {
        row.is_private = 1;
        row.url = '';
        row.url_key = urlKeyParam;
        row.title = '';
        row.description = null;
        row.favicon_url = null;
        row.cover_url = null;
        row.note = null;
        row.encrypted_blob = encryptedBlob;
        row.updated_at = ts;
        this.lastChanges = 1;
      } else {
        this.lastChanges = 0;
      }
      return [];
    }
    // --- bookmarks: clear private (restore plaintext) ----------------
    if (u.startsWith('UPDATE BOOKMARKS SET IS_PRIVATE = 0, URL = ?')) {
      const [url, urlKeyParam, title, description, favicon, cover, note, ts, id, userId] =
        params as unknown[];
      const row = this.bookmarks.find(
        (b) => b.id === id && b.user_id === userId && b.is_private === 1,
      );
      if (row) {
        row.is_private = 0;
        row.url = url;
        row.url_key = urlKeyParam;
        row.title = title;
        row.description = description;
        row.favicon_url = favicon;
        row.cover_url = cover;
        row.note = note;
        row.encrypted_blob = null;
        row.updated_at = ts;
        this.lastChanges = 1;
      } else {
        this.lastChanges = 0;
      }
      return [];
    }
    // --- bookmarks: re-encrypt a private row -------------------------
    if (u.startsWith('UPDATE BOOKMARKS SET ENCRYPTED_BLOB = ?, UPDATED_AT = ?')) {
      const [encryptedBlob, ts, id, userId] = params as string[];
      const row = this.bookmarks.find(
        (b) => b.id === id && b.user_id === userId && b.is_private === 1,
      );
      if (row) {
        row.encrypted_blob = encryptedBlob;
        row.updated_at = ts;
        this.lastChanges = 1;
      } else {
        this.lastChanges = 0;
      }
      return [];
    }
    // --- bookmarks: delete a private row -----------------------------
    if (u.startsWith('DELETE FROM BOOKMARKS WHERE ID = ? AND USER_ID = ? AND IS_PRIVATE = 1')) {
      const [id, userId] = params as string[];
      const before = this.bookmarks.length;
      this.bookmarks = this.bookmarks.filter(
        (b) => !(b.id === id && b.user_id === userId && b.is_private === 1),
      );
      this.lastChanges = before - this.bookmarks.length;
      return [];
    }
    // --- feeds (B-11 RSS subscriptions) ------------------------------
    if (
      u.startsWith('INSERT INTO FEEDS') ||
      u.startsWith('INSERT OR IGNORE INTO FEEDS')
    ) {
      const m = u.match(/INTO FEEDS \(([^)]+)\) VALUES \(([^)]*)\)/);
      if (m) {
        const row = parseInsertRow(m[1], m[2], params);
        // Mirrors the unique (id) primary key: a duplicate id overwrites.
        const existing = this.feeds.find((f) => f.id === row.id);
        if (existing) Object.assign(existing, row);
        else this.feeds.push(row);
      }
      return [];
    }
    if (u.startsWith('UPDATE FEEDS SET')) {
      const [lastFetchedAt, lastStatus, updatedAt, id, userId] = params as string[];
      const row = this.feeds.find((f) => f.id === id && f.user_id === userId);
      if (row) {
        row.last_fetched_at = lastFetchedAt ?? null;
        row.last_status = lastStatus ?? null;
        row.updated_at = updatedAt;
        this.lastChanges = 1;
      } else {
        this.lastChanges = 0;
      }
      return [];
    }
    if (u.startsWith('DELETE FROM FEEDS WHERE ID = ? AND USER_ID = ?')) {
      const [id, userId] = params as string[];
      const before = this.feeds.length;
      this.feeds = this.feeds.filter((f) => !(f.id === id && f.user_id === userId));
      this.lastChanges = before - this.feeds.length;
      return [];
    }
    // Single feed lookup (refresh / delete guard). Params: [id, userId].
    if (u.includes('FROM FEEDS WHERE ID = ? AND USER_ID = ?')) {
      const [id, userId] = params as string[];
      return this.feeds.filter((f) => f.id === id && f.user_id === userId);
    }
    // List of a user's feeds, newest first. Param: [userId].
    if (u.includes('FROM FEEDS WHERE USER_ID = ?')) {
      const userId = params[0] as string;
      return [...this.feeds]
        .filter((f) => f.user_id === userId)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    }

    // --- bookmarks: OR IGNORE insert (refreshFeed) -------------------
    if (u.startsWith('INSERT OR IGNORE INTO BOOKMARKS')) {
      const m = u.match(/INSERT OR IGNORE INTO BOOKMARKS \(([^)]+)\) VALUES \(([^)]*)\)/);
      if (m) {
        const row = parseInsertRow(m[1], m[2], params);
        const dup = this.bookmarks.find(
          (b) => b.user_id === row.user_id && b.url_key === row.url_key && b.deleted_at == null,
        );
        if (dup) {
          this.lastChanges = 0;
          return [];
        }
        this.bookmarks.push(row);
        this.lastChanges = 1;
      }
      return [];
    }

    // --- bookmarks: existing-key lookup during feed refresh ----------
    if (
      u.startsWith(
        'SELECT URL_KEY FROM BOOKMARKS WHERE USER_ID = ? AND DELETED_AT IS NULL AND URL_KEY IN',
      )
    ) {
      const userId = params[0] as string;
      const keys = (params.slice(1) as string[]).filter(Boolean);
      return this.bookmarks
        .filter((b) => b.user_id === userId && b.deleted_at == null && keys.includes(b.url_key))
        .map((b) => ({ url_key: b.url_key }));
    }

    // --- bookmarks: sync-keys reconciliation listing (B-12) ----------
    // Mirrors functions/api/bookmarks/sync-keys.ts exactly. Bind order:
    // first page  -> [userId, userId, limit]
    // cursor page -> [userId, userId, cu, cu, cid, limit]
    if (u.startsWith('SELECT ID, URL_KEY, UPDATED_AT, TITLE FROM BOOKMARKS WHERE USER_ID = ? AND DELETED_AT IS NULL')) {
      const userId = params[0] as string;
      const hasCursor = u.includes('UPDATED_AT > ?');
      let rows = this.bookmarks.filter(
        (b) =>
          b.user_id === userId &&
          b.deleted_at == null &&
          b.is_private !== 1 &&
          !this.hasPrivateTag(b.id, userId),
      );
      if (hasCursor) {
        const cu = String(params[2]);
        const cid = String(params[4]);
        rows = rows.filter(
          (b) =>
            String(b.updated_at) > cu ||
            (String(b.updated_at) === cu && String(b.id) > cid),
        );
      }
      rows = rows.sort(
        (a, b) =>
          String(a.updated_at).localeCompare(String(b.updated_at)) ||
          String(a.id).localeCompare(String(b.id)),
      );
      const limit = Number(params[params.length - 1]);
      return rows
        .slice(0, limit)
        .map((b) => ({ id: b.id, url_key: b.url_key, updated_at: b.updated_at, title: b.title ?? '' }));
    }

    // --- bookmarks: sync-pull incremental changelog (B-12) ----------
    // Mirrors functions/api/bookmarks/sync-pull.ts exactly. Includes soft-deleted
    // rows so deletions propagate. `since`/`cursor` fold into one keyset
    // `(updated_at > ? OR (updated_at = ? AND id > ?))`; a bare `since` uses
    // id='' so every real id passes `id > ''`. Bind order:
    //   no cursor   -> [userId, userId, limit]
    //   cursor page -> [userId, userId, cu, cu, cid, limit]
    if (u.startsWith('SELECT ID, URL_KEY, URL, TITLE, UPDATED_AT, DELETED_AT FROM BOOKMARKS WHERE USER_ID = ? AND IS_PRIVATE = 0')) {
      const userId = params[0] as string;
      const hasCursor = u.includes('UPDATED_AT = ? AND ID > ?');
      let rows = this.bookmarks.filter(
        (b) => b.user_id === userId && b.is_private !== 1 && !this.hasPrivateTag(b.id, userId),
      );
      if (hasCursor) {
        const cu = String(params[2]);
        const cid = String(params[4]);
        rows = rows.filter(
          (b) =>
            String(b.updated_at) > cu ||
            (String(b.updated_at) === cu && String(b.id) > cid),
        );
      }
      rows = rows.sort(
        (a, b) =>
          String(a.updated_at).localeCompare(String(b.updated_at)) ||
          String(a.id).localeCompare(String(b.id)),
      );
      const limit = Number(params[params.length - 1]);
      return rows
        .slice(0, limit)
        .map((b) => ({
          id: b.id,
          url_key: b.url_key,
          url: b.url,
          title: b.title ?? '',
          updated_at: b.updated_at,
          deleted_at: b.deleted_at ?? null,
        }));
    }

    // --- category: tag-tree load for deriveCategoryPaths (C4-1) -----
    // One row per tag the user owns; the caller walks parent_id in memory.
    if (u.startsWith('SELECT ID, NAME, PARENT_ID FROM TAGS WHERE USER_ID = ?')) {
      const userId = params[0] as string;
      return this.tags
        .filter((t) => t.user_id === userId)
        .map((t) => ({ id: t.id, name: t.name, parent_id: t.parent_id ?? null }));
    }

    // --- category: batch placement lookup for deriveCategoryPaths ----
    // `SELECT bookmark_id, tag_id FROM bookmark_primary_category
    //   WHERE status = 'accepted' AND bookmark_id IN (...)`.
    if (u.startsWith('SELECT BOOKMARK_ID, TAG_ID FROM BOOKMARK_PRIMARY_CATEGORY')) {
      const ids = params.map(String);
      return this.bookmark_primary_category
        .filter((p) => p.status === 'accepted' && ids.includes(String(p.bookmark_id)))
        .map((p) => ({ bookmark_id: p.bookmark_id, tag_id: p.tag_id }));
    }

    // --- bookmarks: category-write updated_at bump (C5-2) -----------
    // `UPDATE bookmarks SET updated_at = ? WHERE user_id = ? AND id IN (...)`.
    // Distinct from the generic field-write branch below (which requires
    // `ID = ? AND USER_ID = ?`), so order does not matter, but keep it here
    // next to the other bookmark mutations for readability.
    if (u.startsWith('UPDATE BOOKMARKS SET UPDATED_AT = ? WHERE USER_ID = ? AND ID IN')) {
      const ts = params[0] as string;
      const userId = params[1] as string;
      const ids = params.slice(2).map(String);
      let changes = 0;
      for (const b of this.bookmarks) {
        if (b.user_id === userId && ids.includes(String(b.id))) {
          b.updated_at = ts;
          changes += 1;
        }
      }
      this.lastChanges = changes;
      return [];
    }

    // --- category: ensureCategoryPath existing-node lookup (C4-3) ---
    // Child variant: `... AND parent_id = ? AND name = ? COLLATE NOCASE LIMIT 1`.
    if (u.startsWith('SELECT ID FROM TAGS WHERE USER_ID = ? AND PARENT_ID = ? AND NAME = ?')) {
      const userId = params[0] as string;
      const parentId = params[1] as string;
      const name = String(params[2]).toLowerCase();
      const t = this.tags.find(
        (x) => x.user_id === userId && x.parent_id === parentId && String(x.name).toLowerCase() === name,
      );
      return t ? [{ id: t.id }] : [];
    }
    // Root variant: `... AND parent_id IS NULL AND name = ? COLLATE NOCASE LIMIT 1`.
    if (u.startsWith('SELECT ID FROM TAGS WHERE USER_ID = ? AND PARENT_ID IS NULL AND NAME = ?')) {
      const userId = params[0] as string;
      const name = String(params[1]).toLowerCase();
      const t = this.tags.find(
        (x) => x.user_id === userId && (x.parent_id ?? null) === null && String(x.name).toLowerCase() === name,
      );
      return t ? [{ id: t.id }] : [];
    }

    // --- category: primary-placement upsert (C4-3 / assign) ---------
    // Three source variants share the statement shape; the literal in the SQL
    // tells them apart. Bind orders:
    //   browser_folder / manual: [bookmark_id, tag_id, decided_at, updated_at]
    //   ai: [bookmark_id, tag_id, confidence, job_id, decided_at, updated_at]
    if (u.startsWith('INSERT INTO BOOKMARK_PRIMARY_CATEGORY')) {
      const isAi = u.includes("'AI'");
      const source = isAi ? 'ai' : u.includes("'MANUAL'") ? 'manual' : 'browser_folder';
      const bookmark_id = String(params[0]);
      const tag_id = String(params[1]);
      const confidence = isAi ? Number(params[2]) : null;
      const job_id = isAi ? ((params[3] as string | null) ?? null) : null;
      const decided_at = String(isAi ? params[4] : params[2]);
      const updated_at = String(isAi ? params[5] : params[3]);
      const existing = this.bookmark_primary_category.find((p) => p.bookmark_id === bookmark_id);
      if (existing) {
        existing.tag_id = tag_id;
        existing.confidence = confidence;
        existing.source = source;
        existing.job_id = job_id;
        existing.status = 'accepted';
        existing.decided_at = decided_at;
        existing.updated_at = updated_at;
      } else {
        this.bookmark_primary_category.push({
          bookmark_id,
          tag_id,
          confidence,
          source,
          job_id,
          status: 'accepted',
          decided_at,
          updated_at,
        });
      }
      return [];
    }

    // --- ai_feedback: recordFeedback insert (C4-3 feedback loop) ----
    if (u.startsWith('INSERT INTO AI_FEEDBACK')) {
      const [id, user_id, bookmark_id, tag_name, action, final_tag_id, source, confidence, domain, context, created_at] =
        params as unknown[];
      this.ai_feedback.push({
        id,
        user_id,
        bookmark_id,
        tag_name,
        action,
        final_tag_id: final_tag_id ?? null,
        source: source ?? null,
        confidence: confidence ?? null,
        domain: domain ?? null,
        context: context ?? null,
        created_at,
      });
      return [];
    }

    // --- bookmarks: generic insert (createPrivateBookmark) -----------
    if (u.startsWith('INSERT INTO BOOKMARKS')) {
      const m = u.match(/INSERT INTO BOOKMARKS \(([^)]+)\) VALUES \(([^)]*)\)/);
      if (m) {
        this.bookmarks.push(parseInsertRow(m[1], m[2], params));
        return [];
      }
    }

    // --- bookmarks: snapshot state read (loadSnapshotState) ----------
    if (u.startsWith('SELECT SNAPSHOT_KEY, SNAPSHOT_KEYS FROM BOOKMARKS WHERE ID = ? AND USER_ID = ?')) {
      const [id, userId] = params as string[];
      const row = this.bookmarks.find((b) => b.id === id && b.user_id === userId);
      if (!row) return [];
      return [{ snapshot_key: row.snapshot_key ?? null, snapshot_keys: row.snapshot_keys ?? null }];
    }
    // --- bookmarks: snapshot pointer update (updateBookmarkSnapshots) -
    if (u.startsWith('UPDATE BOOKMARKS SET SNAPSHOT_KEY = ?, SNAPSHOT_KEYS = ?, UPDATED_AT = ?')) {
      const [snapshotKey, snapshotKeys, ts, id, userId] = params as string[];
      const row = this.bookmarks.find((b) => b.id === id && b.user_id === userId);
      if (row) {
        row.snapshot_key = snapshotKey;
        row.snapshot_keys = snapshotKeys;
        row.updated_at = ts;
        this.lastChanges = 1;
      } else {
        this.lastChanges = 0;
      }
      return [];
    }

    // --- bookmarks: sync-push pre-lookup (B-12) ----------------------
    // Returns the row (live OR soft-deleted) keyed by url_key so the push
    // handler can revive vs update vs insert. Params: [userId, urlKey].
    if (
      u.startsWith('SELECT ID, UPDATED_AT, DELETED_AT, IS_FAVORITE, IS_ARCHIVED FROM BOOKMARKS WHERE USER_ID = ? AND URL_KEY = ?')
    ) {
      const [userId, urlKey] = params as string[];
      const row = this.bookmarks.find((b) => b.user_id === userId && b.url_key === urlKey);
      return row
        ? [
            {
              id: row.id,
              updated_at: row.updated_at,
              deleted_at: row.deleted_at ?? null,
              is_favorite: row.is_favorite ?? 0,
              is_archived: row.is_archived ?? 0,
            },
          ]
        : [];
    }
    // --- bookmarks: sync-push soft-delete by url_key (B-12) ----------
    // Mirrors deleteByKey in functions/api/bookmarks/sync-push.ts. Params:
    // [deleted_at, updated_at, userId, urlKey]. Idempotent: absent/live-missing
    // is a no-op.
    if (
      u.startsWith(
        'UPDATE BOOKMARKS SET DELETED_AT = ?, UPDATED_AT = ? WHERE USER_ID = ? AND URL_KEY = ?',
      )
    ) {
      const [delTs, ts, userId, urlKey] = params as string[];
      const row = this.bookmarks.find(
        (b) => b.user_id === userId && b.url_key === urlKey && b.deleted_at == null,
      );
      if (row) {
        row.deleted_at = delTs;
        row.updated_at = ts;
        this.lastChanges = 1;
      } else {
        this.lastChanges = 0;
      }
      return [];
    }
    // --- bookmarks: generic column UPDATE (sync-push field write) ----
    // Catches `UPDATE BOOKMARKS SET <cols> WHERE id = ? AND user_id = ?`. The
    // specific IS_PRIVATE / ENCRYPTED_BLOB / SNAPSHOT_KEY branches above run
    // first, so this only sees the sync-push field updates. Literal `NULL`
    // (reviving a soft-deleted row) is bound as a real `?` param here, so no
    // special-casing is needed.
    if (u.startsWith('UPDATE BOOKMARKS SET') && u.includes('ID = ? AND USER_ID = ?')) {
      const id = params[params.length - 2] as string;
      const userId = params[params.length - 1] as string;
      const row = this.bookmarks.find((b) => b.id === id && b.user_id === userId);
      if (!row) return [];
      const setClause = sql.slice(sql.toUpperCase().indexOf('SET') + 3, sql.toUpperCase().indexOf('WHERE')).trim();
      const cols = setClause.split(',').map((c) => c.trim().split('=')[0].trim().toLowerCase());
      for (let i = 0; i < cols.length; i += 1) {
        row[cols[i]] = params[i];
      }
      this.lastChanges = 1;
      return [];
    }

    // --- private_vault -----------------------------------------------
    if (u.startsWith('SELECT SALT, VERIFIER FROM PRIVATE_VAULT WHERE USER_ID = ?')) {
      const userId = params[0] as string;
      const v = this.private_vault.find((r) => r.user_id === userId);
      return v ? [{ salt: v.salt, verifier: v.verifier }] : [];
    }
    if (u.startsWith('SELECT USER_ID FROM PRIVATE_VAULT WHERE USER_ID = ?')) {
      const userId = params[0] as string;
      const v = this.private_vault.find((r) => r.user_id === userId);
      return v ? [{ user_id: v.user_id }] : [];
    }
    if (u.startsWith('INSERT INTO PRIVATE_VAULT')) {
      const [user_id, salt, verifier, created_at, updated_at] = params as string[];
      this.private_vault.push({ user_id, salt, verifier, created_at, updated_at });
      return [];
    }

    // --- shares (H1: password protection + collection shares) --------
    if (u.startsWith('SELECT DISPLAY_NAME FROM USERS WHERE ID = ?')) {
      const userId = params[0] as string;
      const user = this.users.find((r) => r.id === userId);
      return user ? [{ display_name: user.display_name ?? '' }] : [];
    }
    if (u.startsWith('SELECT ID FROM COLLECTIONS WHERE ID = ? AND USER_ID = ?')) {
      const collId = params[0] as string;
      const userId = params[1] as string;
      const coll = this.collections.find((c) => c.id === collId && c.user_id === userId);
      return coll ? [{ id: coll.id }] : [];
    }
    if (u.startsWith('SELECT * FROM SHARES WHERE SLUG = ?')) {
      const slug = params[0] as string;
      const row = this.shares.find((s) => s.slug === slug);
      return row ? [row] : [];
    }
    if (u.startsWith('SELECT * FROM SHARES WHERE ID = ? AND USER_ID = ?')) {
      const id = params[0] as string;
      const userId = params[1] as string;
      const row = this.shares.find((s) => s.id === id && s.user_id === userId);
      return row ? [row] : [];
    }
    if (u.startsWith('SELECT * FROM SHARES WHERE USER_ID = ?')) {
      const userId = params[0] as string;
      return this.shares
        .filter((s) => s.user_id === userId)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    }
    if (u.startsWith('SELECT ID FROM SHARES WHERE SLUG = ?')) {
      const slug = params[0] as string;
      const row = this.shares.find((s) => s.slug === slug);
      return row ? [{ id: row.id }] : [];
    }
    if (u.startsWith('SELECT COUNT(*) AS C FROM SHARES WHERE USER_ID = ?')) {
      const userId = params[0] as string;
      return [{ c: this.shares.filter((s) => s.user_id === userId).length }];
    }
    if (u.startsWith('INSERT INTO SHARES')) {
      const row = parseInsertRow(
        sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')),
        sql.slice(sql.indexOf('VALUES') + 6).replace(/^\s*\(/, '').replace(/\)\s*(RETURNING.*)?$/i, ''),
        params,
      );
      this.shares.push(row);
      return [{ id: row.id }];
    }
    if (u.startsWith('UPDATE SHARES SET VIEW_COUNT = VIEW_COUNT + 1 WHERE SLUG = ?')) {
      const slug = params[0] as string;
      const row = this.shares.find((s) => s.slug === slug);
      if (row) row.view_count = Number(row.view_count ?? 0) + 1;
      return [];
    }
    if (u.startsWith('UPDATE SHARES SET')) {
      // Generic column-update: parse `SET col = ?, col = ? ... WHERE id = ? AND user_id = ?`.
      const id = params[params.length - 2] as string;
      const userId = params[params.length - 1] as string;
      const row = this.shares.find((s) => s.id === id && s.user_id === userId);
      if (!row) return [];
      const setClause = sql.slice(sql.toUpperCase().indexOf('SET') + 3, sql.toUpperCase().indexOf('WHERE')).trim();
      const cols = setClause.split(',').map((c) => c.trim().split('=')[0].trim().toLowerCase());
      for (let i = 0; i < cols.length; i += 1) {
        row[cols[i]] = params[i];
      }
      this.lastChanges = 1;
      return [];
    }
    if (u.startsWith('DELETE FROM SHARES WHERE ID = ? AND USER_ID = ?')) {
      const id = params[0] as string;
      const userId = params[1] as string;
      this.shares = this.shares.filter((s) => !(s.id === id && s.user_id === userId));
      return [];
    }
    // renderShare collection-mode query
    if (
      u.startsWith(
        'SELECT B.ID, B.URL, B.TITLE, B.DESCRIPTION, B.FAVICON_URL, B.NOTE, B.MANUAL_ORDER, B.CREATED_AT FROM COLLECTION_BOOKMARKS CB JOIN BOOKMARKS B',
      )
    ) {
      const collId = params[0] as string;
      const userId = params[1] as string;
      const members = this.collection_bookmarks
        .filter((cb) => cb.collection_id === collId)
        .sort((a, b) => Number(a.position) - Number(b.position));
      return members
        .map((cb) => this.bookmarks.find((b) => b.id === cb.bookmark_id))
        .filter((b): b is MockRow => Boolean(b))
        .filter((b) => b.user_id === userId && b.deleted_at == null && b.is_archived !== 1 && b.is_private !== 1 && !this.hasPrivateTag(b.id, userId))
        .map((b) => ({
          id: b.id, url: b.url, title: b.title, description: b.description ?? null,
          favicon_url: b.favicon_url ?? null, note: b.note ?? null,
          manual_order: b.manual_order ?? 0, created_at: b.created_at,
        }));
    }
    // renderShare tag-mode query (bookmarks b WHERE ...)
    if (
      u.startsWith(
        'SELECT B.ID, B.URL, B.TITLE, B.DESCRIPTION, B.FAVICON_URL, B.NOTE, B.MANUAL_ORDER, B.CREATED_AT FROM BOOKMARKS B WHERE',
      )
    ) {
      const userId = params[0] as string;
      return this.bookmarks
        .filter((b) => b.user_id === userId && b.deleted_at == null && b.is_archived !== 1 && b.is_private !== 1 && !this.hasPrivateTag(b.id, userId))
        .map((b) => ({
          id: b.id, url: b.url, title: b.title, description: b.description ?? null,
          favicon_url: b.favicon_url ?? null, note: b.note ?? null,
          manual_order: b.manual_order ?? 0, created_at: b.created_at,
        }));
    }
    // renderShare tags-by-bookmark lookup
    if (u.startsWith('SELECT BT.BOOKMARK_ID, T.NAME, T.COLOR_INDEX FROM BOOKMARK_TAGS BT JOIN TAGS T')) {
      const ids = params as string[];
      const rows: MockRow[] = [];
      for (const bt of this.bookmark_tags) {
        if (!ids.includes(bt.bookmark_id)) continue;
        const tag = this.tags.find((t) => t.id === bt.tag_id);
        if (tag) rows.push({ bookmark_id: bt.bookmark_id, name: tag.name, color_index: tag.color_index ?? 0 });
      }
      return rows;
    }

    return [];
  }

  private toCollectionRow(c: MockRow): MockRow {
    const kind = (c.kind as string) ?? 'manual';
    const count =
      kind === 'smart'
        ? 0 // live count filled in by the endpoint via countSmartCollection
        : this.collection_bookmarks.filter((cb) => cb.collection_id === c.id).length;
    return {
      id: c.id,
      name: c.name,
      color_index: c.color_index,
      kind,
      query: c.query ?? null,
      created_at: c.created_at,
      updated_at: c.updated_at,
      count,
    };
  }
}

export function makeEnv(overrides: Partial<Record<string, unknown>> = {}): any {
  const db = new MockDb();
  return {
    DB: db,
    JWT_SECRET: 'test-secret-at-least-16-bytes-long',
    ...overrides,
  };
}
