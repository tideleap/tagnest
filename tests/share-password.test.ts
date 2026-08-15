/**
 * Contract tests for share password protection (B-4 / H1).
 *
 * A password-protected share answers 401 (needs a password) or 403 (wrong
 * password) until the visitor presents the correct one via the
 * `X-Share-Password` header. Open shares are unaffected. The hash is produced
 * with the same PBKDF2 helper the login path uses, so verification is real.
 */
import { describe, it, expect } from 'vitest';
import { onRequestGet as publicEndpoint } from '../functions/api/public/[slug]';
import { hashPassword } from '../functions/_lib/auth';
import { MockDb, makeEnv } from './_support/dbMock';

const USER = 'u-share';

function seedShare(
  db: MockDb,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  const row = {
    id: 'sh1',
    user_id: USER,
    slug: 'reading',
    title: '阅读清单',
    description: null,
    tag_ids: '[]',
    match_all_tags: 0,
    include_notes: 0,
    theme: 'default',
    palette: 'light',
    is_active: 1,
    view_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    expires_at: null,
    password_hash: null,
    collection_id: null,
    ...over,
  };
  db.shares.push(row);
  return row;
}

function makeCtx(env: any, slug: string, password?: string) {
  const headers = new Headers();
  if (password !== undefined) headers.set('X-Share-Password', password);
  return {
    request: new Request(`https://tagnest.test/api/public/${slug}`, { headers }),
    env,
    params: { slug },
    waitUntil: () => {},
  } as any;
}

describe('share password gate (GET /api/public/:slug)', () => {
  it('answers 401 with requiresPassword when no password is presented', async () => {
    const db = new MockDb();
    const env = makeEnv({ DB: db });
    seedShare(db, { password_hash: await hashPassword('s3cret', env) });

    await expect(publicEndpoint(makeCtx(env, 'reading'))).rejects.toMatchObject({
      status: 401,
      code: 'share_password_required',
    });
  });

  it('answers 403 for a wrong password', async () => {
    const db = new MockDb();
    const env = makeEnv({ DB: db });
    seedShare(db, { password_hash: await hashPassword('s3cret', env) });

    await expect(publicEndpoint(makeCtx(env, 'reading', 'wrong'))).rejects.toMatchObject({
      status: 403,
      code: 'share_password_invalid',
    });
  });

  it('renders the share for the correct password', async () => {
    const db = new MockDb();
    const env = makeEnv({ DB: db });
    db.users.push({ id: USER, display_name: '分享者' });
    seedShare(db, { password_hash: await hashPassword('s3cret', env) });

    const res = await publicEndpoint(makeCtx(env, 'reading', 's3cret'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe('阅读清单');
    // Password-gated bodies must not be cached at the edge.
    expect(res.headers.get('Cache-Control')).not.toContain('public');
  });

  it('leaves open shares fully public (no gate, cacheable)', async () => {
    const db = new MockDb();
    const env = makeEnv({ DB: db });
    db.users.push({ id: USER, display_name: '分享者' });
    seedShare(db); // password_hash stays null

    const res = await publicEndpoint(makeCtx(env, 'reading'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('public');
  });

  it('still 404s a disabled share even with the right password', async () => {
    const db = new MockDb();
    const env = makeEnv({ DB: db });
    seedShare(db, { is_active: 0, password_hash: await hashPassword('s3cret', env) });

    await expect(publicEndpoint(makeCtx(env, 'reading', 's3cret'))).rejects.toMatchObject({
      status: 404,
    });
  });
});
