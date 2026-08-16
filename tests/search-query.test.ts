// tests/search-query.test.ts
//
// S1 — search syntax. `parseSearchQuery` (functions/_lib/db.ts) splits a free
// search string into bare text tokens plus `tag:` / `domain:` filters. It is the
// parser behind the MVP P0 search syntax; these tests lock in the contract so a
// later refactor of the FTS/LIKE strategy cannot silently break the syntax.

import { describe, it, expect } from 'vitest';
import { parseSearchQuery } from '../functions/_lib/db';

describe('parseSearchQuery', () => {
  it('treats bare words as AND tokens', () => {
    const r = parseSearchQuery('react hooks');
    expect(r.tokens).toEqual(['react', 'hooks']);
    expect(r.tags).toEqual([]);
    expect(r.domains).toEqual([]);
  });

  it('keeps a quoted phrase as a single token', () => {
    const r = parseSearchQuery('"react hooks"');
    expect(r.tokens).toEqual(['react hooks']);
    expect(r.tags).toEqual([]);
  });

  it('parses tag: filters', () => {
    const r = parseSearchQuery('tag:ai tag:rust machine learning');
    expect(r.tags).toEqual(['ai', 'rust']);
    expect(r.tokens).toEqual(['machine', 'learning']);
  });

  it('parses domain: filters and strips a leading www.', () => {
    const r = parseSearchQuery('domain:www.github.com readme');
    expect(r.domains).toEqual(['github.com']);
    expect(r.tokens).toEqual(['readme']);
  });

  it('mixes tag, domain, phrase and bare tokens', () => {
    const r = parseSearchQuery('tag:ai domain:github.com rust "async runtime"');
    expect(r.tags).toEqual(['ai']);
    expect(r.domains).toEqual(['github.com']);
    expect(r.tokens).toEqual(['rust', 'async runtime']);
  });

  it('keeps a whitespace-free Chinese string as a single token', () => {
    const r = parseSearchQuery('前端性能优化');
    // Without spaces there is nothing to split on, so the whole phrase is one
    // token, matching the old whole-string search behaviour.
    expect(r.tokens).toEqual(['前端性能优化']);
  });

  it('treats a valueless tag:/domain: as plain text', () => {
    // The prefix must be immediately followed by a value (no space) to count
    // as a filter; `tag:` / `domain:` on their own fall through to tokens.
    const r = parseSearchQuery('tag: domain: hello');
    expect(r.tags).toEqual([]);
    expect(r.domains).toEqual([]);
    expect(r.tokens).toEqual(['tag:', 'domain:', 'hello']);
  });

  it('trims a trailing space from a tag name', () => {
    const r = parseSearchQuery('tag:golang ');
    expect(r.tags).toEqual(['golang']);
  });

  it('returns empty structures for an empty input', () => {
    expect(parseSearchQuery('   ')).toEqual({ tokens: [], tags: [], domains: [] });
  });
});
