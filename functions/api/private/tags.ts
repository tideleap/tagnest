import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { json } from '../../_lib/http';
import { listPrivateTagsWithBookmarks } from '../../_lib/db';

/**
 * GET /api/private/tags
 *
 * Authorized-only listing of every private tag (a category the owner marked
 * private) together with the plaintext bookmarks each one currently hides.
 * This is the read side of category privacy: it lets the owner see what got
 * hidden and un-hide it from the /private page. Every ordinary query path
 * filters these out via PRIVATE_BOOKMARK_CLAUSE, so this endpoint is the only
 * place other users can never reach — requireUserId gates it, and the listing
 * is scoped strictly to `userId`.
 */
export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const tags = await listPrivateTagsWithBookmarks(ctx.env, userId);
  return json({ tags });
};
