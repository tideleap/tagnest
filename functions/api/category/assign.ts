import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, json, readJson } from '../../_lib/http';
import { assignPrimaryCategory } from '../../_lib/ai';

/** Ceiling for one manual re-classification call. Keeps the D1 batch sane. */
const MAX_ASSIGN = 500;

/**
 * Manual / drag-and-drop re-classification (CategorySync §5.1, C2-3).
 *
 *   POST /api/category/assign  { bookmark_ids: [...], tag_id: "..." }
 *
 * Writes `source = 'manual'` into `bookmark_primary_category` (overwriting any
 * prior placement in place) and records a `modified` feedback event per bookmark
 * so future categorize runs respect the hand move (C1-6). Auxiliary tags in
 * `bookmark_tags` are untouched — a primary category is a placement, not a label.
 *
 * Ownership is enforced twice: here we reject an empty/oversized request, and
 * `assignPrimaryCategory` refuses a `tag_id` that does not belong to the caller.
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<{ bookmark_ids?: unknown; bookmarkIds?: unknown; tag_id?: unknown; tagId?: unknown }>(
    ctx.request,
  );

  // Accept both snake_case (extension) and camelCase (web client) spellings.
  const rawIds = Array.isArray(body.bookmark_ids) ? body.bookmark_ids : body.bookmarkIds;
  const rawTag = body.tag_id ?? body.tagId;

  const bookmarkIds = Array.isArray(rawIds)
    ? [...new Set(rawIds.map(String))].filter(Boolean).slice(0, MAX_ASSIGN)
    : [];
  const tagId = typeof rawTag === 'string' ? rawTag.trim() : '';

  if (bookmarkIds.length === 0) throw badRequest('请选择要分类的书签');
  if (!tagId) throw badRequest('请选择目标分类');

  const written = await assignPrimaryCategory(ctx.env, userId, bookmarkIds, tagId);

  // `written === 0` with a non-empty request means the target tag does not
  // belong to this user — surface it as a client error, not a silent no-op.
  if (written === 0) throw badRequest('目标分类不存在或无权访问');

  return json({ assigned: written });
};
