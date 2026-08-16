import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Feed, FeedInput, FeedRefreshResult } from '@shared/types';
import { api } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { keys } from '@/hooks/queries/keys';

/** Lists the current user's RSS subscriptions. */
export function useFeeds() {
  return useQuery({
    queryKey: keys.feeds,
    queryFn: () => api.get<Feed[]>('/feeds'),
    staleTime: 30_000,
  });
}

/** Subscribes to a new feed. */
export function useSubscribeFeed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: FeedInput) => api.post<Feed>('/feeds', input),
    onSuccess: (feed) => {
      void qc.invalidateQueries({ queryKey: keys.feeds });
      toast.success('已订阅', feed.title || feed.url);
    },
    onError: (e: Error) => toast.error('订阅失败', e.message),
  });
}

/** Unsubscribes from a feed. */
export function useUnsubscribeFeed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/feeds/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.feeds });
      toast.success('已退订');
    },
    onError: (e: Error) => toast.error('退订失败', e.message),
  });
}

/** Pulls one feed immediately. */
export function useRefreshFeed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<FeedRefreshResult>(`/feeds/${id}/refresh`),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: keys.feeds });
      void qc.invalidateQueries({ queryKey: keys.bookmarksRoot });
      if (res.added > 0) {
        toast.success('已拉取', `新增 ${res.added} 条，跳过 ${res.skipped} 条重复`);
      } else {
        toast.success('已是最新', `跳过 ${res.skipped} 条重复`);
      }
    },
    onError: (e: Error) => toast.error('刷新失败', e.message),
  });
}

/** Refreshes every due feed (the "刷新全部" action). */
export function useRefreshAllFeeds() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ results: FeedRefreshResult[]; refreshed: number; added: number }>('/feeds/refresh-all'),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: keys.feeds });
      void qc.invalidateQueries({ queryKey: keys.bookmarksRoot });
      if (res.refreshed === 0) {
        toast.success('没有需要刷新的订阅');
      } else {
        toast.success('已刷新', `拉取 ${res.refreshed} 个订阅，新增 ${res.added} 条`);
      }
    },
    onError: (e: Error) => toast.error('刷新失败', e.message),
  });
}
