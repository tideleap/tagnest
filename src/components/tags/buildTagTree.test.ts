import { describe, it, expect } from 'vitest';
import { buildTagTree, subtreeIds, candidateParents } from './buildTagTree';
import type { Tag } from '@shared/types';

function tag(id: string, name: string, parentId: string | null): Tag {
  return {
    id,
    name,
    parentId,
    colorIndex: 0,
    count: 0,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00Z',
    isPrivate: false,
  };
}

const FLAT: Tag[] = [
  tag('root', '前端', null),
  tag('react', 'React', 'root'),
  tag('vue', 'Vue', 'root'),
  tag('hooks', 'Hooks', 'react'),
  tag('design', '设计', null),
];

describe('subtreeIds', () => {
  it('returns the root plus every descendant', () => {
    expect(subtreeIds(FLAT, 'root').sort()).toEqual(['hooks', 'react', 'root', 'vue'].sort());
  });

  it('returns just the leaf for a node with no children', () => {
    expect(subtreeIds(FLAT, 'hooks')).toEqual(['hooks']);
  });

  it('does not include siblings of the root or its descendants', () => {
    const ids = subtreeIds(FLAT, 'react');
    expect(ids).toContain('react');
    expect(ids).toContain('hooks');
    expect(ids).not.toContain('vue');
    expect(ids).not.toContain('design');
  });
});

describe('candidateParents', () => {
  it('excludes the tag being edited and its whole subtree (cycle guard)', () => {
    const values = candidateParents(FLAT, 'root').map((o) => o.value);
    expect(values).toContain('design');
    expect(values).not.toContain('root');
    expect(values).not.toContain('react');
    expect(values).not.toContain('hooks');
    expect(values).not.toContain('vue');
  });

  it('offers every tag when no exclusion is given', () => {
    const values = candidateParents(FLAT).map((o) => o.value);
    expect(values).toEqual(expect.arrayContaining(['root', 'react', 'vue', 'hooks', 'design']));
  });

  it('indents child labels so the hierarchy reads in a flat dropdown', () => {
    const labels = candidateParents(FLAT).map((o) => o.label);
    const hooks = labels.find((l) => l.includes('Hooks'));
    expect(hooks).toMatch(/↳\s*Hooks/);
  });
});

/**
 * Cycle tolerance (2026-09-05): historical parent_id loops must not make a
 * whole subtree vanish from the sidebar / Tags page. Nodes ON a cycle are
 * promoted to top level; lasso tails keep their parent.
 */
describe('buildTagTree — cycle tolerance', () => {
  it('builds a normal forest unchanged', () => {
    const tops = buildTagTree(FLAT);
    expect(tops.map((t) => t.id).sort()).toEqual(['design', 'root']);
    const root = tops.find((t) => t.id === 'root')!;
    expect(root.children.map((c) => c.id).sort()).toEqual(['react', 'vue']);
  });

  it('promotes a self-looping tag to top level instead of dropping it', () => {
    const tags = [tag('self', '后端开发', 'self'), tag('child', 'New API', 'self')];
    const tops = buildTagTree(tags);
    expect(tops.map((t) => t.id)).toEqual(['self']);
    expect(tops[0].children.map((c) => c.id)).toEqual(['child']);
  });

  it('promotes every node of a two-node cycle and keeps lasso tails attached', () => {
    const tags = [
      tag('a', '环A', 'b'),
      tag('b', '环B', 'a'),
      tag('tail', '套索尾', 'a'),
      tag('ok', '正常根', null),
    ];
    const tops = buildTagTree(tags);
    // a and b are on the cycle → both become roots; tail hangs off a.
    expect(tops.map((t) => t.id).sort()).toEqual(['a', 'b', 'ok']);
    const a = tops.find((t) => t.id === 'a')!;
    expect(a.children.map((c) => c.id)).toEqual(['tail']);
    const b = tops.find((t) => t.id === 'b')!;
    expect(b.children).toHaveLength(0);
  });

  it('keeps a lasso tail under its (promoted) cyclic parent, not at top', () => {
    const tags = [tag('a', '环A', 'a'), tag('tail', '套索尾', 'a')];
    const tops = buildTagTree(tags);
    expect(tops.map((t) => t.id)).toEqual(['a']);
    expect(tops[0].children.map((c) => c.id)).toEqual(['tail']);
  });
});
