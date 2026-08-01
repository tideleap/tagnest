import { describe, it, expect } from 'vitest';
import { assertEmailAllowed } from '../functions/_lib/signup';
import type { Env } from '../functions/_lib/env';

const withEnv = (overrides: Partial<Env> = {}): Env => overrides as Env;

describe('assertEmailAllowed (open-but-gated registration)', () => {
  it('allows anyone when ALLOWED_EMAILS is unset', () => {
    expect(() => assertEmailAllowed(withEnv(), 'anyone@example.com')).not.toThrow();
  });

  it('allows anyone when ALLOWED_EMAILS is empty/whitespace', () => {
    expect(() =>
      assertEmailAllowed(withEnv({ ALLOWED_EMAILS: '   ' }), 'anyone@example.com'),
    ).not.toThrow();
  });

  it('allows an exact email match (case-insensitive)', () => {
    expect(() =>
      assertEmailAllowed(
        withEnv({ ALLOWED_EMAILS: 'Alice@Example.com, bob@x.com' }),
        'alice@example.com',
      ),
    ).not.toThrow();
    expect(() =>
      assertEmailAllowed(withEnv({ ALLOWED_EMAILS: 'alice@example.com' }), 'ALICE@example.com'),
    ).not.toThrow();
  });

  it('rejects an exact email mismatch with 403', () => {
    let thrown: unknown;
    try {
      assertEmailAllowed(withEnv({ ALLOWED_EMAILS: 'alice@example.com' }), 'eve@gmail.com');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { status: number }).status).toBe(403);
    expect((thrown as { code: string }).code).toBe('signup_email_not_allowed');
  });

  it('honours a domain wildcard (*@domain)', () => {
    const env = withEnv({ ALLOWED_EMAILS: '*@corp.dev, alice@other.com' });
    expect(() => assertEmailAllowed(env, 'bob@corp.dev')).not.toThrow();
    expect(() => assertEmailAllowed(env, 'alice@other.com')).not.toThrow();
    expect(() => assertEmailAllowed(env, 'mallory@gmail.com')).toThrow();
    expect(() => assertEmailAllowed(env, 'carol@corp.dev.evil.com')).toThrow();
  });

  it('trims whitespace around entries', () => {
    expect(() =>
      assertEmailAllowed(
        withEnv({ ALLOWED_EMAILS: '  alice@example.com  ,  *@corp.dev ' }),
        'bob@corp.dev',
      ),
    ).not.toThrow();
  });
});
