import { describe, expect, it } from 'vitest';
import { wouldCreateCycle } from '../functions/_lib/ai/grouping-apply';

/**
 * B-13: `applyTagHierarchy` rewrites `parent_id` for many tags at once, and
 * `ensureTag` may reuse an existing same-name tag (with its own ancestry) as a
 * category node. Without a guard, a rewrite can close a cycle — e.g. the live
 * tree already has 前端→前端开发, and the rules then try to hang 前端 under
 * 前端开发. A cycle makes every recursive render/loop over the tree hang.
 *
 * `wouldCreateCycle` is the guard: it walks the proposed parent's ancestor
 * chain and reports a hit when `tagId` is reached. These tests pin that
 * behaviour so the tree stays acyclic.
 */

describe('wouldCreateCycle — B-13 parent-rewrite cycle guard', () => {
  it('never cycles when the new parent is null (moving to top level)', () => {
    const parentOf = new Map<string, string | null>([['a', 'b']]);
    expect(wouldCreateCycle(parentOf, 'a', null)).toBe(false);
  });

  it('detects the degenerate self-parent case', () => {
    const parentOf = new Map<string, string | null>();
    expect(wouldCreateCycle(parentOf, 'a', 'a')).toBe(true);
  });

  it('detects a direct two-node cycle', () => {
    // Live tree: 前端开发(b) hangs under 前端(a) — i.e. b's parent is a. The
    // rules then try to hang 前端(a) under 前端开发(b), closing a↔b.
    const parentOf = new Map<string, string | null>([
      ['a', null],
      ['b', 'a'],
    ]);
    expect(wouldCreateCycle(parentOf, 'a', 'b')).toBe(true);
  });

  it('detects an indirect cycle through a longer ancestor chain', () => {
    // a → b → c (c's parent is b, b's parent is a). Setting a's parent to c
    // would make a its own ancestor.
    const parentOf = new Map<string, string | null>([
      ['a', null],
      ['b', 'a'],
      ['c', 'b'],
    ]);
    expect(wouldCreateCycle(parentOf, 'a', 'c')).toBe(true);
  });

  it('allows a rewrite whose parent is not an ancestor', () => {
    const parentOf = new Map<string, string | null>([
      ['a', null],
      ['b', null],
      ['c', 'b'],
    ]);
    // Hanging c under a is fine: a is not in c's ancestry.
    expect(wouldCreateCycle(parentOf, 'c', 'a')).toBe(false);
  });

  it('allows attaching a root under an unrelated node', () => {
    const parentOf = new Map<string, string | null>([
      ['a', null],
      ['b', null],
    ]);
    expect(wouldCreateCycle(parentOf, 'a', 'b')).toBe(false);
  });

  it('terminates on a pre-existing corrupt cycle that does not pass through the tag', () => {
    // x ↔ y is already a cycle in the (corrupt) map. Asking about an unrelated
    // tag z must not hang; the walk hits the guard bound and returns false.
    const parentOf = new Map<string, string | null>([
      ['x', 'y'],
      ['y', 'x'],
      ['z', null],
    ]);
    expect(wouldCreateCycle(parentOf, 'z', 'x')).toBe(false);
  });

  it('detects a cycle even when the walk enters a loop that reaches the tag', () => {
    // z → x → y → x ... but we ask whether setting y's parent to z cycles.
    // Walk from z: z's parent is x, x's parent is y, y === tagId → cycle.
    const parentOf = new Map<string, string | null>([
      ['x', 'y'],
      ['y', null],
      ['z', 'x'],
    ]);
    expect(wouldCreateCycle(parentOf, 'y', 'z')).toBe(true);
  });
});
