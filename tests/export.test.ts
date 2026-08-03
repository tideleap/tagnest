import { describe, expect, it } from 'vitest';
import type { Env } from '../functions/_lib/env';
import type { ExportRenderOpts } from '../functions/api/export';
import { renderJsonStream } from '../functions/api/export';

/**
 * Unit tests for the streaming JSON export. We feed a two-page D1 mock into the
 * stream builder and assert the concatenated body is valid, parseable JSON that
 * reflects the mocked rows — proving the streaming pipeline (which never buffers
 * the whole library) still produces correct output incrementally.
 */

// A tiny, honest D1 mock: page 0 returns a FULL page (100 rows) so the export
// keyset cursor actually advances, then page 1 returns a short page (1 row)
// that terminates the loop — mirroring a real >100-row library.
function makeDb() {
  const row = (id: string, url: string, extra: Record<string, unknown> = {}) => ({
    id,
    url,
    title: `T-${id}`,
    description: null,
    note: null,
    ai_summary: null,
    is_favorite: 0,
    is_archived: 0,
    visit_count: 0,
    last_visited_at: null,
    manual_order: 0,
    snapshot_key: null,
    snapshot_keys: null,
    created_at: `2024-01-01T00:00:00.000Z`,
    updated_at: `2024-01-01T00:00:00.000Z`,
    deleted_at: null,
    tags: '',
    ...extra,
  });

  const fillers: Record<string, unknown>[] = Array.from({ length: 97 }, (_, i) =>
    row(`filler-${i}`, `https://f${i}.example`),
  );
  const page0: Record<string, unknown>[] = [
    row('a', 'https://a.example', {
      title: 'Alpha',
      description: 'd1',
      is_favorite: 1,
      visit_count: 3,
      tags: 'z',
    }),
    row('b', 'https://b.example', {
      title: 'Beta',
      note: 'mem',
      is_archived: 1,
      tags: 'x' + String.fromCharCode(31) + 'y',
    }),
    row('c', 'https://c.example', { title: 'Gamma', visit_count: 1 }),
    ...fillers,
  ];
  const page1: Record<string, unknown>[] = [
    row('tail', 'https://tail.example', { title: 'Tail' }),
  ];
  let page = 0;
  return {
    prepare(_sql: string) {
      return {
        bind(..._args: unknown[]) {
          return this;
        },
        async all() {
          const results = page === 0 ? page0 : page1;
          page += 1;
          return { results };
        },
      };
    },
  };
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return new TextDecoder().decode(out);
}

describe('export JSON streaming', () => {
  it('streams a valid JSON document equal to the full buffered result', async () => {
    const env = { DB: makeDb() } as unknown as Env;
    const opts: ExportRenderOpts = { includeTags: true, includeMetadata: true, includeVisits: true, pretty: false };
    const stream = await renderJsonStream(
      { env, userId: 'u-user', includeTrash: true },
      opts,
      '2024-01-05T00:00:00.000Z',
    );
    const body = await collectStream(stream);

    const parsed = JSON.parse(body);
    expect(parsed.application).toBe('TagNest');
    expect(parsed.version).toBe(1);
    expect(parsed.bookmarks).toHaveLength(101); // 100 full page + 1 tail page
    expect(parsed.bookmarks[0].url).toBe('https://a.example');
    expect(parsed.bookmarks[0].isFavorite).toBe(true);
    expect(parsed.bookmarks[0].tags).toEqual(['z']);
    expect(parsed.bookmarks[1].tags).toEqual(['x', 'y']);
    expect(parsed.bookmarks[1].isArchived).toBe(true);
    expect(parsed.bookmarks[2].title).toBe('Gamma');
    expect(parsed.bookmarks[100].url).toBe('https://tail.example'); // last row from page 1
  });

  it('pretty mode still yields parseable, indented JSON', async () => {
    const env = { DB: makeDb() } as unknown as Env;
    const opts: ExportRenderOpts = { includeTags: true, includeMetadata: true, includeVisits: true, pretty: true };
    const stream = await renderJsonStream(
      { env, userId: 'u-user', includeTrash: true },
      opts,
      '2024-01-05T00:00:00.000Z',
    );
    const body = await collectStream(stream);
    const parsed = JSON.parse(body);
    expect(parsed.bookmarks).toHaveLength(101);
    expect(body).toContain('\n  "url"'); // pretty-indented object
  });

  it('respects includeVisits / includeTags off', async () => {
    const env = { DB: makeDb() } as unknown as Env;
    const opts: ExportRenderOpts = { includeTags: false, includeMetadata: false, includeVisits: false, pretty: false };
    const stream = await renderJsonStream(
      { env, userId: 'u-user', includeTrash: true },
      opts,
      '2024-01-05T00:00:00.000Z',
    );
    const parsed = JSON.parse(await collectStream(stream));
    const b0 = parsed.bookmarks[0];
    expect(b0.visitCount).toBeUndefined();
    expect(b0.tags).toBeUndefined();
    expect(b0.description).toBeUndefined();
    expect(b0.url).toBe('https://a.example');
  });
});
