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
  useAiOverview,
  useAiSuggestions,
  useAiTaxonomyAudit,
  useDecideSuggestions,
  useSuggestNow,
  useOrganizeRun,
} from './queries/organize';

export {
  useApiKeys,
  useCreateApiKey,
  useDeleteApiKey,
} from './queries/apiKeys';

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
