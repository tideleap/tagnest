/**
 * P0-7 safety boundary (PRD-TAG-QUALITY-2026-08-30):
 * governance only reshapes THIS run's suggestions — it must never delete,
 * rename, or merge the user's existing tags.
 *
 * Two layers of proof:
 *   1. End-to-end: run the real suggest pipeline (model mocked) over a batch
 *      that produces fragment singletons, persist via saveSuggestions, and
 *      assert the `tags` table is byte-identical before/after while
 *      `tag_suggestions` carries the governed rows.
 *   2. Source audit: governance.ts is a pure module — it must not reference a
 *      DB handle or any tags-table write verb. This locks the boundary so a
 *      future "helpful" DB call in governance fails CI.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../functions/_lib/env';
import { suggestForBookmarks } from '../functions/_lib/ai/engine';
import { saveSuggestions } from '../functions/_lib/ai/store';
import { buildVocabulary } from '../functions/_lib/ai/taxonomy';
import type { AiConfig, LocalConfig, Vocabulary } from '../functions/_lib/ai/types';
import { callProvider } from '../functions/_lib/ai/providers';
import { createAiDb, type AiDbState, type TagRow } from './helpers/aiDb';

vi.mock('../functions/_lib/ai/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../functions/_lib/ai/providers')>();
  return { ...actual, callProvider: vi.fn() };
});

const mockedCall = vi.mocked(callProvider);

const here = dirname(fileURLToPath(import.meta.url));

const modelConfig: AiConfig = {
  provider: 'openai',
  baseUrl: null,
  model: 'gpt-4o-mini',
  apiKey: 'sk-test',
  autoTag: true,
  autoSummarize: false,
  autoApplyThreshold: 1,
  maxTags: 4,
};

const local: LocalConfig = { autoApplyThreshold: 1, maxTags: 4 };

beforeEach(() => mockedCall.mockReset());
afterEach(() => mockedCall.mockReset());

function makeEnv(seed?: Partial<AiDbState>): { env: Env; state: AiDbState } {
  const { db, state } = createAiDb(seed);
  return { env: { DB: db as never }, state };
}

describe('P0-7 — governance never mutates the existing tags table', () => {
  it('end-to-end: suggest + save leaves `tags` byte-identical', async () => {
    // Seed two pre-existing user tags that the batch will reference.
    const seedTags: TagRow[] = [
      { id: 'fe', user_id: 'u1', name: '前端', color_index: 0, parent_id: null, sort_order: 0, created_at: '2024' },
      { id: 'db', user_id: 'u1', name: '数据库', color_index: 1, parent_id: null, sort_order: 1, created_at: '2024' },
    ];
    const bookmarks = Array.from({ length: 6 }, (_, i) => ({
      id: `b${i + 1}`,
      user_id: 'u1',
      url: `https://site${i}.example.com/page`,
      title: `Page ${i}`,
      description: null,
      deleted_at: null,
      ai_summary: null,
      created_at: '2024',
    }));
    const { env, state } = makeEnv({ tags: seedTags, bookmarks });

    // Snapshot the tags table before the pipeline runs.
    const before = JSON.stringify(state.tags);

    // Model proposes: 4 unique one-off fragments + a shared tag + an existing tag.
    const json = JSON.stringify({
      results: [
        { i: 1, tags: [{ name: '孤词甲', confidence: 0.9, reason: 'r' }] },
        { i: 2, tags: [{ name: '孤词乙', confidence: 0.9, reason: 'r' }] },
        { i: 3, tags: [{ name: '孤词丙', confidence: 0.9, reason: 'r' }] },
        { i: 4, tags: [{ name: '孤词丁', confidence: 0.9, reason: 'r' }] },
        { i: 5, tags: [{ name: '共享主题', confidence: 0.8, reason: 'r' }] },
        { i: 6, tags: [{ name: '前端', confidence: 0.8, reason: 'r' }] },
      ],
    });
    mockedCall.mockResolvedValueOnce({ ok: true, text: json });

    const vocab: Vocabulary = buildVocabulary(
      seedTags.map((t) => ({ id: t.id, name: t.name, aliases: [], count: 10 })),
    );
    const out = await suggestForBookmarks(
      bookmarks.map((b) => ({ id: b.id, url: b.url, title: b.title })),
      { vocab, config: modelConfig, local },
    );

    // Governance ran and dropped the singletons from the suggestion set.
    expect(out.governance).not.toBeNull();
    const suggestedNames = out.results.flatMap((r) => r.tags.map((t) => t.name));
    for (const frag of ['孤词甲', '孤词乙', '孤词丙', '孤词丁']) {
      expect(suggestedNames).not.toContain(frag);
    }

    // Persist the governed suggestions.
    await saveSuggestions(env, 'u1', 'j1', out.results);

    // THE SAFETY ASSERTION: the tags table is untouched — same rows, same
    // content. Governance only wrote to tag_suggestions.
    expect(JSON.stringify(state.tags)).toBe(before);
    expect(state.tags).toHaveLength(2);
    expect(state.tags.map((t) => t.name).sort()).toEqual(['前端', '数据库']);

    // And the suggestion carrier did receive rows (governed, no fragments).
    expect(state.tag_suggestions.length).toBeGreaterThan(0);
    for (const s of state.tag_suggestions) {
      expect(['孤词甲', '孤词乙', '孤词丙', '孤词丁']).not.toContain(s.tag_name);
    }
  });

  it('source audit: governance.ts holds no DB handle and no tags-table write', () => {
    const src = readFileSync(
      resolve(here, '../functions/_lib/ai/governance.ts'),
      'utf8',
    );
    // No database access of any kind.
    expect(src).not.toMatch(/env\.DB/);
    expect(src).not.toMatch(/\.prepare\s*\(/);
    expect(src).not.toMatch(/D1Database|D1PreparedStatement/);
    // No tags-table mutation verbs.
    expect(src).not.toMatch(/DELETE\s+FROM\s+tags/i);
    expect(src).not.toMatch(/UPDATE\s+tags/i);
    expect(src).not.toMatch(/INSERT\s+INTO\s+tags/i);
  });

  it('source audit: the suggest/save path never issues a tags-table write', () => {
    // saveSuggestions is the only writer in the suggest pipeline; it must touch
    // tag_suggestions / bookmarks only — never the tags table. Tag creation is
    // reserved for the user's explicit accept path (decideSuggestions →
    // ensureTags).
    const storeSrc = readFileSync(
      resolve(here, '../functions/_lib/ai/store.ts'),
      'utf8',
    );
    const saveFn = storeSrc.slice(
      storeSrc.indexOf('export async function saveSuggestions'),
      storeSrc.indexOf('export async function listPendingSuggestions'),
    );
    expect(saveFn).not.toMatch(/DELETE\s+FROM\s+tags\b/i);
    expect(saveFn).not.toMatch(/UPDATE\s+tags\b/i);
    expect(saveFn).not.toMatch(/INSERT\s+INTO\s+tags\b/i);
  });
});
