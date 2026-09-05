import { describe, expect, it } from 'vitest';
import type { Env } from '../functions/_lib/env';
import type { CategorizeResult } from '../functions/_lib/ai/engine';
import {
  assignPrimaryCategory,
  autoApplyCategories,
  decideCategorySuggestions,
  deriveCategoryPath,
  ensureCategoryPath,
  loadCategoryTree,
  resolveCategorizeScope,
  saveCategorySuggestions,
  undoCategorizeJob,
} from '../functions/_lib/ai/store';
import {
  createAiDb,
  type AiDbState,
  type BookmarkRow,
  type PrimaryCategoryRow,
  type SuggestionRow,
  type TagRow,
} from './helpers/aiDb';

/**
 * CategorySync P1 — primary-category persistence (C1-3 / PRD §4).
 *
 * The contract under test mirrors the tagging track but with the single-placement
 * twist: accepting a CATEGORY proposal writes exactly one `bookmark_primary_category`
 * row (never `bookmark_tags`), the category path is materialised as `tags.parent_id`
 * chain, and every placement is attributable by `source` + `job_id` so it can be
 * undone or protected (manual / browser_folder placements are never clobbered).
 */

function makeEnv(seed?: Partial<AiDbState>): { env: Env; state: AiDbState } {
  const { db, state } = createAiDb(seed);
  return { env: { DB: db as never } as unknown as Env, state };
}

function bookmark(id: string, over: Partial<BookmarkRow> = {}): BookmarkRow {
  return {
    id,
    user_id: 'u1',
    url: `https://${id}.example.com`,
    title: `Bookmark ${id}`,
    description: null,
    deleted_at: null,
    ai_summary: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function tag(id: string, name: string, parentId: string | null = null, over: Partial<TagRow> = {}): TagRow {
  return {
    id,
    user_id: 'u1',
    name,
    color_index: 0,
    parent_id: parentId,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function placement(bookmarkId: string, tagId: string, over: Partial<PrimaryCategoryRow> = {}): PrimaryCategoryRow {
  return {
    bookmark_id: bookmarkId,
    tag_id: tagId,
    confidence: 0.9,
    source: 'ai',
    job_id: 'j1',
    status: 'accepted',
    decided_at: '2026-02-01T00:00:00Z',
    updated_at: '2026-02-01T00:00:00Z',
    ...over,
  };
}

function categorySuggestion(id: string, bookmarkId: string, path: string, over: Partial<SuggestionRow> = {}): SuggestionRow {
  return {
    id,
    user_id: 'u1',
    bookmark_id: bookmarkId,
    job_id: 'j1',
    tag_name: path,
    tag_id: null,
    confidence: 0.9,
    source: 'model',
    reason: 'r',
    kind: 'category',
    status: 'pending',
    decided_at: null,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function catResult(bookmarkId: string, path: string[], over: Partial<NonNullable<CategorizeResult['category']>> = {}): CategorizeResult {
  return {
    bookmarkId,
    category: {
      path,
      tagId: null,
      confidence: 0.9,
      source: 'model',
      reason: 'r',
      isNew: true,
      needsReview: false,
      ...over,
    },
  };
}

/* ------------------------------------------------------------------ *
 * resolveCategorizeScope
 * ------------------------------------------------------------------ */

describe('resolveCategorizeScope — browser_folder protection + uncategorized', () => {
  it('skips bookmarks holding a browser_folder placement by default', async () => {
    const { env } = makeEnv({
      bookmarks: [bookmark('b1'), bookmark('b2'), bookmark('b3')],
      bookmark_primary_category: [
        // b2 was hand-moved inside the managed folder → the model must not re-place it.
        placement('b2', 't_folder', { source: 'browser_folder' }),
        // b3 already has an AI placement — still eligible for a refresh.
        placement('b3', 't_ai', { source: 'ai' }),
      ],
    });
    const ids = await resolveCategorizeScope(env, 'u1', 'all');
    expect(ids.sort()).toEqual(['b1', 'b3']);
  });

  it('includes browser_folder bookmarks when explicitly asked', async () => {
    const { env } = makeEnv({
      bookmarks: [bookmark('b1'), bookmark('b2')],
      bookmark_primary_category: [placement('b2', 't_folder', { source: 'browser_folder' })],
    });
    const ids = await resolveCategorizeScope(env, 'u1', 'all', [], true);
    expect(ids.sort()).toEqual(['b1', 'b2']);
  });

  it('treats `untagged` as "no primary category yet"', async () => {
    const { env } = makeEnv({
      bookmarks: [bookmark('b1'), bookmark('b2'), bookmark('b3')],
      bookmark_primary_category: [placement('b1', 't1', { source: 'ai' })],
      // b2 carries a loose tag but no primary category → still "untagged" for categorize.
      bookmark_tags: [{ bookmark_id: 'b2', tag_id: 'loose', source: 'user', confidence: null, created_at: '2026' }],
    });
    const ids = await resolveCategorizeScope(env, 'u1', 'untagged');
    expect(ids.sort()).toEqual(['b2', 'b3']);
  });

  it('respects explicit ids while still skipping browser_folder rows', async () => {
    const { env } = makeEnv({
      bookmarks: [bookmark('b1'), bookmark('b2'), bookmark('b3')],
      bookmark_primary_category: [placement('b2', 't_folder', { source: 'browser_folder' })],
    });
    const ids = await resolveCategorizeScope(env, 'u1', 'ids', ['b1', 'b2', 'b3']);
    expect(ids.sort()).toEqual(['b1', 'b3']);
  });
});

/* ------------------------------------------------------------------ *
 * saveCategorySuggestions
 * ------------------------------------------------------------------ */

describe('saveCategorySuggestions — kind-isolated queue writes', () => {
  it('stores a pending category row whose tag_name is the full path', async () => {
    const { env, state } = makeEnv({ bookmarks: [bookmark('b1')] });
    const written = await saveCategorySuggestions(env, 'u1', 'j1', [
      catResult('b1', ['开发技术', '前端开发']),
    ]);
    expect(written).toBe(1);
    expect(state.tag_suggestions).toHaveLength(1);
    const row = state.tag_suggestions[0];
    expect(row.kind).toBe('category');
    expect(row.tag_name).toBe('开发技术 > 前端开发');
    expect(row.status).toBe('pending');
    expect(row.topic).toBe('开发技术');
  });

  it('never wipes pending TAG suggestions (kind isolation)', async () => {
    const { env, state } = makeEnv({
      bookmarks: [bookmark('b1')],
      tag_suggestions: [
        // A loose-tag proposal already in the queue for the same bookmark.
        { id: 'tagRow', user_id: 'u1', bookmark_id: 'b1', job_id: 'j0', tag_name: 'React', tag_id: null, confidence: 0.8, source: 'model', reason: 'r', kind: 'tag', status: 'pending', decided_at: null, created_at: '2026' },
      ],
    });
    await saveCategorySuggestions(env, 'u1', 'j1', [catResult('b1', ['开发技术'])]);
    // Both rows survive: the category delete only touches kind='category'.
    expect(state.tag_suggestions).toHaveLength(2);
    expect(state.tag_suggestions.map((s) => s.kind).sort()).toEqual(['category', 'tag']);
  });

  it('does not re-propose a placement the bookmark already holds', async () => {
    const { env, state } = makeEnv({
      bookmarks: [bookmark('b1')],
      bookmark_primary_category: [placement('b1', 't_fe')],
    });
    await saveCategorySuggestions(env, 'u1', 'j1', [
      catResult('b1', ['开发技术'], { tagId: 't_fe' }),
    ]);
    expect(state.tag_suggestions.filter((s) => s.status === 'pending')).toHaveLength(0);
  });

  it('does not re-propose a previously rejected path', async () => {
    const { env, state } = makeEnv({
      bookmarks: [bookmark('b1')],
      tag_suggestions: [
        categorySuggestion('old', 'b1', '开发技术 > 前端开发', { status: 'rejected', decided_at: '2026' }),
      ],
    });
    await saveCategorySuggestions(env, 'u1', 'j1', [catResult('b1', ['开发技术', '前端开发'])]);
    expect(state.tag_suggestions.filter((s) => s.status === 'pending')).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * ensureCategoryPath
 * ------------------------------------------------------------------ */

describe('ensureCategoryPath — global-name reuse + chain wiring (B-5)', () => {
  it('creates every level of a brand-new path and wires parent_id', async () => {
    const { env, state } = makeEnv({});
    const { leafTagId, created } = await ensureCategoryPath(env, 'u1', ['开发技术', '前端开发']);
    expect(created).toBe(2);
    expect(state.tags).toHaveLength(2);
    const root = state.tags.find((t) => t.name === '开发技术');
    const leaf = state.tags.find((t) => t.name === '前端开发');
    expect(root?.parent_id).toBeNull();
    expect(leaf?.parent_id).toBe(root?.id);
    expect(leafTagId).toBe(leaf?.id);
  });

  it('reuses an existing path case-insensitively', async () => {
    const { env, state } = makeEnv({
      tags: [tag('t1', '开发技术'), tag('t2', '前端开发', 't1')],
    });
    const { leafTagId, created } = await ensureCategoryPath(env, 'u1', ['开发技术', '前端开发']);
    expect(created).toBe(0);
    expect(leafTagId).toBe('t2');
    expect(state.tags).toHaveLength(2);
  });

  // B-5（第二轮审计）: 复用改为按名全局。`tags` 的唯一索引
  // idx_tags_user_name(user_id, name) 使同名标签全局唯一，「不同父节点下的两个
  // 同名节点」在真实 DB 中不可能存在——旧实现按 parent 查复用、查不到就 INSERT，
  // 必然撞唯一索引使 auto-apply 崩溃。新语义：命中同名节点即复用（保留其既有
  // parent），绝不新建第二个同名节点。
  it('reuses a same-named node globally instead of inserting a duplicate', async () => {
    const { env, state } = makeEnv({
      tags: [
        tag('work', '工作'),
        tag('study', '学习'),
        // 「资料」已存在于「工作」之下；唯一索引决定全局只能有这一个。
        tag('workDoc', '资料', 'work'),
      ],
    });
    const { leafTagId, created } = await ensureCategoryPath(env, 'u1', ['学习', '资料']);
    // 复用既有的「资料」节点，不新建（旧实现会在此 INSERT 撞唯一索引）。
    expect(created).toBe(0);
    expect(leafTagId).toBe('workDoc');
    expect(state.tags).toHaveLength(3);
  });
});

/* ------------------------------------------------------------------ *
 * decideCategorySuggestions
 * ------------------------------------------------------------------ */

describe('decideCategorySuggestions — single placement, never bookmark_tags', () => {
  it('accept materialises the path and writes exactly one AI placement', async () => {
    const { env, state } = makeEnv({
      bookmarks: [bookmark('b1')],
      tag_suggestions: [categorySuggestion('s1', 'b1', '开发技术 > 前端开发')],
    });
    const outcome = await decideCategorySuggestions(env, 'u1', ['s1'], 'accept');
    expect(outcome).toEqual({ accepted: 1, rejected: 0, tagsCreated: 2 });
    // One placement, attributed to the job, source='ai'.
    expect(state.bookmark_primary_category).toHaveLength(1);
    const p = state.bookmark_primary_category[0];
    expect(p.bookmark_id).toBe('b1');
    expect(p.source).toBe('ai');
    expect(p.job_id).toBe('j1');
    expect(p.status).toBe('accepted');
    // Placement points at the leaf of the freshly created chain.
    const leaf = state.tags.find((t) => t.name === '前端开发');
    expect(p.tag_id).toBe(leaf?.id);
    // Auxiliary tags are untouched — categorize never writes bookmark_tags.
    expect(state.bookmark_tags).toHaveLength(0);
    // The suggestion is marked accepted and the decision is recorded.
    expect(state.tag_suggestions[0].status).toBe('accepted');
    expect(state.ai_feedback).toHaveLength(1);
    expect(state.ai_feedback[0].action).toBe('accepted');
    expect(state.ai_feedback[0].tag_name).toBe('开发技术 > 前端开发');
  });

  it('reject marks the row rejected and writes no placement', async () => {
    const { env, state } = makeEnv({
      bookmarks: [bookmark('b1')],
      tag_suggestions: [categorySuggestion('s1', 'b1', '开发技术')],
    });
    const outcome = await decideCategorySuggestions(env, 'u1', ['s1'], 'reject');
    expect(outcome).toEqual({ accepted: 0, rejected: 1, tagsCreated: 0 });
    expect(state.bookmark_primary_category).toHaveLength(0);
    expect(state.tag_suggestions[0].status).toBe('rejected');
    expect(state.ai_feedback[0].action).toBe('rejected');
  });

  it('accepting an existing-node proposal reuses the tag instead of creating', async () => {
    const { env, state } = makeEnv({
      tags: [tag('t_fe', '前端开发')],
      bookmarks: [bookmark('b1')],
      tag_suggestions: [categorySuggestion('s1', 'b1', '前端开发', { tag_id: 't_fe' })],
    });
    const outcome = await decideCategorySuggestions(env, 'u1', ['s1'], 'accept');
    expect(outcome.tagsCreated).toBe(0);
    expect(state.tags).toHaveLength(1);
    expect(state.bookmark_primary_category[0].tag_id).toBe('t_fe');
  });
});

/* ------------------------------------------------------------------ *
 * autoApplyCategories
 * ------------------------------------------------------------------ */

describe('autoApplyCategories — threshold gate', () => {
  it('auto-applies only high-confidence category rows', async () => {
    const { env, state } = makeEnv({
      bookmarks: [bookmark('b1'), bookmark('b2')],
      tag_suggestions: [
        categorySuggestion('s1', 'b1', '开发技术', { confidence: 0.95 }),
        categorySuggestion('s2', 'b2', '生活', { confidence: 0.5 }),
      ],
    });
    const applied = await autoApplyCategories(env, 'u1', 0.8, 'j1');
    expect(applied).toBe(1);
    expect(state.bookmark_primary_category).toHaveLength(1);
    expect(state.bookmark_primary_category[0].bookmark_id).toBe('b1');
    // The low-confidence row stays pending for review.
    expect(state.tag_suggestions.find((s) => s.id === 's2')?.status).toBe('pending');
  });

  it('is a no-op when the threshold is the default 1.0', async () => {
    const { env, state } = makeEnv({
      bookmarks: [bookmark('b1')],
      tag_suggestions: [categorySuggestion('s1', 'b1', '开发技术', { confidence: 0.99 })],
    });
    const applied = await autoApplyCategories(env, 'u1', 1, 'j1');
    expect(applied).toBe(0);
    expect(state.bookmark_primary_category).toHaveLength(0);
  });

  it('never auto-applies a needs_review category row even above the threshold', async () => {
    // A quarantined adult-content placement carries needs_review=1: it must
    // wait for a human decision regardless of confidence/threshold.
    const { env, state } = makeEnv({
      bookmarks: [bookmark('b1')],
      tag_suggestions: [
        categorySuggestion('s1', 'b1', '成人内容', { confidence: 0.95, needs_review: 1 }),
      ],
    });
    const applied = await autoApplyCategories(env, 'u1', 0.5, 'j1');
    expect(applied).toBe(0);
    expect(state.bookmark_primary_category).toHaveLength(0);
    expect(state.tag_suggestions.find((s) => s.id === 's1')?.status).toBe('pending');
  });
});

/* ------------------------------------------------------------------ *
 * loadCategoryTree
 * ------------------------------------------------------------------ */

describe('loadCategoryTree — subtree rollup', () => {
  it('rolls descendant placements up into each ancestor count', async () => {
    const { env } = makeEnv({
      tags: [
        tag('t1', '开发技术'),
        tag('t2', '前端开发', 't1'),
        tag('t3', 'React', 't2'),
        tag('t4', '生活'),
      ],
      bookmarks: [bookmark('b1'), bookmark('b2'), bookmark('b3')],
      bookmark_primary_category: [
        placement('b1', 't3'),
        placement('b2', 't3'),
        placement('b3', 't1'),
      ],
    });
    const roots = await loadCategoryTree(env, 'u1');
    expect(roots).toHaveLength(2);
    const dev = roots.find((r) => r.name === '开发技术');
    const life = roots.find((r) => r.name === '生活');
    // 开发技术 = 1 direct + 2 under React.
    expect(dev?.count).toBe(3);
    expect(dev?.directCount).toBe(1);
    const fe = dev?.children.find((c) => c.name === '前端开发');
    expect(fe?.count).toBe(2);
    expect(fe?.directCount).toBe(0);
    const react = fe?.children.find((c) => c.name === 'React');
    expect(react?.count).toBe(2);
    expect(react?.directCount).toBe(2);
    // Empty folders still show up.
    expect(life?.count).toBe(0);
  });

  it('ignores placements on deleted bookmarks', async () => {
    const { env } = makeEnv({
      tags: [tag('t1', '开发技术')],
      bookmarks: [bookmark('b1'), bookmark('b2', { deleted_at: '2026-03-01T00:00:00Z' })],
      bookmark_primary_category: [placement('b1', 't1'), placement('b2', 't1')],
    });
    const roots = await loadCategoryTree(env, 'u1');
    expect(roots[0].count).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * deriveCategoryPath
 * ------------------------------------------------------------------ */

describe('deriveCategoryPath — walk parent_id upward', () => {
  it('derives the full path from the placement node', async () => {
    const { env } = makeEnv({
      tags: [tag('t1', '开发技术'), tag('t2', '前端开发', 't1'), tag('t3', 'React', 't2')],
      bookmarks: [bookmark('b1')],
      bookmark_primary_category: [placement('b1', 't3')],
    });
    const path = await deriveCategoryPath(env, 'u1', 'b1');
    expect(path).toEqual(['开发技术', '前端开发', 'React']);
  });

  it('returns null for a bookmark with no accepted placement', async () => {
    const { env } = makeEnv({ bookmarks: [bookmark('b1')] });
    const path = await deriveCategoryPath(env, 'u1', 'b1');
    expect(path).toBeNull();
  });

  it('truncates at a self-loop instead of repeating the name (2026-09-05)', async () => {
    // Historical dirty data: the tag's parent_id points at itself. The walk
    // must stop at the loop, not emit the same name until the depth cap.
    const { env } = makeEnv({
      tags: [tag('t1', '后端开发', 't1'), tag('t2', 'New API', 't1')],
      bookmarks: [bookmark('b1')],
      bookmark_primary_category: [placement('b1', 't2')],
    });
    const path = await deriveCategoryPath(env, 'u1', 'b1');
    expect(path).toEqual(['后端开发', 'New API']);
  });

  it('truncates at a two-node cycle', async () => {
    const { env } = makeEnv({
      tags: [tag('a', '环A', 'b'), tag('b', '环B', 'a'), tag('leaf', '叶子', 'a')],
      bookmarks: [bookmark('b1')],
      bookmark_primary_category: [placement('b1', 'leaf')],
    });
    const path = await deriveCategoryPath(env, 'u1', 'b1');
    // Walk: leaf → a → b → (a again: stop). unshift yields root-first order.
    expect(path).toEqual(['环B', '环A', '叶子']);
  });
});

/* ------------------------------------------------------------------ *
 * loadCategoryTree — cycle tolerance (2026-09-05)
 * ------------------------------------------------------------------ */

describe('loadCategoryTree — cycle tolerance', () => {
  it('promotes self-looping tags to roots so their subtree stays visible', async () => {
    const { env } = makeEnv({
      tags: [tag('t1', '后端开发', 't1'), tag('t2', 'New API', 't1')],
      bookmarks: [bookmark('b1'), bookmark('b2')],
      bookmark_primary_category: [placement('b1', 't1'), placement('b2', 't2')],
    });
    const roots = await loadCategoryTree(env, 'u1');
    expect(roots).toHaveLength(1);
    expect(roots[0].name).toBe('后端开发');
    // Counts roll up through the promoted node.
    expect(roots[0].count).toBe(2);
    expect(roots[0].children.map((c) => c.name)).toEqual(['New API']);
  });

  it('promotes every node of a two-node cycle and keeps lasso tails attached', async () => {
    const { env } = makeEnv({
      tags: [tag('a', '环A', 'b'), tag('b', '环B', 'a'), tag('tail', '套索尾', 'a')],
      bookmarks: [bookmark('b1')],
      bookmark_primary_category: [placement('b1', 'tail')],
    });
    const roots = await loadCategoryTree(env, 'u1');
    expect(roots.map((r) => r.name).sort()).toEqual(['环A', '环B']);
    const a = roots.find((r) => r.name === '环A')!;
    expect(a.children.map((c) => c.name)).toEqual(['套索尾']);
    expect(a.count).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * assignPrimaryCategory
 * ------------------------------------------------------------------ */

describe('assignPrimaryCategory — manual moves win', () => {
  it('writes a manual placement and records a modified feedback event', async () => {
    const { env, state } = makeEnv({
      tags: [tag('t1', '开发技术'), tag('t2', '前端开发', 't1')],
      bookmarks: [bookmark('b1')],
    });
    const written = await assignPrimaryCategory(env, 'u1', ['b1'], 't2');
    expect(written).toBe(1);
    const p = state.bookmark_primary_category[0];
    expect(p.source).toBe('manual');
    expect(p.tag_id).toBe('t2');
    expect(p.confidence).toBeNull();
    expect(state.ai_feedback).toHaveLength(1);
    expect(state.ai_feedback[0].action).toBe('modified');
    // Feedback carries the derived full path, not just the leaf name.
    expect(state.ai_feedback[0].tag_name).toBe('开发技术 > 前端开发');
  });

  it('re-assigning overwrites the prior placement in place', async () => {
    const { env, state } = makeEnv({
      tags: [tag('t1', '开发技术'), tag('t2', '生活')],
      bookmarks: [bookmark('b1')],
      bookmark_primary_category: [placement('b1', 't1', { source: 'ai', job_id: 'j1' })],
    });
    await assignPrimaryCategory(env, 'u1', ['b1'], 't2');
    // Still exactly one row — the manual move replaced the AI placement.
    expect(state.bookmark_primary_category).toHaveLength(1);
    expect(state.bookmark_primary_category[0].tag_id).toBe('t2');
    expect(state.bookmark_primary_category[0].source).toBe('manual');
  });

  it('refuses to place onto a tag owned by another user', async () => {
    const { env, state } = makeEnv({
      tags: [tag('t_other', '别人的分类', null, { user_id: 'u2' })],
      bookmarks: [bookmark('b1')],
    });
    const written = await assignPrimaryCategory(env, 'u1', ['b1'], 't_other');
    expect(written).toBe(0);
    expect(state.bookmark_primary_category).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * updated_at bump — category changes must enter the sync-pull stream (C5-2)
 * ------------------------------------------------------------------ */

describe('category writes bump bookmarks.updated_at (C5-2)', () => {
  it('assignPrimaryCategory bumps updated_at so other browsers pull the move', async () => {
    const { env, state } = makeEnv({
      tags: [tag('t1', '开发技术')],
      bookmarks: [bookmark('b1', { updated_at: '2026-01-01T00:00:00Z' })],
    });
    await assignPrimaryCategory(env, 'u1', ['b1'], 't1');
    const b = state.bookmarks.find((x) => x.id === 'b1');
    // The baseline was 2026-01-01; the bump must move it strictly forward.
    expect(b?.updated_at).not.toBe('2026-01-01T00:00:00Z');
    expect(String(b?.updated_at) > '2026-01-01T00:00:00Z').toBe(true);
  });

  it('decideCategorySuggestions accept bumps every placed bookmark', async () => {
    const { env, state } = makeEnv({
      bookmarks: [
        bookmark('b1', { updated_at: '2026-01-01T00:00:00Z' }),
        bookmark('b2', { updated_at: '2026-01-01T00:00:00Z' }),
      ],
      tag_suggestions: [
        categorySuggestion('s1', 'b1', '开发技术'),
        categorySuggestion('s2', 'b2', '生活'),
      ],
    });
    await decideCategorySuggestions(env, 'u1', ['s1', 's2'], 'accept');
    for (const id of ['b1', 'b2']) {
      const b = state.bookmarks.find((x) => x.id === id);
      expect(String(b?.updated_at) > '2026-01-01T00:00:00Z').toBe(true);
    }
  });

  it('reject does NOT bump updated_at (no category change happened)', async () => {
    const { env, state } = makeEnv({
      bookmarks: [bookmark('b1', { updated_at: '2026-01-01T00:00:00Z' })],
      tag_suggestions: [categorySuggestion('s1', 'b1', '开发技术')],
    });
    await decideCategorySuggestions(env, 'u1', ['s1'], 'reject');
    const b = state.bookmarks.find((x) => x.id === 'b1');
    expect(b?.updated_at).toBe('2026-01-01T00:00:00Z');
  });

  it('only bumps bookmarks owned by the acting user', async () => {
    const { env, state } = makeEnv({
      tags: [tag('t1', '开发技术')],
      bookmarks: [
        bookmark('b1', { updated_at: '2026-01-01T00:00:00Z' }),
        bookmark('b_other', { user_id: 'u2', updated_at: '2026-01-01T00:00:00Z' }),
      ],
    });
    await assignPrimaryCategory(env, 'u1', ['b1', 'b_other'], 't1');
    // b_other belongs to u2 — the bump is scoped by user_id and must skip it.
    expect(state.bookmarks.find((x) => x.id === 'b_other')?.updated_at).toBe('2026-01-01T00:00:00Z');
    expect(String(state.bookmarks.find((x) => x.id === 'b1')?.updated_at) > '2026-01-01T00:00:00Z').toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * undoCategorizeJob
 * ------------------------------------------------------------------ */

describe('undoCategorizeJob — attributable, source-safe rollback', () => {
  it('removes only this job’s AI placements and revives its accepted rows', async () => {
    const { env, state } = makeEnv({
      bookmarks: [bookmark('b1'), bookmark('b2'), bookmark('b3')],
      bookmark_primary_category: [
        placement('b1', 't1', { source: 'ai', job_id: 'j1' }),
        // A manual move must survive the undo.
        placement('b2', 't2', { source: 'manual', job_id: null }),
        // Another job’s AI placement must survive too.
        placement('b3', 't3', { source: 'ai', job_id: 'j9' }),
      ],
      tag_suggestions: [
        categorySuggestion('s1', 'b1', '开发技术', { status: 'accepted', decided_at: '2026' }),
      ],
    });
    const outcome = await undoCategorizeJob(env, 'u1', 'j1');
    expect(outcome).toEqual({ removedPlacements: 1, restoredSuggestions: 1 });
    // Only b1’s AI/j1 placement is gone.
    expect(state.bookmark_primary_category.map((p) => p.bookmark_id).sort()).toEqual(['b2', 'b3']);
    // The accepted category proposal is back in the queue.
    expect(state.tag_suggestions[0].status).toBe('pending');
    expect(state.tag_suggestions[0].decided_at).toBeNull();
  });

  it('leaves tag suggestions untouched (kind isolation on restore)', async () => {
    const { env, state } = makeEnv({
      bookmarks: [bookmark('b1')],
      bookmark_primary_category: [placement('b1', 't1', { source: 'ai', job_id: 'j1' })],
      tag_suggestions: [
        // An accepted TAG row from the same job id must NOT be revived by a categorize undo.
        { id: 'tagRow', user_id: 'u1', bookmark_id: 'b1', job_id: 'j1', tag_name: 'React', tag_id: null, confidence: 0.8, source: 'model', reason: 'r', kind: 'tag', status: 'accepted', decided_at: '2026', created_at: '2026' },
        categorySuggestion('s1', 'b1', '开发技术', { status: 'accepted', decided_at: '2026' }),
      ],
    });
    await undoCategorizeJob(env, 'u1', 'j1');
    expect(state.tag_suggestions.find((s) => s.id === 'tagRow')?.status).toBe('accepted');
    expect(state.tag_suggestions.find((s) => s.id === 's1')?.status).toBe('pending');
  });
});
