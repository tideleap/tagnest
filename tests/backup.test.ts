import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Env } from '../functions/_lib/env';
import { onRequestGet as listTargets, onRequestPut as upsertTarget } from '../functions/api/backup/targets';
import { onRequestDelete as deleteTarget } from '../functions/api/backup/targets/[id]';
import { onRequestPost as runBackup } from '../functions/api/backup/run';
import { onRequestGet as listRuns } from '../functions/api/backup/runs';
import { MockDb, makeEnv } from './_support/dbMock';

const USER = 'u1';
const OTHER = 'u2';

function makeCtx(env: Env, userId: string, body?: unknown) {
  const init: RequestInit = { method: 'POST' };
  if (body !== undefined) init.body = JSON.stringify(body);
  return {
    request: new Request('https://tagnest.test/api/backup/targets', init),
    env,
    data: { userId },
    params: {},
  } as any;
}

function makeGetCtx(env: Env, userId: string, url: string) {
  return {
    request: new Request(url, { method: 'GET' }),
    env,
    data: { userId },
    params: {},
  } as any;
}

function deleteCtx(env: Env, userId: string, id: string) {
  return {
    request: new Request(`https://tagnest.test/api/backup/targets/${id}`, { method: 'DELETE' }),
    env,
    data: { userId },
    params: { id },
  } as any;
}

let env: Env;
let db: MockDb;

beforeEach(() => {
  env = makeEnv();
  // crypto.encryptField derives its key from JWT_SECRET; give the test env one.
  (env as any).JWT_SECRET = 'test-secret-min-16-bytes!!';
  db = env.DB as MockDb;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 200 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('backup targets', () => {
  it('stores the secret encrypted, never in plaintext, and hides it on read', async () => {
    const res = await upsertTarget(makeCtx(env, USER, { kind: 'webdav', endpoint: 'https://dav.example.com/', secret: 'hunter2' }));
    const body = (await res.json()) as any;
    expect(body.id).toBeTruthy();
    expect(body.kind).toBe('webdav');
    expect(body).not.toHaveProperty('encrypted_secret');
    expect(body).not.toHaveProperty('secret');

    const list = await listTargets(makeGetCtx(env, USER, 'https://tagnest.test/api/backup/targets'));
    const listBody = (await list.json()) as any[];
    expect(listBody).toHaveLength(1);
    expect(listBody[0]).not.toHaveProperty('encrypted_secret');

    const row = db.backupTargets.find((t) => t.id === body.id)!;
    expect(String(row.encrypted_secret).startsWith('v1.')).toBe(true);
    expect(String(row.encrypted_secret)).not.toContain('hunter2');
  });

  it('keeps the stored secret when omitted on update', async () => {
    const created = await upsertTarget(makeCtx(env, USER, { kind: 'webdav', endpoint: 'https://dav/', secret: 'a' }));
    const id = (await created.json()).id;
    await upsertTarget(makeCtx(env, USER, { id, kind: 'webdav', endpoint: 'https://dav2/' }));
    const row = db.backupTargets.find((t) => t.id === id)!;
    expect(String(row.encrypted_secret).startsWith('v1.')).toBe(true);
    expect(row.endpoint).toBe('https://dav2/');
  });

  it('rejects an invalid kind', async () => {
    await expect(upsertTarget(makeCtx(env, USER, { kind: 'ftp' as any, endpoint: 'x' }))).rejects.toMatchObject({ status: 400 });
  });

  it('isolates targets per user (delete by another user 404s)', async () => {
    const created = await upsertTarget(makeCtx(env, USER, { kind: 'webdav', endpoint: 'https://dav/', secret: 'pw' }));
    const id = (await created.json()).id;
    await expect(deleteTarget(deleteCtx(env, OTHER, id))).rejects.toMatchObject({ status: 404 });
    expect(db.backupTargets.find((t) => t.id === id)).toBeDefined();
  });
});

describe('backup run', () => {
  it('pushes to an enabled webdav target and records a successful run', async () => {
    await upsertTarget(makeCtx(env, USER, { kind: 'webdav', endpoint: 'https://dav/', username: 'me', secret: 'pw' }));
    const res = await runBackup(makeCtx(env, USER, {}));
    const body = (await res.json()) as any;
    expect(body.results).toHaveLength(1);
    expect(body.results[0].status).toBe('ok');
    expect(db.backupRuns).toHaveLength(1);
    expect(db.backupRuns[0].status).toBe('ok');
    expect(db.backupRuns[0].bytes).toBeGreaterThan(0);
    expect(db.backupTargets[0].last_status).toBe('ok');

    const calls = (globalThis.fetch as any).mock.calls;
    expect(calls.some((c: any[]) => c[1]?.method === 'PUT')).toBe(true);
  });

  it('records a failed run when the remote rejects the push', async () => {
    await upsertTarget(makeCtx(env, USER, { kind: 'webdav', endpoint: 'https://dav/', secret: 'pw' }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
    const res = await runBackup(makeCtx(env, USER, {}));
    const body = (await res.json()) as any;
    expect(body.results[0].status).toBe('failed');
    expect(db.backupRuns[0].status).toBe('failed');
    expect(db.backupTargets[0].last_status).toBe('failed');
  });

  it('only pushes enabled targets', async () => {
    await upsertTarget(makeCtx(env, USER, { kind: 'webdav', endpoint: 'https://dav/', secret: 'pw', enabled: false }));
    const res = await runBackup(makeCtx(env, USER, {}));
    const body = (await res.json()) as any;
    expect(body.results).toHaveLength(0);
    expect(db.backupRuns).toHaveLength(0);
  });

  it('deletes a target and cascades to its run history', async () => {
    const created = await upsertTarget(makeCtx(env, USER, { kind: 'webdav', endpoint: 'https://dav/', secret: 'pw' }));
    const id = (await created.json()).id;
    await runBackup(makeCtx(env, USER, {}));
    expect(db.backupRuns).toHaveLength(1);
    await deleteTarget(deleteCtx(env, USER, id));
    expect(db.backupTargets.find((t) => t.id === id)).toBeUndefined();
    expect(db.backupRuns).toHaveLength(0);
  });

  it('lists run history with target kind and endpoint', async () => {
    await upsertTarget(makeCtx(env, USER, { kind: 's3', endpoint: 'https://s3.x.com', bucket: 'b', username: 'ak', secret: 'sk' }));
    await runBackup(makeCtx(env, USER, {}));
    const res = await listRuns(makeGetCtx(env, USER, 'https://tagnest.test/api/backup/runs'));
    const runs = (await res.json()) as any[];
    expect(runs).toHaveLength(1);
    expect(runs[0].kind).toBe('s3');
    expect(runs[0].endpoint).toBe('https://s3.x.com');
  });
});
