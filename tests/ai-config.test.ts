import { describe, expect, it } from 'vitest';
import type { Env } from '../functions/_lib/env';
import { isModelReady, loadAiConfig, loadConfigRow, parseAliases } from '../functions/_lib/ai';
import type { ConfigRow } from '../functions/_lib/ai/config';
import { createAiDb, type SettingsRow } from './helpers/aiDb';

function baseRow(overrides: Partial<SettingsRow> = {}): SettingsRow {
  return {
    user_id: 'u1',
    provider: 'openai',
    base_url: null,
    model: 'gpt-4o-mini',
    api_key_encrypted: 'sk-live-key', // legacy cleartext: decryptField returns as-is
    auto_tag: 1,
    auto_summarize: 1,
    auto_apply_threshold: 1,
    heuristics_enabled: 1,
    max_tags: 4,
    ...overrides,
  };
}

function envWith(row: SettingsRow | null): Env {
  const { db } = createAiDb({ ai_settings: row ? [row] : [] });
  return { DB: db as never };
}

describe('isModelReady — the five gates', () => {
  const ready: ConfigRow = {
    provider: 'openai',
    baseUrl: null,
    model: 'gpt-4o-mini',
    apiKey: 'sk-x',
    autoTag: true,
    autoSummarize: false,
    autoApplyThreshold: 1,
    maxTags: 4,
  };

  it('is ready when provider + model + key + at least one toggle are present', () => {
    expect(isModelReady(ready)).toBe(true);
  });

  it('gate 1: no provider selected', () => {
    expect(isModelReady({ ...ready, provider: 'none' })).toBe(false);
  });

  it('gate 2: blank model', () => {
    expect(isModelReady({ ...ready, model: '' })).toBe(false);
    expect(isModelReady({ ...ready, model: '   ' })).toBe(false);
  });

  it('gate 3: missing api key', () => {
    expect(isModelReady({ ...ready, apiKey: null })).toBe(false);
    expect(isModelReady({ ...ready, apiKey: '' })).toBe(false);
  });

  it('gate 4: one automation toggle is enough', () => {
    expect(isModelReady({ ...ready, autoTag: true, autoSummarize: false })).toBe(true);
    expect(isModelReady({ ...ready, autoTag: false, autoSummarize: true })).toBe(true);
  });

  it('gate 5: both automation toggles off means the model would do nothing', () => {
    expect(isModelReady({ ...ready, autoTag: false, autoSummarize: false })).toBe(false);
  });
});

describe('loadConfigRow — defaults and mapping', () => {
  it('returns safe defaults when no row exists', async () => {
    const row = await loadConfigRow(envWith(null), 'u1');
    expect(row.provider).toBe('none');
    expect(row.autoTag).toBe(false);
    expect(row.maxTags).toBe(4);
  });

  it('decrypts a legacy cleartext key and maps all columns', async () => {
    const row = await loadConfigRow(envWith(baseRow({ auto_summarize: 0, max_tags: 6 })), 'u1');
    expect(row.apiKey).toBe('sk-live-key');
    expect(row.autoTag).toBe(true);
    expect(row.autoSummarize).toBe(false);
    expect(row.maxTags).toBe(6);
  });
});

describe('loadAiConfig — the gate that killed the silent "AI ready" bug', () => {
  it('returns a config when all five gates pass', async () => {
    const cfg = await loadAiConfig(envWith(baseRow()), 'u1');
    expect(cfg).not.toBeNull();
    expect(cfg!.model).toBe('gpt-4o-mini');
  });

  it('returns null (not an error) when a gate fails — this is the fallback, not a crash', async () => {
    expect(await loadAiConfig(envWith(baseRow({ api_key_encrypted: null })), 'u1')).toBeNull();
    expect(await loadAiConfig(envWith(baseRow({ provider: 'none' })), 'u1')).toBeNull();
    expect(
      await loadAiConfig(envWith(baseRow({ auto_tag: 0, auto_summarize: 0 })), 'u1'),
    ).toBeNull();
  });
});

describe('parseAliases', () => {
  it('parses a JSON array of strings', () => {
    expect(parseAliases('["a","b"]')).toEqual(['a', 'b']);
  });
  it('treats empty / non-array / unparseable as none', () => {
    expect(parseAliases('')).toEqual([]);
    expect(parseAliases('not json')).toEqual([]);
    expect(parseAliases('{"a":1}')).toEqual([]);
    expect(parseAliases(null)).toEqual([]);
  });
});
