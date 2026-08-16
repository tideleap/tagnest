import { describe, it, expect } from 'vitest';
import { subtreeIds, candidateParents } from './buildTagTree';
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
