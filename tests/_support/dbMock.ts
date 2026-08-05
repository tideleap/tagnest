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
        return { success: true, meta: {} };
      },
    };
    return stmt;
  }

  async batch(stmts: Statement[]): Promise<void> {
    for (const s of stmts) await s.run();
  }

  exec(sql: string, params: unknown[]): MockRow[] {
    const u = sql.trim().replace(/\s+/g, ' ').toUpperCase();

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
