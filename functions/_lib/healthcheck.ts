/**
 * O1 — Bookmark library health checks.
 *
 * Two families of checks, deliberately separated:
 *
 *   1. Structural (pure SQL, instant): duplicate url_keys among live
 *      bookmarks, and orphan tags that no bookmark carries. These power the
 *      GET report and its health score.
 *
 *   2. Liveness (network probes, bounded): HEAD/GET each candidate URL with
 *      the SSRF guard and safe-redirect re-validation, classifying the
 *      outcome. Probing is a POST because it is slow and side-effectful
 *      (outbound requests), and each call is capped so one request can never
 *      fan out into hundreds of fetches.
 *
 * Nothing here mutates data: cleanup always goes through the existing
 * trash/tag endpoints, so the recycle bin and its snapshot backstop stay the
 * user's safety net.
 */
import type { Env } from './env';
import { PRIVATE_BOOKMARK_CLAUSE, D1_IN_CHUNK } from './db';
import { isBlockedHost } from './ssrf';
import { parseUrl } from './urlkey';

export interface DuplicateGroup {
  urlKey: string;
  count: number;
  bookmarks: { id: string; title: string; url: string; createdAt: string }[];
}

export interface OrphanTag {
  id: string;
  name: string;
}

export interface HealthReport {
  liveTotal: number;
  duplicateGroups: DuplicateGroup[];
  /** Bookmarks that would disappear once each group keeps its oldest copy. */
  duplicateExtra: number;
  orphanTags: OrphanTag[];
  /**
   * Structural health score, 0–100. Transparent by design: it only reflects
   * what the instant SQL scan can prove (duplicates + orphan tags relative to
   * library size). Dead links are reported separately by the probe endpoint
   * instead of silently dragging this number down after an unknown number of
   * probes.
   */
  score: number;
}

const MAX_DUPLICATE_GROUPS = 100;

export async function buildHealthReport(env: Env, userId: string): Promise<HealthReport> {
  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM bookmarks b
      WHERE b.user_id = ? AND b.deleted_at IS NULL AND ${PRIVATE_BOOKMARK_CLAUSE}`,
  )
    .bind(userId)
    .first<{ c: number }>();
  const liveTotal = Number(totalRow?.c ?? 0);

  // Duplicate url_keys among live, non-private bookmarks. The key is already
  // normalised (scheme/www/tracking-param insensitive), so grouping on it is
  // exactly the "same page saved N times" relation the import dedupe uses.
  const dupRows = await env.DB.prepare(
    `SELECT b.url_key AS k, COUNT(*) AS c
       FROM bookmarks b
      WHERE b.user_id = ? AND b.deleted_at IS NULL AND ${PRIVATE_BOOKMARK_CLAUSE}
      GROUP BY b.url_key HAVING COUNT(*) > 1
      ORDER BY c DESC, b.url_key ASC
      LIMIT ?`,
  )
    .bind(userId, MAX_DUPLICATE_GROUPS)
    .all<{ k: string; c: number }>();

  const groups: DuplicateGroup[] = [];
  const keys = dupRows.results.map((r) => r.k);
  if (keys.length > 0) {
    // Fetch the member rows for the duplicate keys, chunked to respect D1's
    // bound-parameter ceiling (one lead param + <= 99 values).
    const members = new Map<string, DuplicateGroup['bookmarks']>();
    for (let i = 0; i < keys.length; i += D1_IN_CHUNK) {
      const chunk = keys.slice(i, i + D1_IN_CHUNK);
      const ph = chunk.map(() => '?').join(',');
      const rows = await env.DB.prepare(
        `SELECT b.url_key AS k, b.id, b.title, b.url, b.created_at
           FROM bookmarks b
          WHERE b.user_id = ? AND b.deleted_at IS NULL AND b.url_key IN (${ph})
          ORDER BY b.created_at ASC, b.id ASC`,
      )
        .bind(userId, ...chunk)
        .all<{ k: string; id: string; title: string; url: string; created_at: string }>();
      for (const r of rows.results) {
        const list = members.get(r.k) ?? [];
        list.push({ id: r.id, title: r.title, url: r.url, createdAt: r.created_at });
        members.set(r.k, list);
      }
    }
    for (const r of dupRows.results) {
      const bookmarks = members.get(r.k) ?? [];
      if (bookmarks.length < 2) continue; // raced away between the two queries
      groups.push({ urlKey: r.k, count: bookmarks.length, bookmarks });
    }
  }

  const orphanRows = await env.DB.prepare(
    `SELECT t.id, t.name FROM tags t
      WHERE t.user_id = ?
        AND NOT EXISTS (SELECT 1 FROM bookmark_tags bt WHERE bt.tag_id = t.id)
      ORDER BY t.name COLLATE NOCASE
      LIMIT 200`,
  )
    .bind(userId)
    .all<{ id: string; name: string }>();

  const duplicateExtra = groups.reduce((n, g) => n + (g.count - 1), 0);
  const orphanTags = orphanRows.results;

  // Score: full marks for an empty library; every redundant copy and every
  // orphan tag subtracts proportionally. Clamped, rounded, and never below 0.
  const issues = duplicateExtra + orphanTags.length;
  const score =
    liveTotal === 0
      ? 100
      : Math.max(0, Math.min(100, Math.round(100 * (1 - issues / liveTotal))));

  return { liveTotal, duplicateGroups: groups, duplicateExtra, orphanTags, score };
}

/* ------------------------------------------------------------------ *
 * Liveness probing
 * ------------------------------------------------------------------ */

export const PROBE_MAX_IDS = 20;
export const PROBE_CONCURRENCY = 5;
const PROBE_TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 5;

export type ProbeStatus = 'ok' | 'dead' | 'auth' | 'suspicious' | 'blocked';

export interface ProbeResult {
  id: string;
  url: string;
  status: ProbeStatus;
  httpStatus: number | null;
}

/**
 * Classifies a final HTTP status for bookmark liveness.
 *
 * Conservative on purpose: only 404/410 is declared dead. 401/403 usually
 * means "login wall", 4xx bot-blocking and 5xx outages both come back — so
 * they surface as `suspicious` for a human glance instead of tricking the
 * user into trashing a live page.
 */
export function classifyStatus(status: number): ProbeStatus {
  if (status === 404 || status === 410) return 'dead';
  if (status === 401 || status === 403) return 'auth';
  if (status >= 200 && status < 400) return 'ok';
  return 'suspicious';
}

/**
 * Fetches a URL with per-hop SSRF re-validation (manual redirects, exactly
 * like the metadata endpoint) and a hard timeout. Returns the final status,
 * or null when the host is blocked, unparseable, or unreachable.
 */
async function probeFetch(url: string): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      let res: Response;
      try {
        res = await fetch(current, {
          method: 'HEAD',
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'User-Agent': 'TagNest-HealthCheck/1.0' },
        });
      } catch {
        // Some servers reject HEAD outright (405 comes back as a response,
        // but a few just drop the connection); retry once with GET.
        if (hop === 0) {
          try {
            res = await fetch(current, {
              method: 'GET',
              redirect: 'manual',
              signal: controller.signal,
              headers: { 'User-Agent': 'TagNest-HealthCheck/1.0' },
            });
          } catch {
            return null;
          }
        } else {
          return null;
        }
      }
      const status = res.status;
      if (status >= 300 && status < 400) {
        const loc = res.headers.get('Location');
        await res.arrayBuffer().catch(() => null); // release body
        if (!loc) return status;
        let next: URL;
        try {
          next = new URL(loc, current);
        } catch {
          return status;
        }
        if (isBlockedHost(next.hostname)) return null;
        current = next.toString();
        continue;
      }
      await res.arrayBuffer().catch(() => null);
      return status;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probes a bounded batch of bookmarks. Rows are loaded scoped to the user
 * and with the private clause, so vaulted bookmarks (whose URLs are blanked
 * anyway) can never be probed.
 */
export async function probeBookmarks(
  env: Env,
  userId: string,
  ids: string[],
): Promise<ProbeResult[]> {
  if (ids.length === 0) return [];
  const ph = ids.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT b.id, b.url FROM bookmarks b
      WHERE b.user_id = ? AND b.id IN (${ph})
        AND b.deleted_at IS NULL AND ${PRIVATE_BOOKMARK_CLAUSE}`,
  )
    .bind(userId, ...ids)
    .all<{ id: string; url: string }>();

  const targets = rows.results;
  const results: ProbeResult[] = new Array(targets.length);

  // Small worker pool: at most PROBE_CONCURRENCY fetches in flight so one
  // request can never fan out into an unbounded burst of outbound calls.
  let next = 0;
  async function work() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= targets.length) return;
      const t = targets[i];
      const parsed = parseUrl(t.url);
      if (!parsed || isBlockedHost(parsed.hostname)) {
        results[i] = { id: t.id, url: t.url, status: 'blocked', httpStatus: null };
        continue;
      }
      const status = await probeFetch(parsed.toString());
      results[i] = {
        id: t.id,
        url: t.url,
        status: status === null ? 'suspicious' : classifyStatus(status),
        httpStatus: status,
      };
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(PROBE_CONCURRENCY, targets.length) }, () => work()),
  );
  return results;
}
