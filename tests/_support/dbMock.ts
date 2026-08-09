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
  tags: MockRow[] = [];
  private_vault: MockRow[] = [];
  /** Number of rows affected by the most recent mutation statement. */
  lastChanges = 0;

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
      // suggested, failed, created_at, updated_at. `status` is the literal
      // 'queued'; processed/suggested/failed are literal 0.
      const [id, user_id, kind, scope, total, created_at, updated_at] = params as string[];
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
        'SELECT C.ID, C.NAME, C.COLOR_INDEX, C.CREATED_AT, C.UPDATED_AT, COUNT(CB.BOOKMARK_ID) AS COUNT FROM COLLECTIONS C',
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
    if (u.startsWith('INSERT INTO COLLECTIONS')) {
      const [id, user_id, name, color_index, created_at, updated_at] = params as string[];
      this.collections.push({ id, user_id, name, color_index: Number(color_index), created_at, updated_at });
      return [];
    }
    if (u.startsWith('UPDATE COLLECTIONS SET NAME = ?')) {
      const [name, color_index, updated_at, id, user_id] = params as string[];
      const coll = this.collections.find((c) => c.id === id && c.user_id === user_id);
      if (coll) {
        coll.name = name;
        coll.color_index = Number(color_index);
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
    if (u.startsWith('SELECT ID FROM BOOKMARKS WHERE ID = ? AND USER_ID = ? AND DELETED_AT IS NULL')) {
      const [id, userId] = params as string[];
      return this.bookmarks
        .filter((b) => b.id === id && b.user_id === userId && b.deleted_at == null)
        .slice(0, 1)
        .map((b) => ({ id: b.id }));
    }

    // --- bookmark_tags (tag re-link on restore) ----------------------
    if (u.startsWith('DELETE FROM BOOKMARK_TAGS WHERE BOOKMARK_ID = ?')) {
      const [bookmarkId] = params as string[];
      this.bookmark_tags = this.bookmark_tags.filter((bt) => bt.bookmark_id !== bookmarkId);
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

    // --- tags (ensureTags during restore) ----------------------------
    if (u.startsWith('SELECT ID, NAME FROM TAGS WHERE USER_ID = ? AND NAME COLLATE NOCASE IN')) {
      const userId = params[0] as string;
      const names = (params.slice(1) as string[]).map((n) => String(n).toLowerCase());
      return this.tags
        .filter((t) => t.user_id === userId && names.includes(String(t.name).toLowerCase()))
        .map((t) => ({ id: t.id, name: t.name }));
    }
    if (u.startsWith('INSERT INTO TAGS')) {
      const m = u.match(/INSERT INTO TAGS \(([^)]+)\) VALUES \(([^)]*)\)/);
      if (m) {
        this.tags.push(parseInsertRow(m[1], m[2], params));
        return [];
      }
    }

    // --- bookmarks: public single read (loadBookmark) ----------------
    if (
      u.startsWith(
        'SELECT B.ID, B.URL, B.TITLE, B.DESCRIPTION, B.FAVICON_URL, B.COVER_URL, B.SNAPSHOT_KEY, B.SNAPSHOT_KEYS, B.NOTE, B.AI_SUMMARY, B.IS_FAVORITE, B.IS_ARCHIVED, B.VISIT_COUNT, B.LAST_VISITED_AT, B.MANUAL_ORDER, B.CREATED_AT, B.UPDATED_AT, B.DELETED_AT FROM BOOKMARKS B WHERE B.ID = ? AND B.USER_ID = ? AND B.IS_PRIVATE = 0 LIMIT 1',
      )
    ) {
      const [id, userId] = params as string[];
      return this.bookmarks
        .filter(
          (b) => b.id === id && b.user_id === userId && b.is_private !== 1 && b.deleted_at == null,
        )
        .slice(0, 1)
        .map((b) => ({ ...b }));
    }
    // --- bookmarks: public list (runList / listBookmarks) ------------
    if (
      u.startsWith(
        'SELECT B.ID, B.URL, B.TITLE, B.DESCRIPTION, B.FAVICON_URL, B.COVER_URL, B.SNAPSHOT_KEY, B.SNAPSHOT_KEYS, B.NOTE, B.AI_SUMMARY, B.IS_FAVORITE, B.IS_ARCHIVED, B.VISIT_COUNT, B.LAST_VISITED_AT, B.MANUAL_ORDER, B.CREATED_AT, B.UPDATED_AT, B.DELETED_AT FROM BOOKMARKS B WHERE',
      )
    ) {
      const userId = params[0] as string;
      return this.bookmarks
        .filter((b) => b.user_id === userId && b.is_private !== 1 && b.deleted_at == null)
        .map((b) => ({ ...b }));
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
    // --- bookmarks: generic insert (createPrivateBookmark) -----------
    if (u.startsWith('INSERT INTO BOOKMARKS')) {
      const m = u.match(/INSERT INTO BOOKMARKS \(([^)]+)\) VALUES \(([^)]*)\)/);
      if (m) {
        this.bookmarks.push(parseInsertRow(m[1], m[2], params));
        return [];
      }
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

    return [];
  }

  private toCollectionRow(c: MockRow): MockRow {
    return {
      id: c.id,
      name: c.name,
      color_index: c.color_index,
      created_at: c.created_at,
      updated_at: c.updated_at,
      count: this.collection_bookmarks.filter((cb) => cb.collection_id === c.id).length,
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
