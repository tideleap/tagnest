import { describe, expect, it } from 'vitest';
import { attachTags } from '../functions/_lib/db';
import type { Env } from '../functions/_lib/env';

/**
 * Regression tests for defects found during the systematic code review.
 */

describe('attachTags — D1 100-param ceiling', () => {
  /**
   * Feeds a page of bookmarks whose tag graph would previously overflow a
   * single `IN (...)` count query (>99 distinct tag ids + user_id = 100+).
   * The mock counts bound params on every query and asserts each stays within
   * the D1 limit, even for 130 distinct tags across 100 bookmarks.
   */
  it('chunks the tag-count query so no statement exceeds 100 bound params', async () => {
    let maxParams = 0;
    let callCount = 0;

    // Build 100 bookmarks, each with a distinct tag (130 tags total) so the
    // attached-link query joins are distinct and the tag list is large.
    const bookmarkIds = Array.from({ length: 100 }, (_, i) => `bm-${i}`);
    const tagNames = Array.from({ length: 130 }, (_, i) => `tag-${i}`);

    // Map bookmark -> its tags (one distinct tag each, plus give the last few
    // bookmarks a mix so unique tag ids exceed 99).
    const bm2tags: Record<string, string[]> = {};
    bookmarkIds.forEach((id, idx) => {
      bm2tags[id] = [tagNames[idx % tagNames.length]];
      // give bookmarks 95..99 each an extra unique tag to inflate distinct count
      if (idx >= 95) bm2tags[id].push(tagNames[idx + 1]);
    });

    // Fake D1 that understands the two query shapes attachTags issues and
    // counts bound params per call. `prepare`/`bind` are synchronous (D1
    // contract); only `all()` is async.
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            maxParams = Math.max(maxParams, args.length);
            callCount += 1;
            // Heuristic: the FIRST query is the link join (`bookmark_id IN`),
            // the SECOND+ are the per-tag count queries (`bt.tag_id IN`).
            if (sql.includes('b.id = bt.bookmark_id')) {
              // count query
              const tagIds = args.slice(1) as string[];
              const rows = tagIds.map((t) => ({ tag_id: t, c: 1 }));
              return {
                async all() {
                  return { results: rows };
                },
              };
            }
            // link query
            const bmIds = args as string[];
            const results = bmIds.flatMap((id) =>
              (bm2tags[id] ?? []).map((tagName) => ({
                bookmark_id: id,
                id: `tagId-${tagName}`,
                name: tagName,
                color_index: 0,
                parent_id: null,
                sort_order: 0,
                created_at: '',
              })),
            );
            return {
              async all() {
                return { results };
              },
            };
          },
        };
      },
    } as unknown as Env['DB'];

    const tagMap = await attachTags({ DB: db } as unknown as Env, 'u-user', bookmarkIds);

    // Every bound-param count stayed within D1's ceiling.
    expect(maxParams).toBeLessThanOrEqual(100);
    // The count query was chunked into >1 statements (each ≤99 tag ids).
    expect(callCount).toBeGreaterThan(1);
    // Every bookmark mapped to its tags.
    expect(tagMap.size).toBe(bookmarkIds.length);
    expect(tagMap.get('bm-0')?.map((t) => t.name)).toEqual(['tag-0']);
  });
});

describe('attachTags — empty input', () => {
  it('returns an empty map without touching the DB', async () => {
    const db = {
      prepare: () => {
        throw new Error('should not be called');
      },
    } as unknown as Env['DB'];
    const result = await attachTags({ DB: db } as unknown as Env, 'u', []);
    expect(result.size).toBe(0);
  });
});
