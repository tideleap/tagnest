import type { Env, RequestData } from '../../../_lib/env';
import { requireUserId } from '../../../_lib/auth';
import { json, ApiException } from '../../../_lib/http';

export const onRequestDelete: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const id = ctx.params.id;
  const row = await ctx.env.DB.prepare(
    `SELECT id FROM backup_targets WHERE id = ? AND user_id = ?`,
  )
    .bind(id, userId)
    .first();
  if (!row) throw new ApiException(404, 'target_not_found', '备份目标不存在');

  await ctx.env.DB.prepare(`DELETE FROM backup_runs WHERE target_id = ? AND user_id = ?`)
    .bind(id, userId)
    .run();
  await ctx.env.DB.prepare(`DELETE FROM backup_targets WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .run();
  return json({ ok: true });
};
