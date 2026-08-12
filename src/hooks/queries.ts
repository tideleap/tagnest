/**
 * Barrel: re-exports all hooks from the domain-split queries/ directory.
 * Consumers keep importing from '@/hooks/queries' unchanged.
 */
export { keys } from './queries/keys';

export {
  useBookmarks,
  useBookmark,
  useCreateBookmark,
  useUpdateBookmark,
  useToggleFavorite,
  useTrashBookmarks,
  useRestoreBookmarks,
  useDeleteForever,
  useBulkTag,
  useReorderBookmarks,
  useRecordVisit,
  useFetchMetadata,
} from './queries/bookmarks';

export {
  useTags,
  useCreateTag,
  useUpdateTag,
  useDeleteTag,
  useMergeTags,
  usePrivateTags,
  useSetTagPrivate,
} from './queries/tags';

export {
  useStats,
  useImportPreview,
  useImportCommit,
} from './queries/stats';

export {
  useAiSettings,
  useUpdateAiSettings,
} from './queries/ai';

export {
  useUserSettings,
  useUpdateUserSettings,
} from './queries/settings';

export {
  useStorageUsage,
  useExportPreview,
  useCleanupSnapshots,
} from './queries/storage';

export {
  useAiOverview,
  useAiSuggestions,
  useAiTaxonomyAudit,
  useDecideSuggestions,
  useSuggestNow,
  useOrganizeRun,
  useAutoGroupTags,
} from './queries/organize';

export {
  useApiKeys,
  useCreateApiKey,
  useDeleteApiKey,
} from './queries/apiKeys';

export {
  useAiJobs,
  useAiJob,
  useCancelJob,
} from './queries/aiJobs';

export {
  useShares,
  useCreateShare,
  useUpdateShare,
  useDeleteShare,
} from './queries/shares';

export {
  useTabGroups,
  useTabGroup,
  useCreateTabGroup,
  useUpdateTabGroup,
  useDeleteTabGroup,
  useAddTabItem,
  useRemoveTabItem,
  useReorderTabItems,
} from './queries/tabgroups';

export {
  useCollections,
  useCollection,
  useCreateCollection,
  useRenameCollection,
  useDeleteCollection,
  useAddToCollection,
  useRemoveFromCollection,
} from './queries/collections';
