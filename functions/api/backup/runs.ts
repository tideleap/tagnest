import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { json } from '../../_lib/http';
import type { BackupKind, BackupRun } from '../../../shared/types';

interface RunRow {
  id: string;
  target_id: string;
  kind: string;
  endpoint: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  bytes: number | null;
  sha256: string | null;
  error: string | null;
}

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const rows = await ctx.env.DB.prepare(
    `SELECT r.id, r.target_id, t.kind, t.endpoint, r.started_at, r.finished_at,
            r.status, r.bytes, r.sha256, r.error
       FROM backup_runs r
       JOIN backup_targets t ON t.id = r.target_id
      WHERE r.user_id = ?
      ORDER BY r.started_at DESC
      LIMIT 50`,
  )
    .bind(userId)
    .all<RunRow>();

  const runs: BackupRun[] = rows.results.map((r) => ({
    id: r.id,
    targetId: r.target_id,
    kind: r.kind as BackupKind,
    endpoint: r.endpoint,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status as 'ok' | 'failed',
    bytes: r.bytes,
    sha256: r.sha256,
    error: r.error,
  }));
  return json(runs);
};
