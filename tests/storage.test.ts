import { describe, expect, it } from 'vitest';
import { formatBytes, fetchStorageUsage, reconcileBookmarkSnapshots } from '../functions/_lib/storage';

/**
 * Minimal in-memory R2 bucket stub supporting the list() surface the storage
 * lib uses. Objects are stored with fake {key,size} entries so list can sum.
 */
function memR2(entries: Record<string, number>) {
  const store = Object.entries(entries).map(([key, size]) => ({ key, size }));
  return {
    async list(opts: { prefix?: string; cursor?: string } = {}) {
      const filtered = store.filter((o) => (opts.prefix ? o.key.startsWith(opts.prefix) : true));
      // Single "page" (no cursor pagination) for test simplicity.
      return {
        objects: filtered,
        delimitedPrefixes: [],
        truncated: false,
      };
    },
  };
}

describe('formatBytes', () => {
  const cases: [number, string][] = [
    [0, '0 B'],
    [512, '512 B'],
    [1536, '1.5 KB'],
    [1024 * 1024, '1 MB'],
    [1234567, '1.18 MB'],
    [1024 ** 3 * 1.5, '1.5 GB'],
    [1024 ** 4 * 2.25, '2.25 TB'],
    [-100, '0 B'],
    [NaN, '0 B'],
  ];
  for (const [bytes, expected] of cases) {
    it(`${bytes} → ${expected}`, () => {
      expect(formatBytes(bytes)).toBe(expected);
    });
  }
});

describe('fetchStorageUsage', () => {
  it('sums snapshot sizes under the user prefix when no prefix given', async () => {
    const bucket = memR2({
      'snapshots/u1/a-1.webp': 2048,
      'snapshots/u1/a-2.webp': 4096,
    });
    const usage = await fetchStorageUsage({ SNAPSHOT_BUCKET: bucket }, { userId: 'u1' });
    expect(usage.snapshotCount).toBe(2);
    expect(usage.snapshotBytes).toBe(6144);
    expect(usage.totalBytes).toBe(6144);
    expect(usage.otherCount).toBe(0);
  });

  it('scopes to the whole snapshots/ namespace for the global view', async () => {
    const bucket = memR2({
      'snapshots/u1/a-1.webp': 1000,
      'snapshots/u2/b-1.webp': 2000,
    });
    const usage = await fetchStorageUsage({ SNAPSHOT_BUCKET: bucket }, {});
    expect(usage.snapshotCount).toBe(2);
    expect(usage.snapshotBytes).toBe(3000);
  });

  it('counts non-snapshot prefixes as "other" when listing the whole bucket', async () => {
    // R2 list({prefix}) filters server-side; to observe "other" content we must
    // pass a broad prefix ("" here) so mixed-prefix objects are returned.
    const bucket = memR2({
      'snapshots/u1/a-1.webp': 1000,
      'covers/u1/x.webp': 500,
    });
    const usage = await fetchStorageUsage({ SNAPSHOT_BUCKET: bucket }, { prefix: '' });
    expect(usage.snapshotBytes).toBe(1000);
    expect(usage.otherBytes).toBe(500);
    expect(usage.totalBytes).toBe(1500);
  });

  it('returns zeros when the bucket binding is absent', async () => {
    const usage = await fetchStorageUsage({}, { userId: 'u1' });
    expect(usage.totalBytes).toBe(0);
    expect(usage.snapshotCount).toBe(0);
  });
});

describe('reconcileBookmarkSnapshots', () => {
  const k = (ts: number) => `snapshots/u/b-${ts}.webp`;

  it('keeps all keys whose objects exist', () => {
    const keys = [k(100), k(200), k(300)];
    const { keepKeys, dropKeys, newLatestKey } = reconcileBookmarkSnapshots(
      k(300),
      keys,
      new Set(keys),
    );
    expect(keepKeys).toEqual(keys);
    expect(dropKeys).toEqual([]);
    expect(newLatestKey).toBe(k(300));
  });

  it('drops orphan keys whose object is missing', () => {
    const keys = [k(100), k(200), k(300)];
    const { keepKeys, dropKeys, newLatestKey } = reconcileBookmarkSnapshots(
      k(300),
      keys,
      new Set([k(100), k(300)]), // k(200) object missing
    );
    expect(keepKeys).toEqual([k(100), k(300)]);
    expect(dropKeys).toEqual([k(200)]);
    expect(newLatestKey).toBe(k(300));
  });

  it('falls back to the newest surviving key when the latest is orphaned', () => {
    const keys = [k(100), k(200)];
    const { keepKeys, dropKeys, newLatestKey } = reconcileBookmarkSnapshots(
      k(200),
      keys,
      new Set([k(100)]), // k(200) missing
    );
    expect(keepKeys).toEqual([k(100)]);
    expect(dropKeys).toEqual([k(200)]);
    expect(newLatestKey).toBe(k(100));
  });

  it('clears the latest when every key is orphaned', () => {
    const keys = [k(100)];
    const { keepKeys, dropKeys, newLatestKey } = reconcileBookmarkSnapshots(
      k(100),
      keys,
      new Set(),
    );
    expect(keepKeys).toEqual([]);
    expect(dropKeys).toEqual([k(100)]);
    expect(newLatestKey).toBeNull();
  });
});
