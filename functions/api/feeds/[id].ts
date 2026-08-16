import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { json, notFound } from '../../_lib/http';

/** DELETE /api/feeds/:id — unsubscribe. */
export const onRequestDelete: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const feedId = ctx.params.id;

  const res = await ctx.env.DB.prepare(`DELETE FROM feeds WHERE id = ? AND user_id = ?`)
    .bind(feedId, userId)
    .run();

  const changes = Number((res as { meta?: { changes?: number } }).meta?.changes ?? 0);
  if (changes === 0) throw notFound('订阅源不存在');

  return json({ ok: true }, { status: 200 });
};
