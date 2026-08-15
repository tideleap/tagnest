import { describe, expect, it } from 'vitest';
import type { Env } from '../functions/_lib/env';
import { onRequestGet as healthGet } from '../functions/api/bookmarks/health';
import { onRequestPost as probePost } from '../functions/api/bookmarks/health/probe';
import { classifyStatus } from '../functions/_lib/healthcheck';

const USER = 'u1';

/**
 * Small, honest D1 mock for the health report. It pattern-matches the handful
 * of statements buildHealthReport issues and returns canned rows, so the test
 * exercises the real grouping/shaping/scoring logic without a SQL engine.
 */
function makeHealthDb(opts: {
  total: number;
  dupKeys?: { k: string; c: number }[];
  members?: { k: string; id: string; title: string; url: string; created_at: string }[];
  orphans?: { id: string; name: string }[];
}) {
  return {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return this;
        },
        async first() {
          if (/COUNT\(\*\) AS c/.test(sql)) return { c: opts.total };
          return null;
        },
        async all() {
          if (/GROUP BY b\.url_key HAVING/.test(sql)) {
            return { results: opts.dupKeys ?? [] };
          }
          if (/b\.url_key IN/.test(sql)) {
            return { results: opts.members ?? [] };
          }
          if (/NOT EXISTS \(SELECT 1 FROM bookmark_tags/.test(sql)) {
            return { results: opts.orphans ?? [] };
          }
          return { results: [] };
        },
      };
    },
  };
}

function makeCtx(env: Env, body?: unknown) {
  const init: RequestInit = { method: body === undefined ? 'GET' : 'POST' };
  if (body !== undefined) init.body = JSON.stringify(body);
  return {
    request: new Request('https://tagnest.test/api/bookmarks/health', init),
    env,
    data: { userId: USER },
    params: {},
  } as any;
}

function makeEnv(db: unknown): Env {
  return { DB: db } as unknown as Env;
}

describe('classifyStatus', () => {
  it('maps 404/410 to dead', () => {
    expect(classifyStatus(404)).toBe('dead');
    expect(classifyStatus(410)).toBe('dead');
  });
  it('maps 401/403 to auth (login wall, not dead)', () => {
    expect(classifyStatus(401)).toBe('auth');
    expect(classifyStatus(403)).toBe('auth');
  });
  it('maps 2xx/3xx to ok', () => {
    expect(classifyStatus(200)).toBe('ok');
    expect(classifyStatus(301)).toBe('ok');
  });
  it('maps other 4xx/5xx to suspicious, never dead', () => {
    expect(classifyStatus(429)).toBe('suspicious');
    expect(classifyStatus(500)).toBe('suspicious');
    expect(classifyStatus(503)).toBe('suspicious');
  });
});

describe('GET /api/bookmarks/health', () => {
  it('reports a clean library with score 100', async () => {
    const env = makeEnv(makeHealthDb({ total: 5 }));
    const res = await healthGet(makeCtx(env));
    const body = (await res.json()) as any;
    expect(body.liveTotal).toBe(5);
    expect(body.duplicateGroups).toEqual([]);
    expect(body.orphanTags).toEqual([]);
    expect(body.score).toBe(100);
  });

  it('groups duplicates and counts the redundant extras', async () => {
    const env = makeEnv(
      makeHealthDb({
        total: 4,
        dupKeys: [{ k: 'example.com/a', c: 3 }],
        members: [
          { k: 'example.com/a', id: 'b1', title: 'A1', url: 'https://example.com/a', created_at: '2026-01-01' },
          { k: 'example.com/a', id: 'b2', title: 'A2', url: 'https://example.com/a?x=1', created_at: '2026-01-02' },
          { k: 'example.com/a', id: 'b3', title: 'A3', url: 'http://example.com/a', created_at: '2026-01-03' },
        ],
      }),
    );
    const res = await healthGet(makeCtx(env));
    const body = (await res.json()) as any;
    expect(body.duplicateGroups).toHaveLength(1);
    expect(body.duplicateGroups[0].count).toBe(3);
    expect(body.duplicateGroups[0].bookmarks).toHaveLength(3);
    expect(body.duplicateExtra).toBe(2); // 3 copies → 2 redundant
  });

  it('drops a duplicate group whose members raced away (<2 rows)', async () => {
    const env = makeEnv(
      makeHealthDb({
        total: 2,
        dupKeys: [{ k: 'gone.com', c: 2 }],
        members: [{ k: 'gone.com', id: 'only', title: 'X', url: 'https://gone.com', created_at: '2026-01-01' }],
      }),
    );
    const res = await healthGet(makeCtx(env));
    const body = (await res.json()) as any;
    expect(body.duplicateGroups).toEqual([]);
    expect(body.duplicateExtra).toBe(0);
  });

  it('lists orphan tags and lowers the score', async () => {
    const env = makeEnv(
      makeHealthDb({
        total: 10,
        orphans: [
          { id: 't1', name: 'unused' },
          { id: 't2', name: 'stale' },
        ],
      }),
    );
    const res = await healthGet(makeCtx(env));
    const body = (await res.json()) as any;
    expect(body.orphanTags).toHaveLength(2);
    // 2 issues / 10 live → 100 * (1 - 0.2) = 80
    expect(body.score).toBe(80);
  });

  it('scores an empty library as 100 (no division by zero)', async () => {
    const env = makeEnv(makeHealthDb({ total: 0 }));
    const res = await healthGet(makeCtx(env));
    const body = (await res.json()) as any;
    expect(body.score).toBe(100);
  });
});

describe('POST /api/bookmarks/health/probe', () => {
  it('rejects an empty id list with 400', async () => {
    const env = makeEnv(makeHealthDb({ total: 0 }));
    await expect(probePost(makeCtx(env, { ids: [] }))).rejects.toMatchObject({ status: 400 });
    await expect(probePost(makeCtx(env, {}))).rejects.toMatchObject({ status: 400 });
  });
});
