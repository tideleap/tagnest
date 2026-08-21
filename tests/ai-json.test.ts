import { describe, expect, it } from 'vitest';
import {
  extractJsonValue,
  parseCoarseResponse,
  parseTaggingResponse,
} from '../functions/_lib/ai/prompt';

/**
 * P0-2 regression suite: these are the exact failure modes that silently dropped
 * whole batches under the old `indexOf('{')`/`lastIndexOf('}')` parser.
 *
 *  - array-root responses             -> `[{…},{…}]`
 *  - markdown fences + surrounding prose
 *  - full-width brackets/colon (Chinese models)
 *  - trailing commas before `}`/`]`
 *  - brackets inside string values (URLs, etc.)
 */

describe('extractJsonValue — robust slicing (P0-2)', () => {
  it('returns an object root verbatim', () => {
    const v = extractJsonValue('{"results":[{"i":1}]}');
    expect(v).toEqual({ results: [{ i: 1 }] });
  });

  it('extracts a bare array-root', () => {
    const v = extractJsonValue('[{"i":1,"tags":[]},{"i":2,"tags":[]}]');
    expect(Array.isArray(v)).toBe(true);
    expect((v as unknown[]).length).toBe(2);
  });

  it('strips a ```json fence and leading prose', () => {
    const raw = '好的，这是结果：\n```json\n{"results":[{"i":1,"tags":[{"name":"前端"}]}]}\n```';
    const v = extractJsonValue(raw);
    expect(v).toEqual({ results: [{ i: 1, tags: [{ name: '前端' }] }] });
  });

  it('finds the JSON when prose trails it', () => {
    const raw = '{"results":[{"i":1}]} 希望这对你有帮助！';
    const v = extractJsonValue(raw);
    expect(v).toEqual({ results: [{ i: 1 }] });
  });

  it('normalises full-width brackets and full-width colon', () => {
    // A model that emits ［］｛｝： instead of [] {} :
    const raw = '｛"results"：［{"i"：1}］｝';
    const v = extractJsonValue(raw);
    expect(v).toEqual({ results: [{ i: 1 }] });
  });

  it('repairs trailing commas before a closing bracket', () => {
    const raw = '{"results":[{"i":1,"tags":[],},],}';
    const v = extractJsonValue(raw);
    expect(v).toEqual({ results: [{ i: 1, tags: [] }] });
  });

  it('does not treat brackets inside strings as structure', () => {
    const raw = '{"url":"https://x.com/a{b}c","i":1}';
    const v = extractJsonValue(raw);
    expect(v).toEqual({ url: 'https://x.com/a{b}c', i: 1 });
  });

  it('ignores a leading BOM and non-breaking spaces', () => {
    const raw = '﻿ {"results":[{"i":1}]}';
    const v = extractJsonValue(raw);
    expect(v).toEqual({ results: [{ i: 1 }] });
  });

  it('returns null when there is no JSON at all', () => {
    expect(extractJsonValue('抱歉，我无法完成该请求。')).toBeNull();
    expect(extractJsonValue('')).toBeNull();
    expect(extractJsonValue(null)).toBeNull();
  });
});

describe('parseTaggingResponse — array-root acceptance (P0-2)', () => {
  it('parses the documented {results:[...]} shape', () => {
    const out = parseTaggingResponse('{"results":[{"i":1,"tags":[{"name":"前端","confidence":0.9,"reason":"r"}],"topic":"前端框架"}]}', 1);
    expect(out).toHaveLength(1);
    expect(out[0].tags[0].name).toBe('前端');
    expect(out[0].topic).toBe('前端框架');
  });

  it('parses a bare array-root [{...},{...}]', () => {
    const raw = '[{"i":1,"tags":[{"name":"前端"}]},{"i":2,"tags":[{"name":"后端"}]}]';
    const out = parseTaggingResponse(raw, 2);
    expect(out).toHaveLength(2);
    expect(out[0].tags[0].name).toBe('前端');
    expect(out[1].tags[0].name).toBe('后端');
  });

  it('maps 1-based indices back to 0-based and drops out-of-range items', () => {
    const raw = '{"results":[{"i":1,"tags":[{"name":"a"}]},{"i":99,"tags":[{"name":"bad"}]}]}';
    const out = parseTaggingResponse(raw, 2);
    expect(out).toHaveLength(1);
    expect(out[0].index).toBe(0);
  });

  it('returns [] on malformed / non-JSON text', () => {
    expect(parseTaggingResponse('根本不是 JSON', 3)).toEqual([]);
    expect(parseTaggingResponse(null, 3)).toEqual([]);
  });
});

describe('parseCoarseResponse — array-root acceptance (P0-2)', () => {
  it('parses the documented {results:[...]} shape', () => {
    const out = parseCoarseResponse('{"results":[{"i":1,"topic":"前端框架"},{"i":2,"topic":"机器学习"}]}', 2);
    expect(out).toEqual(['前端框架', '机器学习']);
  });

  it('parses a bare array-root and aligns by index', () => {
    const out = parseCoarseResponse('[{"i":1,"topic":"前端框架"},{"i":2,"topic":"机器学习"}]', 2);
    expect(out).toEqual(['前端框架', '机器学习']);
  });

  it('fills null for missing indices and ignores non-string topics', () => {
    const out = parseCoarseResponse('{"results":[{"i":2,"topic":"机器学习"},{"i":1,"topic":null}]}', 3);
    expect(out).toEqual([null, '机器学习', null]);
  });
});
