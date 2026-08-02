// tests/import-preview-endpoint.test.ts
//
// End-to-end test of the import *preview* request handler — the single most
// failure-prone path in the import feature. It exercises the real
// `onRequestPost` from `functions/api/import/preview.ts` with a genuine
// multipart FormData request and an in-memory D1 mock, so we can reason about
// exactly which conditions surface which user-facing error code.
//
// Why this matters: production keeps turning every unknown exception into
// "无法读取该文件" (import_unreadable) because `handle()` throws a non-ApiException
// somewhere. This file pins the three distinct outcomes — success, parse
// failure, and unreadable — so a regression in any of them fails loudly.

import { describe, expect, it } from 'vitest';
import { onRequestPost } from '../functions/api/import/preview';

// ------------------------------------------------------------------ *
// Minimal D1 mock that understands the exact statements preview issues.
// ------------------------------------------------------------------ *
function makeDb(opts: { failRead?: boolean } = {}) {
  const rows: Array<{ url_key: string }> = [];
  const sqlLog: string[] = [];
  return {
    log: sqlLog,
    prepare(sql: string) {
      const u = sql.trim().replace(/\s+/g, ' ').toUpperCase();
      sqlLog.push(u);
      return {
        bind: () => makeStmt(u),
      };
    },
  } as unknown as import('@cloudflare/workers-types').D1Database & {
    log: string[];
  };

  function makeStmt(u: string) {
    return {
      first: async () => (u.startsWith('SELECT URL_KEY FROM BOOKMARKS') ? null : null),
      all: async () => {
        if (u.startsWith('SELECT URL_KEY FROM BOOKMARKS') && opts.failRead) {
          throw new Error('D1_ERROR: connection reset by peer');
        }
        return { results: rows };
      },
      run: async () => ({ success: true, meta: {} }),
    };
  }
}

function makeCtx(opts: { db?: ReturnType<typeof makeDb>; html?: string; fileName?: string } = {}) {
  const db = opts.db ?? makeDb();
  const html = opts.html ?? '<DL><p><DT><A HREF="https://example.com/page" ADD_DATE="1620000001">Example</A></DL>';
  const file = new File([html], opts.fileName ?? 'bookmarks.html', { type: 'text/html' });
  const form = new FormData();
  form.append('file', file);

  const request = new Request('https://tagnest.local/api/import/preview', {
    method: 'POST',
    body: form,
  });

  return {
    request,
    env: { DB: db },
    data: { user: {}, userId: 'u_test' },
    waitUntil: () => {},
  } as unknown as Parameters<typeof onRequestPost>[0];
}

describe('import preview endpoint (real handler + multipart)', () => {
  it('succeeds for a clean UTF-8 Netscape export', async () => {
    const ctx = makeCtx();
    const res = await onRequestPost(ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.source).toBe('html');
    expect(body.sample[0].url).toBe('https://example.com/page');
    // staging insert happened (idempotent INSERT OR IGNORE INTO import_staging)
    const d1 = ctx.env.DB as { log: string[] };
    expect(d1.log.some((s) => s.startsWith('INSERT INTO IMPORT_STAGING'))).toBe(true);
  });

  it('throws ApiException import_empty_parse when nothing parses', async () => {
    const ctx = makeCtx({ html: '<html><body>no bookmarks here</body></html>' });
    await expect(onRequestPost(ctx)).rejects.toMatchObject({ code: 'import_empty_parse' });
  });

  it('maps a D1 read error to a server-retriable code, never a raw 500 or "bad file"', async () => {
    const ctx = makeCtx({ db: makeDb({ failRead: true }) });
    await expect(onRequestPost(ctx)).rejects.toMatchObject({ code: 'import_db_unavailable' });
  });

  it('parses a JSON export through the same decode->parse path', async () => {
    const json = JSON.stringify([{ uri: 'https://j.com/1', name: 'J1' }]);
    const form = new FormData();
    form.append('file', new File([json], 'backup.json', { type: 'application/json' }));
    const ctx = makeCtx();
    ctx.request = new Request('https://tagnest.local/api/import/preview', {
      method: 'POST',
      body: form,
    });
    const res = await onRequestPost(ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('json');
    expect(body.sample[0].title).toBe('J1');
  });
});
