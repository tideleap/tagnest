import type { SharePalette, ShareTheme } from '../../../shared/types';
import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, conflict, json, readJson } from '../../_lib/http';
import { isoFromNow, newId, nowIso } from '../../_lib/ids';
import { PALETTES, THEMES, assertValidSlug, mapShare, normalizeSlug, slugFromTitle } from '../../_lib/shares';
import { createLogger } from '../../_lib/logger';

const MAX_SHARES = 50;

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const rows = await ctx.env.DB.prepare(
    `SELECT * FROM shares WHERE user_id = ? ORDER BY created_at DESC`,
  )
    .bind(userId)
    .all<Record<string, unknown>>();

  return json({ items: rows.results.map(mapShare) });
};

export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<Record<string, unknown>>(ctx.request);

  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : '';
  if (!title) throw badRequest('请填写分享页标题', { title: '请填写标题' });

  // An explicit slug is validated strictly; a derived one is already clean by
  // construction, so it skips the reserved-word rejection and just retries.
  const slug = body.slug ? normalizeSlug(String(body.slug)) : slugFromTitle(title);
  if (body.slug) assertValidSlug(slug);

  const taken = await ctx.env.DB.prepare(`SELECT id FROM shares WHERE slug = ? LIMIT 1`)
    .bind(slug)
    .first<{ id: string }>();
  if (taken) throw conflict('该链接后缀已被使用', { slug: '已被占用' });

  const count = await ctx.env.DB.prepare(`SELECT COUNT(*) AS c FROM shares WHERE user_id = ?`)
    .bind(userId)
    .first<{ c: number }>();
  if (Number(count?.c ?? 0) >= MAX_SHARES) {
    throw badRequest(`最多只能创建 ${MAX_SHARES} 个分享页`);
  }

  const tagIds = Array.isArray(body.tagIds)
    ? [...new Set(body.tagIds.map(String).filter(Boolean))].slice(0, 20)
    : [];

  const theme = THEMES.includes(body.theme as ShareTheme)
    ? (body.theme as ShareTheme)
    : 'default';

  const palette = PALETTES.includes(body.palette as SharePalette)
    ? (body.palette as SharePalette)
    : 'light';

  let expiresAt: string | null = null;
  if (body.expiresInDays !== undefined && body.expiresInDays !== null) {
    const days = Number(body.expiresInDays);
    if (!Number.isFinite(days) || days < 0 || days > 3650) {
      throw badRequest('有效期需在 0-3650 天之间');
    }
    if (days > 0) expiresAt = isoFromNow(days * 24 * 60 * 60 * 1000);
  }

  const id = newId();
  const ts = nowIso();

  await ctx.env.DB.prepare(
    `INSERT INTO shares
       (id, user_id, slug, title, description, tag_ids, match_all_tags,
        include_notes, theme, palette, is_active, view_count, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
  )
    .bind(
      id,
      userId,
      slug,
      title,
      body.description ? String(body.description).slice(0, 500) : null,
      JSON.stringify(tagIds),
      body.matchAllTags ? 1 : 0,
      body.includeNotes ? 1 : 0,
      theme,
      palette,
      ts,
      ts,
      expiresAt,
    )
    .run();

  const row = await ctx.env.DB.prepare(`SELECT * FROM shares WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<Record<string, unknown>>();

  createLogger(ctx.env).info('share.create', { userId, slug });
  return json(mapShare(row as Record<string, unknown>), { status: 201 });
};
