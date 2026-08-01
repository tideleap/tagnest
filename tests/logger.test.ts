import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../functions/_lib/logger';

function capture() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { log, err };
}

function firstJson(spy: { mock: { calls: unknown[][] } }) {
  // console.*('[tagnest]', '<json>')
  return JSON.parse((spy.mock.calls[0] as unknown[])[1] as string);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createLogger', () => {
  it('emits a JSON line carrying level/event/ts/rid/props at info', () => {
    const c = capture();
    createLogger({}, 'req-1').info('user.signup', { userId: 'u1' });

    expect(c.log).toHaveBeenCalledTimes(1);
    const line = firstJson(c.log);
    expect(line.level).toBe('info');
    expect(line.event).toBe('user.signup');
    expect(line.rid).toBe('req-1');
    expect(line.props).toEqual({ userId: 'u1' });
    expect(typeof line.ts).toBe('string');
    expect(Number.isNaN(Date.parse(line.ts))).toBe(false);
  });

  it('filters debug when the threshold is info', () => {
    const c = capture();
    createLogger({ LOG_LEVEL: 'info' }, 'r').debug('verbose');
    expect(c.log).not.toHaveBeenCalled();
  });

  it('honors a lower threshold so debug is emitted', () => {
    const c = capture();
    createLogger({ LOG_LEVEL: 'debug' }, 'r').debug('verbose');
    expect(c.log).toHaveBeenCalledTimes(1);
  });

  it('routes error level to console.error and flattens an Error', () => {
    const c = capture();
    createLogger({}, 'r').error('request_error', new Error('boom'), { path: '/x' });

    expect(c.err).toHaveBeenCalledTimes(1);
    const line = firstJson(c.err);
    expect(line.level).toBe('error');
    expect(line.props.error).toBe('boom');
    expect(line.props.path).toBe('/x');
    expect(typeof line.props.stack).toBe('string');
  });

  it('omits rid when none is supplied', () => {
    const c = capture();
    createLogger({}).info('x');
    expect(firstJson(c.log).rid).toBeUndefined();
  });
});
