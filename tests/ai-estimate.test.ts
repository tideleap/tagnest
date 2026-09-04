import { describe, expect, it } from 'vitest';
import type { Env } from '../functions/_lib/env';
import type { AiJobEstimate } from '../shared/types';
import { estimateJob, representativeOutput, tokensFromChars } from '../functions/_lib/ai/estimate';
import { BATCH_SIZE } from '../functions/_lib/ai/prompt';
import { MAX_JOB_ITEMS, RUN_CHUNK_LEGACY } from '../functions/_lib/ai/store';
import { onRequestGet as estimateHandler } from '../functions/api/ai/jobs/estimate';
import { createAiDb, type AiDbState, type BookmarkRow } from './helpers/aiDb';
import { MockDb, makeEnv } from './_support/dbMock';

/**
 * Cost forecast tests (plan A1). The forecast must be free — pure arithmetic
 * plus one measured sample prompt — and it must err toward OVERestimating, so
 * the assertions check shape and direction rather than exact token counts.
 */

function makeBookmarks(n: number, userId = 'u1'): BookmarkRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `b${i + 1}`,
    user_id: userId,
    url: `https://example-${i + 1}.com/article`,
    title: `示例书签 ${i + 1}：关于前端工程化的实践笔记`,
    description: '这是一段用于测试成本预估的书签描述。',
    deleted_at: null,
    ai_summary: null,
    created_at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
  }));
}

function aiEnv(seed?: Partial<AiDbState>): { env: Env; state: AiDbState } {
  const { db, state } = createAiDb(seed);
  return { env: { DB: db as never } as unknown as Env, state };
}

describe('tokensFromChars — character heuristic', () => {
  it('converts at two characters per token, rounding up', () => {
    expect(tokensFromChars(0)).toBe(0);
    expect(tokensFromChars(1)).toBe(1);
    expect(tokensFromChars(4)).toBe(2);
    expect(tokensFromChars(5)).toBe(3);
  });

  it('never returns a negative estimate', () => {
    expect(tokensFromChars(-10)).toBe(0);
  });
});

describe('representativeOutput — worst-case batch output', () => {
  it('builds parseable JSON with maxTags tags per item', () => {
    const parsed = JSON.parse(representativeOutput(3, 4, false)) as {
      results: Array<{ tags: unknown[]; summary?: string }>;
    };
    expect(parsed.results).toHaveLength(3);
    for (const item of parsed.results) {
      expect(item.tags).toHaveLength(4);
      expect(item.summary).toBeUndefined();
    }
  });

  it('includes a summary when summarisation is on', () => {
    const parsed = JSON.parse(representativeOutput(1, 2, true)) as {
      results: Array<{ summary?: string }>;
    };
    expect(typeof parsed.results[0].summary).toBe('string');
  });

  it('grows with batch size and tag count', () => {
    const small = representativeOutput(1, 1, false).length;
    const big = representativeOutput(10, 8, true).length;
    expect(big).toBeGreaterThan(small);
  });
});

describe('estimateJob — store level', () => {
  it('reports zero cost for an empty scope', async () => {
    const { env } = aiEnv();
    const est = await estimateJob(env, 'u1', 'untagged');
    expect(est).toMatchObject({
      bookmarks: 0,
      batches: 0,
      chunks: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      capped: false,
    });
  });

  it('derives batches and chunks from the resolved scope', async () => {
    const { env } = aiEnv({ bookmarks: makeBookmarks(25) });
    const est = await estimateJob(env, 'u1', 'untagged');
    expect(est.bookmarks).toBe(25);
    expect(est.batches).toBe(Math.ceil(25 / BATCH_SIZE));
    expect(est.chunks).toBe(Math.ceil(25 / RUN_CHUNK_LEGACY));
    expect(est.estimatedInputTokens).toBeGreaterThan(0);
    expect(est.estimatedOutputTokens).toBeGreaterThan(0);
    expect(est.capped).toBe(false);
  });

  it('counts only untagged bookmarks for the untagged target', async () => {
    const { env } = aiEnv({
      bookmarks: makeBookmarks(3),
      tags: [
        { id: 't1', user_id: 'u1', name: '已有标签', color_index: 0, parent_id: null, sort_order: 0, created_at: '2026' },
      ],
      bookmark_tags: [
        { bookmark_id: 'b1', tag_id: 't1', source: 'user', confidence: null, created_at: '2026' },
      ],
    });
    const est = await estimateJob(env, 'u1', 'untagged');
    expect(est.bookmarks).toBe(2);
  });

  it('flags modelReady=false when nothing is configured', async () => {
    const { env } = aiEnv({ bookmarks: makeBookmarks(1) });
    const est = await estimateJob(env, 'u1', 'untagged');
    expect(est.modelReady).toBe(false);
  });

  it('flags modelReady when provider, model and key are configured', async () => {
    const { env } = aiEnv({
      bookmarks: makeBookmarks(1),
      ai_settings: [
        {
          user_id: 'u1',
          provider: 'openai',
          base_url: null,
          model: 'gpt-4o-mini',
          // Legacy plaintext key: decryptField passes it through unchanged.
          api_key_encrypted: 'sk-legacy-test-key',
          auto_tag: 1,
          auto_summarize: 0,
          auto_apply_threshold: 1,
          heuristics_enabled: 0,
          max_tags: 4,
        },
      ],
    });
    const est = await estimateJob(env, 'u1', 'untagged');
    expect(est.modelReady).toBe(true);
  });

  it('flags capped when the scope hits the per-run ceiling', async () => {
    const { env } = aiEnv({ bookmarks: makeBookmarks(MAX_JOB_ITEMS) });
    const est = await estimateJob(env, 'u1', 'all');
    expect(est.bookmarks).toBe(MAX_JOB_ITEMS);
    expect(est.capped).toBe(true);
  });

  it('never flags capped for explicit ids', async () => {
    const { env } = aiEnv({ bookmarks: makeBookmarks(2) });
    const est = await estimateJob(env, 'u1', 'ids', ['b1', 'b2']);
    expect(est.bookmarks).toBe(2);
    expect(est.capped).toBe(false);
  });

  it('forecasts call count, retry ceiling and duration (single pass)', async () => {
    const { env } = aiEnv({ bookmarks: makeBookmarks(25) });
    const est = await estimateJob(env, 'u1', 'untagged');
    const batches = Math.ceil(25 / BATCH_SIZE);
    // Single pass: one tagging call per batch.
    expect(est.estimatedCalls).toBe(batches);
    expect(est.maxModelCalls).toBeGreaterThan(est.estimatedCalls);
    expect(est.maxModelCalls % est.estimatedCalls).toBe(0);
    expect(est.estimatedSeconds).toBeGreaterThan(0);
  });

  it('doubles the call forecast when two-pass is enabled', async () => {
    const settings = {
      user_id: 'u1',
      provider: 'openai',
      base_url: null,
      model: 'gpt-4o-mini',
      api_key_encrypted: 'sk-test',
      auto_tag: 1,
      auto_summarize: 0,
      auto_apply_threshold: 1,
      heuristics_enabled: 0,
      max_tags: 4,
      fetch_content: 1,
      two_pass: 1,
    };
    const { env } = aiEnv({ bookmarks: makeBookmarks(25), ai_settings: [settings] });
    const est = await estimateJob(env, 'u1', 'untagged');
    const batches = Math.ceil(25 / BATCH_SIZE);
    // Two-pass: coarse + fine = 2 calls per batch.
    expect(est.estimatedCalls).toBe(batches * 2);
  });
});

/* ------------------------------------------------------------------ *
 * GET /api/ai/jobs/estimate
 * ------------------------------------------------------------------ */

function estimateCtx(env: Env, userId: string, query = '') {
  return {
    request: new Request(`https://tagnest.test/api/ai/jobs/estimate${query}`),
    env,
    data: { userId },
    params: {},
  } as unknown as Parameters<typeof estimateHandler>[0];
}

function seedBookmark(db: MockDb, id: string, createdAt: string, userId = 'u1'): void {
  db.bookmarks.push({
    id,
    user_id: userId,
    url: `https://${id}.example.com/article`,
    title: `书签 ${id}`,
    description: null,
    deleted_at: null,
    is_private: 0,
    created_at: createdAt,
  });
}

describe('GET /api/ai/jobs/estimate', () => {
  it('returns a forecast for the default untagged scope', async () => {
    const env = makeEnv({ LOG_LEVEL: 'error' });
    const db = env.DB as MockDb;
    seedBookmark(db, 'b1', '2026-01-01T00:00:00Z');
    seedBookmark(db, 'b2', '2026-01-02T00:00:00Z');

    const res = await estimateHandler(estimateCtx(env, 'u1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { estimate: AiJobEstimate };
    expect(body.estimate.bookmarks).toBe(2);
    expect(body.estimate.batches).toBe(1);
    expect(body.estimate.chunks).toBe(1);
    expect(body.estimate.estimatedInputTokens).toBeGreaterThan(0);
    expect(body.estimate.modelReady).toBe(false);
  });

  it('rejects an invalid target', async () => {
    const env = makeEnv({ LOG_LEVEL: 'error' });
    await expect(estimateHandler(estimateCtx(env, 'u1', '?target=bogus'))).rejects.toMatchObject({
      status: 400,
    });
  });

  it('requires ids when target=ids', async () => {
    const env = makeEnv({ LOG_LEVEL: 'error' });
    await expect(estimateHandler(estimateCtx(env, 'u1', '?target=ids'))).rejects.toMatchObject({
      status: 400,
    });
  });

  it('estimates an explicit id set, deduplicated', async () => {
    const env = makeEnv({ LOG_LEVEL: 'error' });
    const db = env.DB as MockDb;
    seedBookmark(db, 'b1', '2026-01-01T00:00:00Z');
    seedBookmark(db, 'b2', '2026-01-02T00:00:00Z');
    seedBookmark(db, 'b3', '2026-01-03T00:00:00Z');

    const res = await estimateHandler(estimateCtx(env, 'u1', '?target=ids&ids=b1,b3,b3'));
    const body = (await res.json()) as { estimate: AiJobEstimate };
    expect(body.estimate.bookmarks).toBe(2);
    expect(body.estimate.target).toBe('ids');
  });

  it('excludes vaulted bookmarks from the scope', async () => {
    const env = makeEnv({ LOG_LEVEL: 'error' });
    const db = env.DB as MockDb;
    seedBookmark(db, 'b1', '2026-01-01T00:00:00Z');
    seedBookmark(db, 'b2', '2026-01-02T00:00:00Z');
    const hidden = db.bookmarks.find((b) => b.id === 'b2');
    if (hidden) hidden.is_private = 1;

    const res = await estimateHandler(estimateCtx(env, 'u1'));
    const body = (await res.json()) as { estimate: AiJobEstimate };
    expect(body.estimate.bookmarks).toBe(1);
  });
});
