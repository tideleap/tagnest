import { describe, it, expect } from 'vitest';
import { describeImportError } from '../src/lib/import-error';
import { HttpError } from '../src/lib/api';

describe('describeImportError (front-end mapping)', () => {
  it('maps import_empty_parse to an actionable empty-parse message', () => {
    const info = describeImportError(new HttpError(400, 'import_empty_parse', '未能解析'));
    expect(info.title).toContain('未解析到书签');
    expect(info.kind).toBe('empty_parse');
    expect(info.hint.length).toBeGreaterThan(0);
  });

  it('maps import_unreadable (server-side unexpected) clearly, not "服务器内部错误"', () => {
    const info = describeImportError(new HttpError(400, 'import_unreadable', '无法读取'));
    expect(info.title).toContain('无法读取文件');
    expect(info.kind).toBe('unreadable');
    // It must NOT be the bland generic fallback.
    expect(info.title).not.toContain('服务器内部错误');
  });

  it('maps payload_too_large', () => {
    const info = describeImportError(new HttpError(413, 'payload_too_large', '文件超过 20 MB'));
    expect(info.kind).toBe('too_large');
    expect(info.title).toContain('文件过大');
  });

  it('maps timeout/network to a retry hint', () => {
    const info = describeImportError(new HttpError(0, 'network_error', '网络连接失败'));
    expect(info.kind).toBe('timeout');
  });

  it('maps an unexpected 500 to a retryable server hint', () => {
    const info = describeImportError(new HttpError(500, 'internal_error', '服务器内部错误'));
    expect(info.kind).toBe('unreadable');
    expect(info.title).toContain('服务器暂时不可用');
  });

  it('falls through to a common hint for unknown errors', () => {
    const info = describeImportError(new Error('boom'));
    expect(info.kind).toBe('common');
    expect(info.detail).toBe('boom');
  });
});
