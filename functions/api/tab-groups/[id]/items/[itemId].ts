import type { Env, RequestData } from '../../../../_lib/env';
import { requireUserId } from '../../../../_lib/auth';
import { notFound } from '../../../../_lib/http';
import { removeItem } from '../../../../_lib/tabgroups';

/**
 * Detach a single bookmark from a tab group.
 *
 * The group itself and the bookmark both survive — only the `tab_items` row
 * linking them is dropped, which is what the card's remove button implies.
 * `removeItem` filters on `user_id` *and* `group_id`, so an id guessed from
 * another account (or another group) simply reports "not found" rather than
 * deleting anything.
 */
export const onRequestDelete: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const groupId = String(ctx.params.id);
  const itemId = String(ctx.params.itemId);

  const removed = await removeItem(ctx.env, userId, groupId, itemId);
  if (!removed) throw notFound('该书签已不在这个分组中');

  return new Response(null, { status: 204 });
};
