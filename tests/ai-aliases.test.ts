import { describe, expect, it } from 'vitest';
import type { AiConfig } from '../functions/_lib/ai/types';
import {
  applyAliases,
  buildAliasSuggestions,
  clusterSuggestionsByTopic,
  generateModelAliases,
  parseAliasResponse,
} from '../functions/_lib/ai/aliases';
import { buildVocabulary } from '../functions/_lib/ai/taxonomy';

function vocab(entries: Array<{ id: string; name: string; aliases?: string[]; count?: number }>) {
  return buildVocabulary(
    entries.map((e) => ({ id: e.id, name: e.name, aliases: e.aliases ?? [], count: e.count ?? 0 })),
  );
}

describe('buildAliasSuggestions (offline)', () => {
  it('proposes Latin variants for a CJK canonical tag', () => {
    const v = vocab([{ id: 't1', name: '前端', count: 5 }]);
    const out = buildAliasSuggestions(v.entries);
    const hit = out.find((s) => s.tagId === 't1');
    expect(hit).toBeDefined();
    // REVERSE_SYNONYMS['前端'] = [frontend, fe, 前端开发, 客户端]
    expect(hit!.aliases).toEqual(expect.arrayContaining(['frontend', 'fe', '前端开发', '客户端']));
    expect(hit!.reason).toContain('离线');
  });

  it('proposes the canonical + siblings when the tag is itself a synonym key', () => {
    const v = vocab([{ id: 't2', name: '前端开发', count: 1 }]);
    const out = buildAliasSuggestions(v.entries);
    const hit = out.find((s) => s.tagId === 't2');
    // canonical 前端 plus siblings, but never the tag's own name.
    expect(hit!.aliases).toContain('前端');
    expect(hit!.aliases).not.toContain('前端开发');
  });

  it('does not propose for tags that already carry enough aliases', () => {
    const v = vocab([{ id: 't3', name: '前端', aliases: ['frontend', 'fe', '客户端'], count: 3 }]);
    const out = buildAliasSuggestions(v.entries);
    expect(out.find((s) => s.tagId === 't3')).toBeUndefined();
  });

  it('produces nothing for a Latin tag with no synonym entry', () => {
    const v = vocab([{ id: 't4', name: 'Kubernetes', count: 4 }]);
    const out = buildAliasSuggestions(v.entries);
    expect(out.find((s) => s.tagId === 't4')).toBeUndefined();
  });

  it('caps proposals at maxAliases', () => {
    const v = vocab([{ id: 't5', name: '设计', count: 2 }]);
    const out = buildAliasSuggestions(v.entries, { maxAliases: 2 });
    const hit = out.find((s) => s.tagId === 't5');
    expect(hit!.aliases.length).toBeLessThanOrEqual(2);
  });
});

describe('clusterSuggestionsByTopic (pure)', () => {
  it('groups by topic, counts distinct bookmarks, collects distinct tags', () => {
    const rows = [
      { topic: '前端', tagName: 'React', bookmarkId: 'b1' },
      { topic: '前端', tagName: 'React', bookmarkId: 'b1' }, // duplicate
      { topic: '前端', tagName: 'Vue', bookmarkId: 'b2' },
      { topic: 'AI', tagName: 'LLM', bookmarkId: 'b3' },
      { topic: null, tagName: 'Other', bookmarkId: 'b4' },
    ];
    const clusters = clusterSuggestionsByTopic(rows);
    expect(clusters).toHaveLength(3);

    const fe = clusters.find((c) => c.topic === '前端')!;
    expect(fe.bookmarkCount).toBe(2);
    expect(fe.tagNames).toEqual(expect.arrayContaining(['React', 'Vue']));

    const uncat = clusters.find((c) => c.topic === '未分类')!;
    expect(uncat.bookmarkCount).toBe(1);
  });

  it('sorts by bookmark count descending', () => {
    const rows = [
      { topic: 'A', tagName: 'x', bookmarkId: 'b1' },
      { topic: 'B', tagName: 'y', bookmarkId: 'b2' },
      { topic: 'B', tagName: 'z', bookmarkId: 'b3' },
    ];
    const clusters = clusterSuggestionsByTopic(rows);
    expect(clusters[0].topic).toBe('B');
  });
});

describe('parseAliasResponse', () => {
  it('extracts the alias map and drops unknown tags', () => {
    const text = '```json\n{"aliases":{"前端":["frontend","fe"],"不存在":["x"]}}\n```';
    const out = parseAliasResponse(text, ['前端']);
    expect(out).toHaveLength(1);
    expect(out[0].tagName).toBe('前端');
    expect(out[0].aliases).toEqual(['frontend', 'fe']);
  });

  it('returns [] on malformed JSON', () => {
    expect(parseAliasResponse('not json at all', ['前端'])).toEqual([]);
  });
});

describe('applyAliases (DB-backed)', () => {
  function fakeEnv(initial: Record<string, { name: string; aliases: string[] }>) {
    const tags = new Map(Object.entries(initial));
    let lastUpdate: { id: string; json: string } | null = null;
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind(...args: unknown[]) {
              if (sql.startsWith('SELECT name, aliases')) {
                const [id] = args as [string, string];
                const row = tags.get(id);
                return {
                  first: async () =>
                    row ? { name: row.name, aliases: JSON.stringify(row.aliases) } : null,
                };
              }
              if (sql.startsWith('UPDATE tags')) {
                const [json, id, _userId] = args as [string, string, string];
                lastUpdate = { id, json };
                return { run: async () => ({}) };
              }
              return { first: async () => null, run: async () => ({}) };
            },
          };
        },
      },
      _lastUpdate: () => lastUpdate,
    };
    return env as unknown as { DB: any } & { _lastUpdate: () => typeof lastUpdate };
  }

  it('appends new aliases, dedupes against name and existing, returns updated count', async () => {
    const env = fakeEnv({ t1: { name: '前端', aliases: ['qianDuan'] } });
    const { updated } = await applyAliases(env as any, 'u1', [
      { tagId: 't1', aliases: ['frontend', '前端', 'react'] },
    ]);
    expect(updated).toBe(1);
    const written = JSON.parse(env._lastUpdate()!.json);
    // '前端' equals the tag name key → excluded; 'qianDuan' kept; frontend + react added.
    expect(written).toEqual(expect.arrayContaining(['qianDuan', 'frontend', 'react']));
    expect(written).not.toContain('前端');
  });

  it('is a no-op (updated 0) when nothing new', async () => {
    const env = fakeEnv({ t2: { name: 'React', aliases: ['react'] } });
    const { updated } = await applyAliases(env as any, 'u1', [
      { tagId: 't2', aliases: ['react'] },
    ]);
    expect(updated).toBe(0);
  });
});

describe('generateModelAliases', () => {
  const config: AiConfig = {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: 'sk-test',
    autoTag: true,
    autoSummarize: false,
    autoApplyThreshold: 1,
    heuristicsEnabled: true,
    maxTags: 4,
  };

  it('parses model output into suggestions', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ aliases: { 前端: ['frontend', 'fe'] } }) } }],
      }),
    })) as unknown as typeof fetch;

    const out = await generateModelAliases(config, ['前端'], fetchImpl);
    expect(out).toHaveLength(1);
    expect(out[0].tagName).toBe('前端');
    expect(out[0].aliases).toEqual(['frontend', 'fe']);
  });

  it('returns [] on a provider failure (degrade, do not throw)', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 500, text: async () => '' })) as unknown as typeof fetch;
    const out = await generateModelAliases(config, ['前端'], fetchImpl);
    expect(out).toEqual([]);
  });

  it('returns [] for an empty tag list', async () => {
    expect(await generateModelAliases(config, [])).toEqual([]);
  });
});
