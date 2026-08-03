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
  tags: ['tags'] as const,
  stats: ['stats'] as const,
  aiSettings: ['ai-settings'] as const,
  /** User-level application settings (snapshot retention, …). */
  userSettings: ['user-settings'] as const,
  aiOverview: ['ai-overview'] as const,
  aiTaxonomy: ['ai-taxonomy'] as const,
  /** Pending proposals; scoped by run so "review what I just made" is cacheable. */
  aiSuggestions: (jobId?: string | null) => ['ai-suggestions', jobId ?? 'all'] as const,
  aiSuggestionsRoot: ['ai-suggestions'] as const,
  apiKeys: ['api-keys'] as const,
  shares: ['shares'] as const,
  tabGroups: ['tab-groups'] as const,
  tabGroup: (id: string) => ['tab-group', id] as const,
};

export const PAGE_SIZE = 40;
