/**
 * Global coordinator for lazy snapshot (re)capture.
 *
 * Problem it solves: the bookmark grid used to fire a capture request for
 * every card the moment the page loaded — so opening "all bookmarks" with
 * hundreds of entries kicked off hundreds of simultaneous screenshots, which
 * is slow, expensive, and shows the user a wall of spinners.
 *
 * New policy (see product decision q-3):
 *   1. On page entry, just show the cached image — never capture immediately.
 *   2. Refresh a snapshot that exists but is stale only when its card scrolls
 *      into view, and at most once per `REFRESH_INTERVAL_MS` per bookmark.
 *   3. Backfill a bookmark that has no snapshot at all, but globally rate-limited:
 *      at most `MAX_CONCURRENT` captures in flight, and at most one attempt per
 *      bookmark per `REFRESH_INTERVAL_MS`.
 *
 * The scheduler is a module singleton so every card shares the same throttle
 * and concurrency window — one card capturing frees a slot for the next.
 */

/** Minimum gap between two capture attempts for the same bookmark. */
export const SNAPSHOT_REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/** Max simultaneous snapshot captures across the whole page. */
export const SNAPSHOT_MAX_CONCURRENT = 4;

const lastAttempt = new Map<string, number>();
const runners = new Map<string, () => void>();
let active = 0;
const queue: string[] = [];

function dequeue(): void {
  while (active < SNAPSHOT_MAX_CONCURRENT && queue.length > 0) {
    const id = queue.shift()!;
    const run = runners.get(id);
    // Consume the runner as soon as it starts so the map never accumulates
    // stale entries, and a later release() cannot wipe tasks still waiting.
    runners.delete(id);
    if (!run) continue;
    active += 1;
    run();
  }
}

/**
 * Requests a (re)capture for `id`. The actual capture is performed by `run`
 * (typically a TanStack mutation). The scheduler throttles per-bookmark and
 * caps concurrency, so callers can fire-and-forget on every intersect without
 * worrying about floods.
 */
export function scheduleSnapshotRefresh(id: string, run: () => void, now: number = Date.now()): void {
  const last = lastAttempt.get(id);
  if (last !== undefined && now - last < SNAPSHOT_REFRESH_INTERVAL_MS) return;
  lastAttempt.set(id, now);

  if (active < SNAPSHOT_MAX_CONCURRENT) {
    active += 1;
    run();
  } else {
    // Park the runner until a slot frees; dequeue() consumes it then.
    runners.set(id, run);
    queue.push(id);
  }
}

/**
 * Must be called when a capture started via `scheduleSnapshotRefresh` settles
 * (success or error), so the concurrency slot is released for the next card.
 */
export function releaseSnapshotRefresh(): void {
  active = Math.max(0, active - 1);
  dequeue();
}
