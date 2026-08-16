import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { json, ApiException } from '../../_lib/http';
import { decryptField, sha256Hex } from '../../_lib/crypto';
import { newId } from '../../_lib/ids';
import { collectExportBody } from '../export';
import { webdavPut } from '../../_lib/webdav';
import { s3Put } from '../../_lib/s3';

interface TargetRow {
  id: string;
  kind: string;
  endpoint: string;
  bucket: string | null;
  username: string | null;
  encrypted_secret: string | null;
  remote_path: string;
  enabled: number;
}

/** Extract the AWS region from a virtual-host S3 endpoint; default if absent. */
function s3Region(endpoint: string): string {
  const m = endpoint.match(/s3\.([a-z0-9-]+)\.amazonaws\.com/);
  return m ? m[1] : 'us-east-1';
}

export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = (await ctx.request.json().catch(() => ({}))) as { targetId?: string };

  if (body.targetId) {
    const owned = await ctx.env.DB.prepare(
      `SELECT id FROM backup_targets WHERE id = ? AND user_id = ?`,
    )
      .bind(body.targetId, userId)
      .first();
    if (!owned) throw new ApiException(404, 'target_not_found', '备份目标不存在');
  }

  const targets = await ctx.env.DB.prepare(
    `SELECT * FROM backup_targets WHERE user_id = ? ${
      body.targetId ? 'AND id = ?' : 'AND enabled = 1'
    }`,
  )
    .bind(userId, ...(body.targetId ? [body.targetId] : []))
    .all<TargetRow>();

  const results: Array<{ targetId: string; status: string; error?: string }> = [];
  for (const t of targets.results) {
    const startedAt = new Date().toISOString();
    const runId = newId();
    try {
      const secret = await decryptField(t.encrypted_secret, ctx.env);
      if (secret == null) throw new Error('凭据解密失败（密钥可能已轮换，请重新保存目标）');

      const payload = await collectExportBody(ctx.env, userId);
      const fileName = `tagnest-${startedAt.slice(0, 10)}.json`;

      const push =
        t.kind === 'webdav'
          ? await webdavPut(
              { endpoint: t.endpoint, username: t.username ?? '', password: secret, remotePath: t.remote_path },
              fileName,
              payload,
              ctx.env,
            )
          : await s3Put(
              {
                endpoint: t.endpoint,
                bucket: t.bucket ?? '',
                region: s3Region(t.endpoint),
                accessKey: t.username ?? '',
                secretKey: secret,
                remotePath: t.remote_path,
              },
              fileName,
              payload,
              ctx.env,
            );

      if (!push.ok) throw new Error(`远端返回 HTTP ${push.status}`);

      const finishedAt = new Date().toISOString();
      const digest = await sha256Hex(payload);
      await ctx.env.DB.prepare(
        `INSERT INTO backup_runs (id, user_id, target_id, started_at, finished_at, status, bytes, sha256, error)
         VALUES (?, ?, ?, ?, ?, 'ok', ?, ?, NULL)`,
      )
        .bind(runId, userId, t.id, startedAt, finishedAt, push.bytes, digest)
        .run();
      await ctx.env.DB.prepare(
        `UPDATE backup_targets SET last_run_at=?, last_status=?, updated_at=? WHERE id=? AND user_id=?`,
      )
        .bind(finishedAt, 'ok', finishedAt, t.id, userId)
        .run();
      results.push({ targetId: t.id, status: 'ok' });
    } catch (e) {
      const finishedAt = new Date().toISOString();
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.env.DB.prepare(
        `INSERT INTO backup_runs (id, user_id, target_id, started_at, finished_at, status, bytes, sha256, error)
         VALUES (?, ?, ?, ?, ?, 'failed', NULL, NULL, ?)`,
      )
        .bind(runId, userId, t.id, startedAt, finishedAt, msg)
        .run();
      await ctx.env.DB.prepare(
        `UPDATE backup_targets SET last_run_at=?, last_status=?, updated_at=? WHERE id=? AND user_id=?`,
      )
        .bind(finishedAt, 'failed', finishedAt, t.id, userId)
        .run();
      results.push({ targetId: t.id, status: 'failed', error: msg });
    }
  }

  const allOk = results.every((r) => r.status === 'ok');
  return json({ results }, { status: allOk ? 200 : 207 });
};
