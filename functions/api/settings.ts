import type { UserSettings } from '../../shared/types';
import type { Env, RequestData } from '../_lib/env';
import { requireUserId } from '../_lib/auth';
import { badRequest, json, readJson } from '../_lib/http';
import { nowIso } from '../_lib/ids';

/**
 * Per-user application settings (the "user_settings" table).
 *
 * Modelled on ai_settings: a row is upserted on first write; GET returns
 * defaulted values when no row exists. At the moment the only knob is the
 * snapshot retention limit, but the endpoint is built to carry more later.
 */

const DEFAULT_RETENTION_LIMIT = 5;

const DEFAULTS: UserSettings = {
  snapshotRetentionLimit: DEFAULT_RETENTION_LIMIT,
};

function mapSettings(row: Record<string, unknown> | null): UserSettings {
  if (!row) return { ...DEFAULTS };
  const raw = row.snapshot_retention_limit;
  // NULL / missing / non-finite → default. -1 (unlimited) and >=1 are valid.
  const n = Number(raw);
  if (Number.isInteger(n) && (n === -1 || n >= 1)) {
    return { snapshotRetentionLimit: n };
  }
  return { ...DEFAULTS };
}

/**
 * Validates and normalises a retention limit from client input.
 *
 * Accepted: -1 (unlimited) and any integer >= 1. 0 is rejected ("keep at least
 * one or choose unlimited"); negative values other than -1 are rejected too.
 * To avoid surprising the user with an in-silence change, an invalid value is
 * a 400 rather than a silent clamp.
 */
function parseRetentionLimit(value: unknown): number {
  const n = Number(value);
  if (value === -1 || value === '-1') return -1;
  if (!Number.isInteger(n) || n < 1) {
    throw badRequest('保留快照数量必须是 -1（不限制）或大于等于 1 的整数', {
      snapshotRetentionLimit: '请输入 -1 或 ≥1 的整数',
    });
  }
  return Math.min(n, 1000); // absurd cap, purely defensive
}

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const row = await ctx.env.DB.prepare(
    `SELECT snapshot_retention_limit FROM user_settings WHERE user_id = ? LIMIT 1`,
  )
    .bind(userId)
    .first<Record<string, unknown>>();
  return json(mapSettings(row));
};

export const onRequestPut: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<Record<string, unknown>>(ctx.request);

  const current = await ctx.env.DB.prepare(
    `SELECT snapshot_retention_limit FROM user_settings WHERE user_id = ? LIMIT 1`,
  )
    .bind(userId)
    .first<Record<string, unknown>>();

  const merged = mapSettings(current);

  if ('snapshotRetentionLimit' in body) {
    merged.snapshotRetentionLimit = parseRetentionLimit(body.snapshotRetentionLimit);
  }

  const ts = nowIso();
  if (current) {
    await ctx.env.DB.prepare(
      `UPDATE user_settings SET snapshot_retention_limit = ?, updated_at = ? WHERE user_id = ?`,
    )
      .bind(merged.snapshotRetentionLimit, ts, userId)
      .run();
  } else {
    await ctx.env.DB.prepare(
      `INSERT INTO user_settings (user_id, snapshot_retention_limit, updated_at)
       VALUES (?, ?, ?)`,
    )
      .bind(userId, merged.snapshotRetentionLimit, ts)
      .run();
  }

  return json(merged);
};
