import type { UserSettings } from '../../shared/types';
import type { Env, RequestData } from '../_lib/env';
import { requireUserId } from '../_lib/auth';
import { badRequest, json, readJson } from '../_lib/http';
import { nowIso } from '../_lib/ids';

/**
 * Per-user application settings (the "user_settings" table).
 *
 * Modelled on ai_settings: a row is upserted on first write; GET returns
 * defaulted values when no row exists yet. Settings:
 *   - snapshotRetentionLimit (default 5, -1 = unlimited)
 *   - auto-clear for Search (enabled + delay, default on/15s)
 *   - auto-clear for Tags  (enabled + delay, default on/30s)
 */

const DEFAULT_RETENTION_LIMIT = 5;
export const DEFAULT_SEARCH_AUTO_CLEAR = { enabled: true, delay: 15 };
export const DEFAULT_TAGS_AUTO_CLEAR = { enabled: true, delay: 30 };

const DEFAULTS: UserSettings = {
  snapshotRetentionLimit: DEFAULT_RETENTION_LIMIT,
  searchAutoClearEnabled: DEFAULT_SEARCH_AUTO_CLEAR.enabled,
  searchAutoClearDelay: DEFAULT_SEARCH_AUTO_CLEAR.delay,
  tagsAutoClearEnabled: DEFAULT_TAGS_AUTO_CLEAR.enabled,
  tagsAutoClearDelay: DEFAULT_TAGS_AUTO_CLEAR.delay,
};

function intOr<T>(raw: unknown, fallback: T, valid: (n: number) => boolean): number | T {
  const n = Number(raw);
  return Number.isInteger(n) && valid(n) ? n : fallback;
}

function boolOr(raw: unknown, fallback: boolean): boolean {
  if (raw === undefined || raw === null) return fallback;
  return raw === 1 || raw === true;
}

/** Reads a delay-in-seconds; 0 and negatives are coerced to the default. */
function delayOr(raw: unknown, fallback: number): number {
  return intOr(raw, fallback, (n) => n >= 1 && n <= 86_400);
}

export function mapSettings(row: Record<string, unknown> | null): UserSettings {
  if (!row) return { ...DEFAULTS };

  const retention = intOr(row.snapshot_retention_limit, DEFAULT_RETENTION_LIMIT, (n) => n === -1 || n >= 1);

  return {
    snapshotRetentionLimit: retention,
    searchAutoClearEnabled: boolOr(row.search_auto_clear_enabled, DEFAULT_SEARCH_AUTO_CLEAR.enabled),
    searchAutoClearDelay: delayOr(row.search_auto_clear_delay, DEFAULT_SEARCH_AUTO_CLEAR.delay),
    tagsAutoClearEnabled: boolOr(row.tags_auto_clear_enabled, DEFAULT_TAGS_AUTO_CLEAR.enabled),
    tagsAutoClearDelay: delayOr(row.tags_auto_clear_delay, DEFAULT_TAGS_AUTO_CLEAR.delay),
  };
}

/**
 * Validates and normalises a retention limit. Accepted: -1 (unlimited) and any
 * integer >= 1. Invalid → 400 rather than a silent change.
 */
export function parseRetentionLimit(value: unknown): number {
  const n = Number(value);
  if (value === -1 || value === '-1') return -1;
  if (!Number.isInteger(n) || n < 1) {
    throw badRequest('保留快照数量必须是 -1（不限制）或大于等于 1 的整数', {
      snapshotRetentionLimit: '请输入 -1 或 ≥1 的整数',
    });
  }
  return Math.min(n, 1000);
}

/**
 * Validates an auto-clear delay. Accepted: an integer in [1, 86400] seconds.
 * The UI nudges to a sensible minimum; a caller asking for 0 or negative gets a
 * 400 rather than an ambiguous "disabled" that the flag should express instead.
 */
export function parseAutoClearDelay(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 86_400) {
    throw badRequest(`${label}必须是 1–86400 的整数秒`, { [label]: '请输入 1–86400 的整数' });
  }
  return n;
}

const ALWAYS_COLUMNS =
  'snapshot_retention_limit, search_auto_clear_enabled, search_auto_clear_delay, tags_auto_clear_enabled, tags_auto_clear_delay';

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const row = await ctx.env.DB.prepare(`SELECT ${ALWAYS_COLUMNS} FROM user_settings WHERE user_id = ? LIMIT 1`)
    .bind(userId)
    .first<Record<string, unknown>>();
  return json(mapSettings(row));
};

export const onRequestPut: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<Record<string, unknown>>(ctx.request);

  const current = await ctx.env.DB.prepare(`SELECT ${ALWAYS_COLUMNS} FROM user_settings WHERE user_id = ? LIMIT 1`)
    .bind(userId)
    .first<Record<string, unknown>>();

  const merged = mapSettings(current);

  if ('snapshotRetentionLimit' in body) {
    merged.snapshotRetentionLimit = parseRetentionLimit(body.snapshotRetentionLimit);
  }
  if ('searchAutoClearEnabled' in body) {
    merged.searchAutoClearEnabled = Boolean(body.searchAutoClearEnabled);
  }
  if ('searchAutoClearDelay' in body) {
    merged.searchAutoClearDelay = parseAutoClearDelay(body.searchAutoClearDelay, 'searchAutoClearDelay');
  }
  if ('tagsAutoClearEnabled' in body) {
    merged.tagsAutoClearEnabled = Boolean(body.tagsAutoClearEnabled);
  }
  if ('tagsAutoClearDelay' in body) {
    merged.tagsAutoClearDelay = parseAutoClearDelay(body.tagsAutoClearDelay, 'tagsAutoClearDelay');
  }

  const ts = nowIso();
  if (current) {
    await ctx.env.DB.prepare(
      `UPDATE user_settings SET
         snapshot_retention_limit = ?,
         search_auto_clear_enabled = ?, search_auto_clear_delay = ?,
         tags_auto_clear_enabled = ?, tags_auto_clear_delay = ?,
         updated_at = ?
       WHERE user_id = ?`,
    )
      .bind(
        merged.snapshotRetentionLimit,
        merged.searchAutoClearEnabled ? 1 : 0,
        merged.searchAutoClearDelay,
        merged.tagsAutoClearEnabled ? 1 : 0,
        merged.tagsAutoClearDelay,
        ts,
        userId,
      )
      .run();
  } else {
    await ctx.env.DB.prepare(
      `INSERT INTO user_settings (
         user_id, snapshot_retention_limit,
         search_auto_clear_enabled, search_auto_clear_delay,
         tags_auto_clear_enabled, tags_auto_clear_delay,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        userId,
        merged.snapshotRetentionLimit,
        merged.searchAutoClearEnabled ? 1 : 0,
        merged.searchAutoClearDelay,
        merged.tagsAutoClearEnabled ? 1 : 0,
        merged.tagsAutoClearDelay,
        ts,
      )
      .run();
  }

  return json(merged);
};
