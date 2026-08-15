import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, conflict, json, readJson } from '../../_lib/http';
import { newId, nowIso } from '../../_lib/ids';
import { colorForName } from '../../_lib/db';
import { mapCollection } from '../../_lib/collections';
import { TAG_COLOR_COUNT } from '../../../shared/types';

export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);

  // LEFT JOIN keeps empty collections in the list; the count column drives
  // the badge on the collection card.
  const rows = await ctx.env.DB.prepare(
    `SELECT c.id, c.name, c.color_index, c.created_at, c.updated_at,
            COUNT(cb.bookmark_id) AS count
       FROM collections c
       LEFT JOIN collection_bookmarks cb ON cb.collection_id = c.id
      WHERE c.user_id = ?
      GROUP BY c.id
      ORDER BY c.name COLLATE NOCASE`,
  )
    .bind(userId)
    .all<Record<string, unknown>>();

  return json({ items: rows.results.map(mapCollection), total: rows.results.length });
};

export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const body = await readJson<{ name?: string; colorIndex?: number }>(ctx.request);

  const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw badRequest('请输入集合名称', { name: '请输入集合名称' });
  if (name.length > 60) throw badRequest('集合名称过长', { name: '集合名称不能超过 60 个字符' });

  const existing = await ctx.env.DB.prepare(
    `SELECT id FROM collections WHERE user_id = ? AND name COLLATE NOCASE = ? LIMIT 1`,
  )
    .bind(userId, name)
    .first<{ id: string }>();
  if (existing) throw conflict('集合已存在', { name: '集合已存在' });

  // A colour is optional; when omitted we derive a stable one from the name so
  // collections are visually distinguishable without forcing a colour picker.
  const colorIndex =
    Number.isInteger(body.colorIndex) && (body.colorIndex as number) >= 0
      ? (body.colorIndex as number) % TAG_COLOR_COUNT
      : colorForName(name);

  const id = newId();
  const ts = nowIso();

  // The pre-check above is the fast path; the unique index on
  // (user_id, name COLLATE NOCASE) added in migration 0017 is the backstop.
  // `INSERT OR IGNORE` + `RETURNING id` means the loser of two concurrent
  // creates for the same name gets no row back, and we surface a 409 exactly
  // like the pre-check instead of a raw constraint error.
  const inserted = await ctx.env.DB.prepare(
    `INSERT OR IGNORE INTO collections (id, user_id, name, color_index, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     RETURNING id`,
  )
    .bind(id, userId, name, colorIndex, ts, ts)
    .first<{ id: string }>();

  if (!inserted) throw conflict('集合已存在', { name: '集合已存在' });

  return json(
    mapCollection({ id, name, color_index: colorIndex, created_at: ts, updated_at: ts, count: 0 }),
    { status: 201 },
  );
};
