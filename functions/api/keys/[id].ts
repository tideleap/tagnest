import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { notFound, noContent } from '../../_lib/http';

/**
 * Revocation.
 *
 * A hard delete, not a flag: the row exists only to authenticate a
 * credential, so keeping a tombstone would serve no purpose and would leave
 * the digest sitting in the database.
 */
export const onRequestDelete: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const id = String(ctx.params.id);

  const result = await ctx.env.DB.prepare(
    `DELETE FROM api_keys WHERE id = ? AND user_id = ?`,
  )
    .bind(id, userId)
    .run();

  // Scoping the delete by user_id means a foreign id looks identical to a
  // nonexistent one, which is the correct answer either way.
  if (!result.meta.changes) throw notFound('密钥不存在');

  return noContent();
};
