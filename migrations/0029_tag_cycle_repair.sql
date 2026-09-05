-- 0029: repair cyclic parent_id references in tags (historical dirty data).
--
-- Before the cycle guards existed (validateTagParent / B-13 wouldCreateCycle)
-- some tags were written with parent_id pointing at themselves or into a
-- multi-node loop. A loop makes every node on it "have a parent", so none
-- ever reaches a root: the category-path walk spins until its depth cap and
-- emits the same name eight times ("人工智能 > 人工智能 > …"), and the
-- sidebar / Tags page silently drop the whole subtree.
--
-- Repair strategy — remove exactly the edge(s) that close each cycle:
--   1) self-loops: parent_id = id → cleared to NULL (tag becomes top-level);
--   2) multi-node loops: every tag whose bounded ancestor walk returns to
--      itself lies ON a cycle; clearing those parent edges breaks the loop
--      while keeping every acyclic parent/child relation intact. Tags that
--      merely hang off a cycle (lasso tails) keep their parent.
--
-- Both statements are idempotent: on a clean database they match zero rows.

UPDATE tags SET parent_id = NULL WHERE parent_id = id;

UPDATE tags
   SET parent_id = NULL
 WHERE id IN (
   WITH RECURSIVE walk(start_id, cur_id, depth) AS (
     SELECT id, parent_id, 1
       FROM tags
      WHERE parent_id IS NOT NULL AND parent_id <> id
     UNION ALL
     SELECT w.start_id, t.parent_id, w.depth + 1
       FROM walk w
       JOIN tags t ON t.id = w.cur_id
      WHERE t.parent_id IS NOT NULL AND w.depth < 64
   )
   SELECT DISTINCT start_id FROM walk WHERE cur_id = start_id
 );
