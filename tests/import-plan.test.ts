// Regression tests for the import writer's per-row decision.
//
// The bug this pins down: a URL that was already live got planned as an
// INSERT with a fresh id. The partial UNIQUE index (migration 0004) made
// `INSERT OR IGNORE` drop that row, and the bookmark_tags rows pointing at the
// discarded id then violated the FOREIGN KEY — which `OR IGNORE` does not
// suppress — so D1 rolled the whole 50-statement batch back. One duplicate URL
// in a re-imported file silently destroyed up to 49 good bookmarks.
import { describe, expect, it } from 'vitest';
import { planImportRow } from '../functions/_lib/import-plan';

const item = (over = {}) => ({
  url: 'https://example.com/',
  title: 'Example',
  tagNames: [],
  folderPath: [],
  addedAt: null,
  ...over,
});

function makeCtx(over = {}) {
  let n = 0;
  return {
    existing: new Map(),
    tagIdByLower: new Map(),
    extraIds: [],
    foldersAsTags: true,
    skipDuplicates: true,
    newId: () => `new-${++n}`,
    ...over,
  };
}

describe('planImportRow: duplicates', () => {
  it('skips a live URL when skipDuplicates is on', () => {
    const ctx = makeCtx({ existing: new Map([['example.com/', 'bm-old']]) });
    expect(planImportRow(item(), 'example.com/', ctx)).toEqual({ kind: 'skip' });
  });

  it('merges onto the existing bookmark instead of inserting a doomed row', () => {
    // Before the fix this returned an insert with a brand-new id, which the
    // UNIQUE index discarded and whose tag rows then broke the whole batch.
    const ctx = makeCtx({
      existing: new Map([['example.com/', 'bm-old']]),
      skipDuplicates: false,
      extraIds: ['tag-import'],
    });
    expect(planImportRow(item(), 'example.com/', ctx)).toEqual({
      kind: 'merge',
      bookmarkId: 'bm-old',
      tagIds: ['tag-import'],
    });
  });

  it('never plans a second insert for a URL repeated inside the same file', () => {
    const ctx = makeCtx({ skipDuplicates: false });
    const first = planImportRow(item(), 'example.com/', ctx);
    const second = planImportRow(item(), 'example.com/', ctx);

    expect(first).toMatchObject({ kind: 'insert', bookmarkId: 'new-1' });
    // The id reserved by the first pass is what the second one attaches to —
    // otherwise the two inserts race the UNIQUE index inside one batch.
    expect(second).toMatchObject({ kind: 'merge', bookmarkId: 'new-1' });
  });

  it('skips the repeat when skipDuplicates is on', () => {
    const ctx = makeCtx();
    expect(planImportRow(item(), 'example.com/', ctx)).toMatchObject({ kind: 'insert' });
    expect(planImportRow(item(), 'example.com/', ctx)).toEqual({ kind: 'skip' });
  });
});

describe('planImportRow: tag resolution', () => {
  const tagIdByLower = new Map([
    ['设计', 'tag-design'],
    ['dev', 'tag-dev'],
    ['工具箱', 'tag-tools'],
  ]);

  it('combines import-wide extras, item tags and the leaf folder', () => {
    const ctx = makeCtx({ tagIdByLower, extraIds: ['tag-import'] });
    const plan = planImportRow(
      item({ tagNames: [' Dev '], folderPath: ['书签栏', '工具箱'] }),
      'example.com/',
      ctx,
    );
    expect(plan).toMatchObject({ kind: 'insert' });
    expect((plan as { tagIds: string[] }).tagIds).toEqual([
      'tag-import',
      'tag-dev',
      'tag-tools',
    ]);
  });

  it('uses only the leaf folder, never the ancestors', () => {
    const ctx = makeCtx({ tagIdByLower: new Map([...tagIdByLower, ['书签栏', 'tag-bar']]) });
    const plan = planImportRow(item({ folderPath: ['书签栏', '设计'] }), 'example.com/', ctx);
    expect((plan as { tagIds: string[] }).tagIds).toEqual(['tag-design']);
  });

  it('ignores the folder entirely when foldersAsTags is off', () => {
    const ctx = makeCtx({ tagIdByLower, foldersAsTags: false });
    const plan = planImportRow(item({ folderPath: ['工具箱'] }), 'example.com/', ctx);
    expect((plan as { tagIds: string[] }).tagIds).toEqual([]);
  });

  it('drops names that resolved to no tag rather than emitting a bad id', () => {
    const ctx = makeCtx({ tagIdByLower });
    const plan = planImportRow(item({ tagNames: ['dev', '不存在的标签'] }), 'example.com/', ctx);
    expect((plan as { tagIds: string[] }).tagIds).toEqual(['tag-dev']);
  });

  it('deduplicates a tag that arrives from two sources', () => {
    const ctx = makeCtx({ tagIdByLower, extraIds: ['tag-dev'] });
    const plan = planImportRow(
      item({ tagNames: ['dev'], folderPath: ['dev'] }),
      'example.com/',
      ctx,
    );
    expect((plan as { tagIds: string[] }).tagIds).toEqual(['tag-dev']);
  });
});
