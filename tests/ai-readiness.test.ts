import { describe, it, expect } from 'vitest';
import { aiReadiness } from '../src/lib/ai-readiness';

const base = {
  provider: 'openai' as const,
  hasApiKey: true,
  tempKeyPresent: false,
  model: 'gpt-4o-mini',
  autoTag: true,
  autoSummarize: true,
};

describe('aiReadiness', () => {
  it('returns empty (ready) when everything is configured', () => {
    expect(aiReadiness(base)).toEqual([]);
  });

  it('reports unset provider', () => {
    expect(aiReadiness({ ...base, provider: 'none' })).toContain('未选择服务商');
  });

  it('reports missing model', () => {
    expect(aiReadiness({ ...base, model: null })).toContain('未填写模型名称');
    expect(aiReadiness({ ...base, model: '' })).toContain('未填写模型名称');
  });

  it('reports missing key unless one is saved or typed', () => {
    expect(aiReadiness({ ...base, hasApiKey: false })).toContain('未配置 API Key');
    expect(aiReadiness({ ...base, hasApiKey: false, tempKeyPresent: true })).not.toContain(
      '未配置 API Key',
    );
  });

  it('reports both automation switches off', () => {
    expect(aiReadiness({ ...base, autoTag: false, autoSummarize: false })).toContain(
      '自动摘要/自动打标签均未开启',
    );
  });

  it('is ready when only one automation switch is on', () => {
    expect(aiReadiness({ ...base, autoTag: false })).toEqual([]);
    expect(aiReadiness({ ...base, autoSummarize: false })).toEqual([]);
  });

  it('collects multiple missing items at once', () => {
    const missing = aiReadiness({ ...base, provider: 'none', model: null, hasApiKey: false });
    expect(missing).toEqual(
      expect.arrayContaining(['未选择服务商', '未填写模型名称', '未配置 API Key']),
    );
  });
});
