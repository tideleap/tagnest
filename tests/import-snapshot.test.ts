// tests/import-snapshot.test.ts
//
// Y4: a TagNest→TagNest migration package must carry snapshot references.
// These tests pin both ends of that promise:
//   1. `parseJson` reads `snapshotKey` / `snapshotKeys` off a TagNest export.
//   2. the import `commit` handler writes them back into the bookmarks row.

import { describe, expect, it, vi } from 'vitest';

// Stub the two db helpers commit relies on so the test exercises the INSERT
// shape directly instead of dragging the real D1 tag machinery into the mock.
vi.mock('../functions/_lib/db', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    ensureTags: vi.fn(async () => ({ ids: [] })),
    queryInChunks: vi.fn(async () => []),
  };
});

import { parseJson } from '../functions/_lib/import-parsers';
import { onRequestPost } from '../functions/api/import/commit';

describe('import parseJson snapshot references (Y4)', () => {
  it('reads snapshotKey and snapshotKeys from a TagNest export envelope', () => {
    const json = JSON.stringify({
      application: 'TagNest',
      version: 1,
      exportedAt: '2024-01-01T00:00:00.000Z',
      bookmarks: [
        {
          url: 'https://snap.example/a',
          title: 'A',
          isFavorite: false,
          isArchived: false,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          snapshotKey: 'snap/latest-a',
          snapshotKeys: ['snap/old-a', 'snap/latest-a'],
        },
        {
          url: 'https://snap.example/b',
          title: 'B',
          isFavorite: false,
          isArchived: false,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          snapshotKeys: ['snap/only-b'],
        },
        {
          url: 'https://snap.example/c',
          title: 'C',
          isFavorite: false,
          isArchived: false,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      ],
    });
    const { items } = parseJson(json);
    expect(items).toHaveLength(3);
    expect(items[0].snapshotKey).toBe('snap/latest-a');
    expect(items[0].snapshotKeys).toEqual(['snap/old-a', 'snap/latest-a']);
    expect(items[1].snapshotKey).toBeNull();
    expect(items[1].snapshotKeys).toEqual(['snap/only-b']);
    // No-snapshot entries still carry an explicit null / empty array so the
    // round-trip (export → import) is symmetric with the export side.
    expect(items[2].snapshotKey).toBeNull();
    expect(items[2].snapshotKeys).toEqual([]);
  });

  it('tolerates a string-encoded snapshot_keys array and ignores junk', () => {
    const json = JSON.stringify([
      { url: 'https://x.example/1', title: 'X', snapshot_keys: '["k1","k2"]', snapshot_key: 'k2' },
      { url: 'https://x.example/2', title: 'Y', snapshot_keys: 'not-json' },
    ]);
    const { items } = parseJson(json);
    expect(items[0].snapshotKeys).toEqual(['k1', 'k2']);
    expect(items[0].snapshotKey).toBe('k2');
    expect(items[1].snapshotKeys).toEqual([]);
    expect(items[1].snapshotKey).toBeNull();
  });
});

describe('import commit writes snapshot references (Y4)', () => {
  function makeDb() {
    const captured: Array<{ sql: string; binds: unknown[] }> = [];
    return {
      captured,
      prepare(sql: string) {
        return {
          bind(...binds: unknown[]) {
            return {
              sql: sql.trim().replace(/\s+/g, ' '),
              binds,
              first: async () => {
                if (/FROM import_staging/.test(sql)) {
                  return {
                    payload: JSON.stringify([
                      {
                        url: 'https://snap.example/a',
                        title: 'A',
                        folderPath: [],
                        addedAt: null,
                        tagNames: [],
                        snapshotKey: 'snap/latest-a',
                        snapshotKeys: ['snap/old-a', 'snap/latest-a'],
                      },
                    ]),
                  };
                }
                if (/SELECT COUNT\(\*\)/.test(sql)) return { c: 0 };
                return null;
              },
              all: async () => ({ results: [] }),
              run: async () => ({ success: true, meta: {} }),
            };
          },
        };
      },
      batch(stmts: Array<{ sql: string; binds: unknown[] }>) {
        for (const s of stmts) captured.push({ sql: s.sql, binds: s.binds });
        return Promise.resolve(stmts.map(() => ({ success: true, meta: {} })));
      },
    };
  }

  it('persists snapshot_key and snapshot_keys into the new bookmark row', async () => {
    const db = makeDb();
    const request = new Request('https://tagnest.local/api/import/commit', {
      method: 'POST',
      body: JSON.stringify({ token: 'tok', foldersAsTags: true, skipDuplicates: true }),
    });
    const ctx = {
      request,
      env: { DB: db },
      data: { user: {}, userId: 'u_test' },
      waitUntil: () => {},
    } as unknown as Parameters<typeof onRequestPost>[0];

    const res = await onRequestPost(ctx);
    await res.text(); // drain the NDJSON stream so the writer actually runs

    const insert = db.captured.find((s) => /INSERT OR IGNORE INTO bookmarks/.test(s.sql));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain('snapshot_key');
    expect(insert!.sql).toContain('snapshot_keys');
    // The latest key lands in snapshot_key; the whole history is stored as JSON.
    expect(insert!.binds).toContain('snap/latest-a');
    expect(insert!.binds).toContain(JSON.stringify(['snap/old-a', 'snap/latest-a']));
  });
});
