import { describe, expect, it } from 'vitest';
import {
  heuristicCandidates,
  hostOf,
  matchesKeyword,
  type RawCandidate,
} from '../functions/_lib/ai/heuristics';

describe('hostOf', () => {
  it('normalises hostnames without www', () => {
    expect(hostOf('https://www.GitHub.com/foo')).toBe('github.com');
    expect(hostOf('http://sub.example.com/path')).toBe('sub.example.com');
  });

  it('returns null for garbage', () => {
    expect(hostOf('not a url')).toBeNull();
    expect(hostOf('')).toBeNull();
  });
});

describe('matchesKeyword', () => {
  it('anchors ASCII keywords on word boundaries', () => {
    expect(matchesKeyword('open source project', 'open source')).toBe(true);
    // "go" must not fire inside "google".
    expect(matchesKeyword('google cloud', 'go')).toBe(false);
    // but a standalone "go" word matches.
    expect(matchesKeyword('go is a keyword', 'go')).toBe(true);
  });

  it('matches CJK keywords as plain substrings', () => {
    expect(matchesKeyword('一篇教程分享', '教程')).toBe(true);
    expect(matchesKeyword('tutorial about css', '教程')).toBe(false);
  });
});

describe('heuristicCandidates', () => {
  it('tags a known developer host', () => {
    const out = heuristicCandidates({ url: 'https://github.com/foo/bar', title: 'A repo' });
    const names = out.map((c) => c.name);
    expect(names).toContain('开源');
    expect(names).toContain('代码');
  });

  it('combines host, path and keyword rules without double-counting a tag', () => {
    const out = heuristicCandidates({
      url: 'https://github.com/org/docs/intro',
      title: '官方文档教程',
      description: 'a tutorial for developers',
    });
    const names = out.map((c) => c.name);
    // host (开源/代码) + path (/docs -> 文档) + keyword (教程) all present...
    expect(names).toContain('文档');
    expect(names).toContain('教程');
    // ...but each tag appears only once per bookmark.
    const openSource = out.filter((c) => c.name === '开源');
    expect(openSource).toHaveLength(1);
  });

  it('uses path fragments regardless of host', () => {
    const out = heuristicCandidates({ url: 'https://example.com/docs/start', title: 'Start' });
    expect(out.map((c) => c.name)).toContain('文档');
  });

  it('keeps every candidate marked as the heuristic source', () => {
    const out = heuristicCandidates({ url: 'https://arxiv.org/abs/1234', title: 'A paper' });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((c: RawCandidate) => c.source === 'heuristic')).toBe(true);
  });

  it('never throws on an unparseable url', () => {
    expect(() => heuristicCandidates({ url: '::not a url::', title: 'x' })).not.toThrow();
  });

  it('returns nothing for a blank bookmark but does not throw', () => {
    expect(heuristicCandidates({ url: 'https://unknown.example/about', title: 'About' })).toEqual([]);
  });
});
