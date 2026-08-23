import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CategoryTreeNode, CategoryWritebackPage } from '@shared/types';
import { api, qs } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { keys } from '@/hooks/queries/keys';

/**
 * Data layer for CategorySync's primary-category surface (PRD §5.1).
 *
 * Three hooks:
 *
 *  - `useCategoryTree` — the tag tree annotated with primary-placement counts
 *    (C2-1 data source).
 *  - `useCategoryWriteback` — the keyset-paged `{bookmarkId, categoryPath}`
 *    mapping the browser extension consumes; paged so a large library streams.
 *  - `useAssignCategory` — manual re-classification (C2-3 drag target, also
 *    used by the review queue's "改分类" path).
 */

export function useCategoryTree(enabled = true) {
  return useQuery({
    queryKey: keys.categoryTree,
    queryFn: () => api.get<{ tree: CategoryTreeNode[] }>('/category/tree'),
    enabled,
    staleTime: 30_000,
  });
}

/**
 * Streams the full writeback mapping page by page. The extension loops over
 * the same endpoint; here the infinite query gives the UI a `fetchNextPage`
 * handle so a progress bar can advance per page instead of blocking on one
 * giant response.
 */
export function useCategoryWriteback(enabled = true) {
  return useInfiniteQuery({
    queryKey: keys.categoryWriteback,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.get<CategoryWritebackPage>(
        `/category/tree${qs({ format: 'writeback', cursor: pageParam })}`,
        { signal },
      ),
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    staleTime: 30_000,
  });
}

export interface AssignCategoryInput {
  bookmarkIds: string[];
  tagId: string;
}

/**
 * Manual primary-category placement. Overwrites any prior placement in place
 * (`source='manual'`) and records a `modified` feedback event per bookmark so
 * future categorize runs respect the hand move (C1-6). Auxiliary tags are
 * untouched — a primary category is a placement, not a label.
 */
export function useAssignCategory() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: AssignCategoryInput) =>
      api.post<{ assigned: number }>('/category/assign', {
        bookmarkIds: input.bookmarkIds,
        tagId: input.tagId,
      }),
    onSuccess: (result) => {
      // The placement changes both the tree counts and the writeback mapping.
      void qc.invalidateQueries({ queryKey: keys.categoryTree });
      void qc.invalidateQueries({ queryKey: keys.categoryWriteback });
      void qc.invalidateQueries({ queryKey: keys.bookmarksRoot });
      toast.success(`已将 ${result.assigned} 条书签归入所选分类`);
    },
    onError: (e: Error) => toast.error('分类失败', e.message),
  });
}
