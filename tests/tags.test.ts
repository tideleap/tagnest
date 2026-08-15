import { describe, it, expect } from 'vitest';
import type { Env } from '../functions/_lib/env';
import { onRequestPost as createTag } from '../functions/api/tags/index';
import { MockDb, makeEnv } from './_support/dbMock';

const USER = 'u1';

function makeCtx(env: Env, userId: string, body?: unknown) {
  const init: RequestInit = { method: 'POST' };
  if (body !== undefined) init.body = JSON.stringify(body);
  return {
    request: new Request('https://tagnest.test/api/tags', init),
    env,
    data: { userId },
    params: {},
  } as any;
}

describe('POST /api/tags', () => {
  it('creates a tag and returns 201', async () => {
    const env = makeEnv();
    const res = await createTag(makeCtx(env, USER, { name: '  前端  ' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string; count: number };
    expect(body.name).toBe('前端'); // trimmed
    expect(body.count).toBe(0);
    expect((env.DB as MockDb).tags).toHaveLength(1);
  });

  it('rejects an empty name with 400', async () => {
    const env = makeEnv();
    await expect(createTag(makeCtx(env, USER, { name: '   ' }))).rejects.toMatchObject({
      status: 400,
    });
  });

  it('race backstop: INSERT OR IGNORE yields no row for a duplicate name', async () => {
    // The mock does not recognise the single-name pre-check SELECT, so it
    // returns null and the handler falls through to the INSERT — exactly the
    // window a concurrent duplicate would hit. The unique index backstop
    // (migration 0001) then refuses the second row and the handler maps that
    // to a 409 instead of a raw constraint error.
    const env = makeEnv();
    const db = env.DB as MockDb;
    db.tags.push({
      id: 't1',
      user_id: USER,
      name: '前端',
      color_index: 0,
      parent_id: null,
      sort_order: 0,
      created_at: '2026-01-01T00:00:00Z',
    });
    await expect(createTag(makeCtx(env, USER, { name: '前端' }))).rejects.toMatchObject({
      status: 409,
    });
    expect(db.tags).toHaveLength(1); // no duplicate written
  });
});
