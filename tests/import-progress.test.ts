// Tests for the NDJSON streaming import-progress path (Q8f).
//
// `requestNdjson` is what the import commit screen uses to turn server chunks
// into a live progress bar without buffering the whole payload. The riskiest
// logic is line/split + progress dispatch, so that's what we pin down here.
import { describe, it, expect, vi, afterEach } from 'vitest';

const BASE = '/api';

function streamFrom(text) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function ndjsonResponse(text, ok = true, status = 200) {
  return new Response(streamFrom(text), {
    status,
    ok,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

async function load() {
  const mod = await import('../src/lib/api');
  return mod;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requestNdjson: progress parsing', () => {
  it('fires onProgress for each line and resolves with the final result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      ndjsonResponse(
        [
          '{"type":"progress","done":50,"total":200,"skipped":1,"failed":0}\n',
          '{"type":"progress","done":100,"total":200,"skipped":1,"failed":0}\n',
          '{"type":"progress","done":200,"total":200,"skipped":1,"failed":0}\n',
          '{"type":"result","imported":199,"skipped":1,"failed":0,"tagsCreated":3}\n',
        ].join(''),
      ),
    ));

    const { requestNdjson } = await load();
    const progress = [];
    const result = await requestNdjson('/import/commit', { token: 't' }, (p) => progress.push(p), {
      timeoutMs: 1000,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const callUrl = vi.mocked(fetch).mock.calls[0][0];
    expect(callUrl).toBe(`${BASE}/import/commit`);
    expect(progress).toHaveLength(3);
    expect(progress[0]).toEqual({ done: 50, total: 200, skipped: 1, failed: 0 });
    expect(progress[2]).toEqual({ done: 200, total: 200, skipped: 1, failed: 0 });
    expect(result).toEqual({ imported: 199, skipped: 1, failed: 0, tagsCreated: 3 });
  });

  it('handles a progress line split across chunk boundaries', async () => {
    // Split the stream mid-line to force the buffer-join logic.
    const half1 = '{"type":"progress","done":75,';
    const half2 = '"total":150,"skipped":0,"failed":2}\n{"type":"result","imported":150,"skipped":0,"failed":0,"tagsCreated":0}\n';
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(half1));
        // simulate async flush of the remainder
        setTimeout(() => {
          c.enqueue(enc.encode(half2));
          c.close();
        }, 0);
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(body, { status: 200, ok: true, headers: { 'Content-Type': 'application/x-ndjson' } }),
    ));

    const { requestNdjson } = await load();
    const progress = [];
    const result = await requestNdjson('/import/commit', { token: 't' }, (p) => progress.push(p), {
      timeoutMs: 1000,
    });
    expect(progress).toEqual([{ done: 75, total: 150, skipped: 0, failed: 2 }]);
    expect(result.imported).toBe(150);
  });

  it('ignores non-NDJSON / garbage lines', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      ndjsonResponse('{"type":"progress","done":10,"total":10,"skipped":0,"failed":0}\nnot-json\n{"type":"result","imported":10,"skipped":0,"failed":0,"tagsCreated":0}\n'),
    ));
    const { requestNdjson } = await load();
    const result = await requestNdjson('/import/commit', {}, () => {}, { timeoutMs: 1000 });
    expect(result.imported).toBe(10);
  });

  it('maps an HTTP error body to its error.message with a typed HttpError', async () => {
    const errBody = new Response(JSON.stringify({ error: { message: '导入会话已过期' } }), {
      status: 404,
      ok: false,
      headers: { 'Content-Type': 'application/json' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errBody));
    const { requestNdjson, HttpError } = await load();
    await expect(
      requestNdjson('/import/commit', {}, () => {}, { timeoutMs: 1000, signal: undefined }),
    ).rejects.toThrow('导入会话已过期');
    await expect(
      requestNdjson('/import/commit', {}, () => {}, { timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it('throws a network HttpError when fetch itself rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const { requestNdjson, HttpError } = await load();
    await expect(
      requestNdjson('/import/commit', {}, () => {}, { timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(HttpError);
    await expect(
      requestNdjson('/import/commit', {}, () => {}, { timeoutMs: 1000 }),
    ).rejects.toThrow(/网络/);
  });

  it('rejects when the stream closes without a result line', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      ndjsonResponse('{"type":"progress","done":10,"total":10,"skipped":0,"failed":0}\n'),
    ));
    const { requestNdjson } = await load();
    await expect(
      requestNdjson('/import/commit', {}, () => {}, { timeoutMs: 1000 }),
    ).rejects.toThrow(/未返回结果/);
  });

  it('parses a final result line that is not newline-terminated', async () => {
    // Proxies / finalising intermediaries can drop the trailing newline of the
    // last frame. The flush-tail path must still resolve the result.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      ndjsonResponse(
        '{"type":"progress","done":2,"total":2,"skipped":0,"failed":0}\n' +
        '{"type":"result","imported":2,"skipped":0,"failed":0,"tagsCreated":0}',
      ),
    ));
    const { requestNdjson } = await load();
    const result = await requestNdjson('/import/commit', {}, () => {}, { timeoutMs: 1000 });
    expect(result.imported).toBe(2);
  });

  it('flush decodes a trailing multi-byte (CJK) result with no newline', async () => {
    // A result framed entirely inside a single trailing chunk WITHOUT a newline,
    // where the JSON contains a multibyte character — exercises the incremental
    // decoder flush on stream end.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(streamFrom(
        '{"type":"progress","done":1,"total":1,"skipped":0,"failed":0}\n' +
        '{"type":"result","imported":1,"skipped":0,"failed":0,"tagsCreated":1}',
      ), { status: 200, ok: true, headers: { 'Content-Type': 'application/x-ndjson' } }),
    ));
    const { requestNdjson } = await load();
    const result = await requestNdjson('/import/commit', {}, () => {}, { timeoutMs: 1000 });
    expect(result.imported).toBe(1);
    expect(result.tagsCreated).toBe(1);
  });
});
