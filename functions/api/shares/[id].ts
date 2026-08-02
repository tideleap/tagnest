import type { SharePalette, ShareTheme } from '../../../shared/types';
import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, conflict, json, noContent, notFound, readJson } from '../../_lib/http';
import { isoFromNow, nowIso } from '../../_lib/ids';
import { PALETTES, THEMES, assertValidSlug, mapShare, normalizeSlug, purgeCache } from '../../_lib/shares';

async function loadOwned(ctx: EventContext<Env, string, RequestData>, userId: string) {
  const row = await ctx.env.DB.prepare(
    `SELECT * FROM shares WHERE id = ? AND user_id = ? LIMIT 1`,
  )
    .bind(String(ctx.params.id), userId)
    .first<Record<string, unknown>>();
  if (!row) throw notFound('分享页不存在');
  return row;
}

export const onRequestPatch: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const row = await loadOwned(ctx, userId);
  const current = mapShare(row);
  const body = await readJson<Record<string, unknown>>(ctx.request);

  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [nowIso()];
  let nextSlug = current.slug;

  if ('title' in body) {
    const title = String(body.title ?? '').trim().slice(0, 120);
    if (!title) throw badRequest('标题不能为空', { title: '请填写标题' });
    sets.push('title = ?');
    params.push(title);
  }

  if ('slug' in body) {
    const slug = normalizeSlug(String(body.slug ?? ''));
    assertValidSlug(slug);
    if (slug !== current.slug) {
      const taken = await ctx.env.DB.prepare(
        `SELECT id FROM shares WHERE slug = ? AND id != ? LIMIT 1`,
      )
        .bind(slug, current.id)
        .first<{ id: string }>();
      if (taken) throw conflict('该链接后缀已被使用', { slug: '已被占用' });
      sets.push('slug = ?');
      params.push(slug);
      nextSlug = slug;
    }
  }

  if ('description' in body) {
    sets.push('description = ?');
    params.push(body.description ? String(body.description).slice(0, 500) : null);
  }

  if ('tagIds' in body) {
    const tagIds = Array.isArray(body.tagIds)
      ? [...new Set(body.tagIds.map(String).filter(Boolean))].slice(0, 20)
      : [];
    sets.push('tag_ids = ?');
    params.push(JSON.stringify(tagIds));
  }

  if ('matchAllTags' in body) {
    sets.push('match_all_tags = ?');
    params.push(body.matchAllTags ? 1 : 0);
  }

  if ('includeNotes' in body) {
    sets.push('include_notes = ?');
    params.push(body.includeNotes ? 1 : 0);
  }

  if ('theme' in body) {
    if (!THEMES.includes(body.theme as ShareTheme)) throw badRequest('未知的展示样式');
    sets.push('theme = ?');
    params.push(body.theme);
  }

  if ('palette' in body) {
    if (!PALETTES.includes(body.palette as SharePalette)) throw badRequest('未知的主题配色');
    sets.push('palette = ?');
    params.push(body.palette);
  }

  if ('isActive' in body) {
    sets.push('is_active = ?');
    params.push(body.isActive ? 1 : 0);
  }

  if ('expiresInDays' in body) {
    const raw = body.expiresInDays;
    if (raw === null) {
      sets.push('expires_at = ?');
      params.push(null);
    } else {
      const days = Number(raw);
      if (!Number.isFinite(days) || days < 0 || days > 3650) {
        throw badRequest('有效期需在 0-3650 天之间');
      }
      sets.push('expires_at = ?');
      params.push(days > 0 ? isoFromNow(days * 24 * 60 * 60 * 1000) : null);
    }
  }

  params.push(current.id, userId);
  await ctx.env.DB.prepare(
    `UPDATE shares SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`,
  )
    .bind(...params)
    .run();

  // Both the old and new slug are purged: renaming leaves a stale entry under
  // the previous key that would otherwise keep serving for its full TTL.
  await purgeCache(ctx.env, current.slug);
  if (nextSlug !== current.slug) await purgeCache(ctx.env, nextSlug);

  const updated = await ctx.env.DB.prepare(`SELECT * FROM shares WHERE id = ? LIMIT 1`)
    .bind(current.id)
    .first<Record<string, unknown>>();

  return json(mapShare(updated as Record<string, unknown>));
};

export const onRequestDelete: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const row = await loadOwned(ctx, userId);
  const share = mapShare(row);

  await ctx.env.DB.prepare(`DELETE FROM shares WHERE id = ? AND user_id = ?`)
    .bind(share.id, userId)
    .run();

  await purgeCache(ctx.env, share.slug);
  return noContent();
};
