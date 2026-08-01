import { describe, expect, it } from 'vitest';
import { probeHealth } from '../functions/_lib/health';
import type { Env } from '../functions/_lib/env';

function makeDb(ok: boolean) {
  return {
    prepare: () => ({
      first: async () => {
        if (!ok) throw new Error('connection refused');
        return {};
      },
    }),
  } as unknown as Env['DB'];
}

describe('probeHealth', () => {
  it('reports ok when every component is wired', async () => {
    const env = {
      DB: makeDb(true),
      SHARE_CACHE: {} as Env['SHARE_CACHE'],
      JWT_SECRET: 'x',
    } as Env;

    const r = await probeHealth(env);
    expect(r.status).toBe('ok');
    expect(r.checks.database).toBe('ok');
    expect(r.checks.shareCache).toBe('ok');
    expect(r.checks.auth).toBe('ok');
    expect(typeof r.timestamp).toBe('string');
  });

  it('reports degraded with an error detail when DB fails', async () => {
    const env = {
      DB: makeDb(false),
      SHARE_CACHE: {} as Env['SHARE_CACHE'],
      JWT_SECRET: 'x',
    } as Env;

    const r = await probeHealth(env);
    expect(r.status).toBe('degraded');
    expect(r.checks.database).toMatch(/^error:/);
  });

  it('reports missing for unbound KV and absent secret', async () => {
    const env = { DB: makeDb(true) } as Env;

    const r = await probeHealth(env);
    expect(r.status).toBe('degraded');
    expect(r.checks.shareCache).toBe('missing');
    expect(r.checks.auth).toBe('missing');
  });
});
