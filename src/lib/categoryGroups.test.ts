import { describe, it, expect } from 'vitest';
import { buildCategoryGroups, UNTAGGED_GROUP_ID } from './categoryGroups';
import type { Bookmark, Tag } from '@shared/types';

function tag(id: string, name: string, parentId: string | null, colorIndex = 0): Tag {
  return {
    id,
    name,
    parentId,
    colorIndex,
    count: 0,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00Z',
    isPrivate: false,
  };
}

function bookmark(id: string, tags: Tag[]): Bookmark {
  return {
    id,
    url: `https://example.com/${id}`,
    title: `Bookmark ${id}`,
    description: null,
    faviconUrl: null,
    coverUrl: null,
    snapshotKey: null,
    snapshotKeys: [],
    note: null,
    aiSummary: null,
    isFavorite: false,
    isArchived: false,
    visitCount: 0,
    lastVisitedAt: null,
    manualOrder: 0,
    tags,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    deletedAt: null,
  };
}

const FRONTEND = tag('frontend', '前端', null, 1);
const REACT = tag('react', 'React', 'frontend', 2);
const VUE = tag('vue', 'Vue', 'frontend', 3);
const HOOKS = tag('hooks', 'Hooks', 'react', 4);
const DESIGN = tag('design', '设计', null, 5);

describe('buildCategoryGroups', () => {
  it('returns an empty list for no bookmarks', () => {
    expect(buildCategoryGroups([FRONTEND], [])).toEqual([]);
  });

  it('buckets a child-tagged bookmark under its top-level group', () => {
    const groups = buildCategoryGroups(
      [FRONTEND, REACT],
      [bookmark('b1', [REACT])],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe('frontend');
    expect(groups[0].directItems).toHaveLength(0);
    expect(groups[0].children).toHaveLength(1);
    expect(groups[0].children[0].id).toBe('react');
    expect(groups[0].children[0].items.map((b) => b.id)).toEqual(['b1']);
  });

  it('keeps a bookmark carrying both parent and child in the child bucket only', () => {
    const groups = buildCategoryGroups(
      [FRONTEND, REACT],
      [bookmark('b1', [FRONTEND, REACT])],
    );
    expect(groups[0].directItems).toHaveLength(0);
    expect(groups[0].children[0].items.map((b) => b.id)).toEqual(['b1']);
  });

  it('resolves deep (grandchild) tags up to the top-level group', () => {
    const groups = buildCategoryGroups(
      [FRONTEND, REACT, HOOKS],
      [bookmark('b1', [HOOKS])],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe('frontend');
    // The depth-1 ancestor under 前端 is React.
    expect(groups[0].children[0].id).toBe('react');
  });

  it('picks the alphabetically first child when several children match', () => {
    const groups = buildCategoryGroups(
      [FRONTEND, REACT, VUE],
      [bookmark('b1', [VUE, REACT])],
    );
    expect(groups[0].children).toHaveLength(1);
    expect(groups[0].children[0].id).toBe('react'); // React < Vue in zh-CN order
  });

  it('lists a multi-top-tag bookmark under every top-level group', () => {
    const groups = buildCategoryGroups(
      [FRONTEND, DESIGN],
      [bookmark('b1', [FRONTEND, DESIGN])],
    );
    expect(groups.map((g) => g.id).sort()).toEqual(['design', 'frontend']);
    for (const g of groups) {
      expect(g.directItems.map((b) => b.id)).toEqual(['b1']);
    }
  });

  it('collects tagless bookmarks into the untagged catch-all, sorted last', () => {
    const groups = buildCategoryGroups(
      [FRONTEND],
      [bookmark('b1', []), bookmark('b2', [FRONTEND])],
    );
    expect(groups[groups.length - 1].id).toBe(UNTAGGED_GROUP_ID);
    expect(groups[groups.length - 1].directItems.map((b) => b.id)).toEqual(['b1']);
  });

  it('drops groups that end up with no visible bookmarks', () => {
    const groups = buildCategoryGroups(
      [FRONTEND, DESIGN],
      [bookmark('b1', [FRONTEND])],
    );
    expect(groups.map((g) => g.id)).toEqual(['frontend']);
  });

  it('sorts top-level groups by name (zh-CN)', () => {
    const groups = buildCategoryGroups(
      [DESIGN, FRONTEND],
      [bookmark('b1', [DESIGN]), bookmark('b2', [FRONTEND])],
    );
    expect(groups.map((g) => g.name)).toEqual(['前端', '设计']);
  });

  it('promotes a child tag to top level when its parent is absent from the graph', () => {
    // No fresh tag list and the bookmark only embeds the child tag: the
    // parent cannot be resolved, so the child is promoted to a top-level
    // group instead of being lost (same rule as the backend directory theme).
    const groups = buildCategoryGroups([], [bookmark('b1', [REACT])]);
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe('react');
    expect(groups[0].directItems.map((b) => b.id)).toEqual(['b1']);
    expect(groups[0].children).toHaveLength(0);
  });
});
