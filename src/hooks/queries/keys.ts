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
  /** A2 — related bookmarks ranked by tag/domain/text similarity. */
  similar: (id: string) => ['similar', id] as const,
  /** O1 — structural health report (duplicates, orphan tags, score). */
  health: ['bookmarks-health'] as const,
  tags: ['tags'] as const,
  /** T1 — merge audit trail shown in the governance panel. */
  tagMergeLog: ['tag-merge-log'] as const,
  stats: ['stats'] as const,
  /** A3 — per-day additions for the report page trend chart. */
  statsTrend: ['stats-trend'] as const,
  aiSettings: ['ai-settings'] as const,
  /** User-level application settings (snapshot retention, …). */
  userSettings: ['user-settings'] as const,
  aiOverview: ['ai-overview'] as const,
  aiTaxonomy: ['ai-taxonomy'] as const,
  /** Alias proposals + topic clustering for the taxonomy health page. */
  aiAliases: ['ai-aliases'] as const,
  /** Pending proposals; scoped by run and kind so "review what I just made"
   *  is cacheable per queue. CategorySync (migration 0024): the unified queue
   *  holds 'tag' and 'category' rows, and each view must refetch its own.
   *  Rename track ('rename') rides the same table with its own kind. */
  aiSuggestions: (jobId?: string | null, kind?: 'tag' | 'category' | 'rename') =>
    ['ai-suggestions', jobId ?? 'all', kind ?? 'all'] as const,
  aiSuggestionsRoot: ['ai-suggestions'] as const,
  /** AI batch-run history; the jobs list is its own cache so cancelling one
   *  run does not disturb the suggestion queue or the overview counters. */
  aiJobs: ['ai-jobs'] as const,
  aiJob: (id: string) => ['ai-job', id] as const,
  /** A1 — pre-run cost forecast, keyed by scope (and organiser kind) so
   *  switching ranges refetches. */
  aiEstimate: (target: string, ids?: string[], kind?: 'tagging' | 'categorize' | 'rename') =>
    ['ai-estimate', target, ids?.join(',') ?? '', kind ?? 'tagging'] as const,
  /** Root key so a finished run can invalidate every scope's forecast at once. */
  aiEstimateRoot: ['ai-estimate'] as const,
  /** CategorySync — primary-category tree with per-node placement counts. */
  categoryTree: ['category-tree'] as const,
  /** CategorySync — keyset-paged writeback mapping (bookmark → category path). */
  categoryWriteback: ['category-writeback'] as const,
  apiKeys: ['api-keys'] as const,
  /** Storage management: R2 usage, export preview, snapshot cleanup. */
  storageUsage: ['storage-usage'] as const,
  exportPreview: ['export-preview'] as const,
  shares: ['shares'] as const,
  backupTargets: ['backupTargets'] as const,
  backupRuns: ['backupRuns'] as const,
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
  /** B-11 — RSS subscriptions. */
  feeds: ['feeds'] as const,
  /** Phase A billing — plan + credit meter for the settings page. */
  billing: ['billing'] as const,
};

export const PAGE_SIZE = 40;
