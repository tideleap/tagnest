import type { BookmarkQuery } from '@shared/types';

/**
 * Central key registry.
 *
 * Every cache key in the app is built here, which makes invalidation
 * auditable — the alternative is inline string arrays that silently diverge
 * and leave stale lists on screen after a mutation.
 */
export const keys = {
  bookmarks: (q: BookmarkQuery) => ['bookmarks', q] as const,
  bookmarksRoot: ['bookmarks'] as const,
  bookmark: (id: string) => ['bookmark', id] as const,
  /** O1 — structural health report (duplicates, orphan tags, score). */
  health: ['bookmarks-health'] as const,
  tags: ['tags'] as const,
  stats: ['stats'] as const,
  aiSettings: ['ai-settings'] as const,
  /** User-level application settings (snapshot retention, …). */
  userSettings: ['user-settings'] as const,
  aiOverview: ['ai-overview'] as const,
  aiTaxonomy: ['ai-taxonomy'] as const,
  /** Alias proposals + topic clustering for the taxonomy health page. */
  aiAliases: ['ai-aliases'] as const,
  /** Pending proposals; scoped by run so "review what I just made" is cacheable. */
  aiSuggestions: (jobId?: string | null) => ['ai-suggestions', jobId ?? 'all'] as const,
  aiSuggestionsRoot: ['ai-suggestions'] as const,
  /** AI batch-run history; the jobs list is its own cache so cancelling one
   *  run does not disturb the suggestion queue or the overview counters. */
  aiJobs: ['ai-jobs'] as const,
  aiJob: (id: string) => ['ai-job', id] as const,
  /** A1 — pre-run cost forecast, keyed by scope so switching ranges refetches. */
  aiEstimate: (target: string, ids?: string[]) =>
    ['ai-estimate', target, ids?.join(',') ?? ''] as const,
  /** Root key so a finished run can invalidate every scope's forecast at once. */
  aiEstimateRoot: ['ai-estimate'] as const,
  apiKeys: ['api-keys'] as const,
  /** Storage management: R2 usage, export preview, snapshot cleanup. */
  storageUsage: ['storage-usage'] as const,
  exportPreview: ['export-preview'] as const,
  shares: ['shares'] as const,
  tabGroups: ['tab-groups'] as const,
  tabGroup: (id: string) => ['tab-group', id] as const,
  /** User-curated named bookmark sets (design plan module). */
  collections: ['collections'] as const,
  collection: (id: string) => ['collection', id] as const,
  /** Authorized listing of private tags + the bookmarks each hides. */
  privateTags: ['private-tags'] as const,
  /** Single category-private bookmark loaded for the vault editor. */
  privateTagBookmark: (id: string | null) => ['private-tag-bookmark', id] as const,
  privateTagBookmarkRoot: ['private-tag-bookmark'] as const,
};

export const PAGE_SIZE = 40;
