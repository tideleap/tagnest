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

  it('maps import_parse to a format-specific hint (not a bland generic)', () => {
    const info = describeImportError(new HttpError(400, 'import_parse', '未能解析该 HTML'));
    expect(info.kind).toBe('parse');
    expect(info.title).toContain('文件格式无法识别');
    expect(info.hint).toContain('重新导出');
  });

  it('maps import_read (file could not be read) distinctly from a parse problem', () => {
    const info = describeImportError(new HttpError(400, 'import_read', '读取文件失败'));
    expect(info.kind).toBe('read');
    expect(info.title).toContain('读取文件失败');
    expect(info.hint).toContain('损坏');
  });

  it('maps import_unreadable (server-side unexpected) clearly, not "服务器内部错误"', () => {
    const info = describeImportError(new HttpError(400, 'import_unreadable', '无法处理'));
    expect(info.title).toContain('服务器无法处理该文件');
    expect(info.kind).toBe('unreadable');
    // It must NOT be the bland generic fallback.
    expect(info.title).not.toContain('服务器内部错误');
    expect(info.title).not.toContain('导入失败');
  });

  it('maps import_db_unavailable to a server-retry hint that does not blame the file', () => {
    const info = describeImportError(new HttpError(503, 'import_db_unavailable', 'DB failed'));
    expect(info.kind).toBe('db');
    expect(info.title).toContain('服务器暂时不可用');
    expect(info.hint).toContain('无需修改文件');
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
    expect(info.kind).toBe('db');
    expect(info.title).toContain('服务器暂时不可用');
  });

  it('falls through to a common hint for unknown errors', () => {
    const info = describeImportError(new Error('boom'));
    expect(info.kind).toBe('common');
    expect(info.detail).toBe('boom');
    expect(info.hint).not.toContain('请检查文件内容');
  });

  it('maps import_network to a network blip (not "数据库不可用")', () => {
    const info = describeImportError(new HttpError(503, 'import_network', 'fetch failed'));
    expect(info.kind).toBe('timeout');
    expect(info.title).toContain('网络');
    // Must NOT blame the database or tell the user their file is broken.
    expect(info.title).not.toContain('数据库');
    expect(info.title).not.toContain('文件');
    expect(info.hint).toContain('稍等');
  });
});
