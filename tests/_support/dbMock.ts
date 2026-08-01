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

  prepare(sql: string): Statement {
    const self = this;
    const stmt: Statement = {
      sql,
      params: [],
      bind(...params: unknown[]) {
        this.params = params;
        return this;
      },
      async first<T = MockRow>(): Promise<T | null> {
        const rows = self.exec(this.sql, this.params);
        return (rows[0] as T) ?? null;
      },
      async all<T = MockRow>(): Promise<{ results: T[] }> {
        return { results: self.exec(this.sql, this.params) as T[] };
      },
      async run() {
        self.exec(this.sql, this.params);
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

    return [];
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
