import type { AiTaxonomyAudit } from '../../../shared/types';
import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { json } from '../../_lib/http';
import { findDuplicateClusters, loadVocabulary } from '../../_lib/ai';

/** Enough to act on in one sitting; the rest reappear after the first pass. */
const MAX_CLUSTERS = 50;
const MAX_UNUSED = 100;

/**
 * P2-3 grace period: a pending (AI-minted, not-yet-promoted) tag is still
 * earning its second bookmark, so it is hidden from the governance list for
 * this many days after creation. Once it goes stale it joins `lowUsage` like
 * any other one-bookmark tag.
 */
const PENDING_GRACE_DAYS = 30;

function isStalePending(entry: { status?: string; createdAt?: string }, now: number): boolean {
  if (entry.status !== 'pending' || !entry.createdAt) return false;
  const created = Date.parse(entry.createdAt);
  if (Number.isNaN(created)) return false;
  return now - created >= PENDING_GRACE_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Taxonomy health check.
 *
 * Reports groups of tags that mean the same thing ("js" / "JS" / "JavaScript",
 * "前端" / "Frontend") together with the one to keep, and tags attached to
 * nothing.
 *
 * This is the *maintenance* half of the feature. Preventing new duplicates —
 * which the normalisation step in `resolveCandidates` does on every proposal —
 * is only half the job; a library that has already accumulated four hundred
 * tags from a browser import needs the existing mess cleaned up too, and
 * spotting near-duplicates by eye across four hundred rows is not something a
 * person should be asked to do.
 *
 * Read-only by design. It hands the user a merge list; executing it goes
 * through the existing `POST /api/tags/merge`, so there is exactly one code
 * path that rewrites tag links.
 */
export const onRequestGet: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const vocab = await loadVocabulary(ctx.env, userId);

  const clusters = findDuplicateClusters(vocab)
    .slice(0, MAX_CLUSTERS)
    .map((cluster) => ({
      canonicalId: cluster.canonical.id,
      canonicalName: cluster.canonical.name,
      canonicalCount: cluster.canonical.count,
      duplicates: cluster.duplicates.map((d) => ({ id: d.id, name: d.name, count: d.count })),
      reason: cluster.reason,
    }));

  const unused = vocab.entries
    .filter((entry) => entry.count === 0)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_UNUSED)
    .map((entry) => ({ id: entry.id, name: entry.name }));

  // Used exactly once: governance candidates. Unlike `unused` they each carry
  // a live bookmark, so the UI offers merge/review rather than bulk delete.
  //
  // P2-3 grace: a pending tag is still earning its second bookmark, so it is
  // hidden here until it goes stale (30 days). Active one-bookmark tags and
  // stale pending tags both surface.
  const now = Date.now();
  const lowUsage = vocab.entries
    .filter((entry) => entry.count === 1)
    .filter((entry) => entry.status !== 'pending' || isStalePending(entry, now))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_UNUSED)
    .map((entry) => ({ id: entry.id, name: entry.name, count: entry.count }));

  const audit: AiTaxonomyAudit = {
    totalTags: vocab.entries.length,
    clusters,
    unused,
    lowUsage,
  };

  return json(audit);
};
