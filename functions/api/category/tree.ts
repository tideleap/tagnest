import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, json } from '../../_lib/http';
import {
  WRITEBACK_PAGE_SIZE,
  loadCategoryTree,
  loadCategoryWritebackPage,
} from '../../_lib/ai';

/**
 * The category tree and the extension writeback feed (CategorySync §5.1).
 *
 * Two shapes behind one path, selected by `format`:
 *
 *   GET /api/category/tree
 *     → the tag tree (= the category tree, D4) annotated with how many
 *       bookmarks each node holds via `bookmark_primary_category`. This is the
 *       "分类视图" data source (C2-1): `count` is the subtree total, so a
 *       top-level category shows everything under it.
 *
 *   GET /api/category/tree?format=writeback&cursor=...
 *     → the full `{bookmarkId, url, title, categoryPath}` mapping the browser
 *       extension consumes to build the managed bookmark-bar folder structure
 *       (§7.2). Keyset-paged over `bookmark_id` so a large library streams
 *       instead of arriving in one multi-megabyte body; the extension loops
 *       until `nextCursor` is null.
 *
 * `categoryPath` is derived by walking `tags.parent_id` upward — never stored —
 * so the tree and the path can never disagree (C4-1).
 */
export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const url = new URL(ctx.request.url);

  const format = url.searchParams.get('format');

  if (format === 'writeback') {
    const cursor = url.searchParams.get('cursor');

    const rawLimit = Number(url.searchParams.get('limit') ?? WRITEBACK_PAGE_SIZE);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.trunc(rawLimit), WRITEBACK_PAGE_SIZE)
      : WRITEBACK_PAGE_SIZE;

    const page = await loadCategoryWritebackPage(ctx.env, userId, cursor, limit);
    return json(page);
  }

  if (format !== null && format !== 'tree') {
    throw badRequest('format 参数无效');
  }

  const tree = await loadCategoryTree(ctx.env, userId);
  return json({ tree });
};
