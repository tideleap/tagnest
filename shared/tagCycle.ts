/**
 * Pure cycle detection over a tag parent map (2026-09-05, tag-cycle repair).
 *
 * Historical dirty data could carry `parent_id` cycles (self-loops written
 * before the cycle guards existed). A cycle makes every node on it "have a
 * parent", so no tree builder ever reaches them as a root: the sidebar /
 * Tags page / category tree silently drop the whole subtree, and the
 * category-path walk spins until its depth cap emitting the same name over
 * and over ("人工智能 > 人工智能 > …").
 *
 * `cycleNodeIds` returns exactly the ids that lie ON a cycle (a node whose
 * bounded ancestor walk returns to itself). Callers promote those nodes to
 * top-level — removing precisely the edge that closes each loop — while
 * lasso tails (nodes that merely hang off a cycle) keep their parent.
 *
 * Pure and allocation-light: one memoised walk per node, O(n) overall.
 */
export function cycleNodeIds(
  nodes: Iterable<{ id: string; parentId: string | null }>,
): Set<string> {
  const parentOf = new Map<string, string | null>();
  for (const n of nodes) parentOf.set(n.id, n.parentId ?? null);

  const state = new Map<string, 'clean' | 'cycle'>();
  const onCycle = new Set<string>();

  const classify = (start: string): void => {
    if (state.has(start)) return;
    const path: string[] = [];
    const index = new Map<string, number>();
    let cursor: string | null = start;
    let cycleFrom = -1;

    while (cursor !== null) {
      const memo = state.get(cursor);
      if (memo === 'cycle') {
        // Walking into a known cycle: this path is a lasso tail, not on it.
        cycleFrom = -1;
        break;
      }
      if (memo === 'clean') break;
      const at = index.get(cursor);
      if (at !== undefined) {
        cycleFrom = at;
        break;
      }
      index.set(cursor, path.length);
      path.push(cursor);
      if (path.length > 4096) break; // pathological chain guard
      const next = parentOf.get(cursor);
      // Dangling parent (id not in this graph) terminates the walk.
      cursor = next !== undefined && next !== null && parentOf.has(next) ? next : null;
    }

    if (cycleFrom >= 0) {
      for (let i = cycleFrom; i < path.length; i += 1) {
        state.set(path[i], 'cycle');
        onCycle.add(path[i]);
      }
      for (let i = 0; i < cycleFrom; i += 1) state.set(path[i], 'clean');
    } else {
      for (const id of path) state.set(id, 'clean');
    }
  };

  for (const id of parentOf.keys()) classify(id);
  return onCycle;
}
