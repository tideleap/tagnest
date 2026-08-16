import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { json, badRequest } from '../../_lib/http';
import { encryptField } from '../../_lib/crypto';
import { newId } from '../../_lib/ids';
import type {
  BackupFrequency,
  BackupKind,
  BackupTarget,
  BackupTargetInput,
} from '../../../shared/types';

interface TargetRow {
  id: string;
  user_id: string;
  kind: string;
  endpoint: string;
  bucket: string | null;
  username: string | null;
  encrypted_secret: string | null;
  remote_path: string;
  enabled: number;
  frequency: string;
  last_run_at: string | null;
  last_status: string | null;
  created_at: string;
  updated_at: string;
}

function mapTarget(r: TargetRow): BackupTarget {
  return {
    id: r.id,
    kind: r.kind as BackupKind,
    endpoint: r.endpoint,
    bucket: r.bucket,
    username: r.username,
    remotePath: r.remote_path,
    enabled: r.enabled === 1,
    frequency: r.frequency as BackupFrequency,
    lastRunAt: r.last_run_at,
    lastStatus: (r.last_status as 'ok' | 'failed' | null) ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const rows = await ctx.env.DB.prepare(
    `SELECT * FROM backup_targets WHERE user_id = ? ORDER BY created_at ASC, id ASC`,
  )
    .bind(userId)
    .all<TargetRow>();
  return json(rows.results.map(mapTarget));
};

export const onRequestPut: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = (await ctx.request.json()) as BackupTargetInput;
  if (body.kind !== 'webdav' && body.kind !== 's3') throw badRequest('kind 必须是 webdav 或 s3');
  if (!body.endpoint) throw badRequest('endpoint 不能为空');
  if (body.frequency && !['off', 'daily', 'weekly'].includes(body.frequency)) {
    throw badRequest('frequency 无效');
  }

  const now = new Date().toISOString();
  const id = body.id ?? newId();

  const existing = body.id
    ? await ctx.env.DB.prepare(
        `SELECT id, encrypted_secret FROM backup_targets WHERE id = ? AND user_id = ?`,
      )
        .bind(body.id, userId)
        .first<{ id: string; encrypted_secret: string | null }>()
    : null;

  // Omit = keep stored; '' = clear; otherwise encrypt the incoming plaintext.
  const encryptedSecret =
    body.secret == null
      ? existing?.encrypted_secret ?? null
      : body.secret === ''
        ? null
        : await encryptField(body.secret, ctx.env);

  const endpoint = body.endpoint;
  const bucket = body.bucket ?? null;
  const username = body.username ?? null;
  const remotePath = body.remotePath ?? '/';
  const enabled = body.enabled ?? true;
  const frequency = body.frequency ?? 'off';

  if (existing) {
    await ctx.env.DB.prepare(
      `UPDATE backup_targets SET endpoint=?, bucket=?, username=?, encrypted_secret=?,
        remote_path=?, enabled=?, frequency=?, updated_at=? WHERE id=? AND user_id=?`,
    )
      .bind(
        endpoint,
        bucket,
        username,
        encryptedSecret,
        remotePath,
        enabled ? 1 : 0,
        frequency,
        now,
        id,
        userId,
      )
      .run();
  } else {
    await ctx.env.DB.prepare(
      `INSERT INTO backup_targets
        (id, user_id, kind, endpoint, bucket, username, encrypted_secret,
         remote_path, enabled, frequency, last_run_at, last_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    )
      .bind(
        id,
        userId,
        body.kind,
        endpoint,
        bucket,
        username,
        encryptedSecret,
        remotePath,
        enabled ? 1 : 0,
        frequency,
        now,
        now,
      )
      .run();
  }

  const row = await ctx.env.DB.prepare(
    `SELECT * FROM backup_targets WHERE id = ? AND user_id = ?`,
  )
    .bind(id, userId)
    .first<TargetRow>();
  return json(mapTarget(row!), { status: existing ? 200 : 201 });
};
