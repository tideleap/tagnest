import { QueryClient } from '@tanstack/react-query';
import { HttpError } from '@/lib/api';

/**
 * App-wide QueryClient singleton.
 *
 * Lives outside `main.tsx` so non-component modules (e.g. the vault store,
 * which must purge sensitive caches on lock) can reach the same cache the
 * provider renders from.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Refetching on every window focus is noisy for a reading tool; the
      // dataset changes only when the user changes it.
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: (failureCount, error) => {
        // Retry only genuinely transient failures (timeout / network blip /
        // 429 / 5xx), using the server's `retriable` flag which the API client
        // surfaces on HttpError. A permanent validation error is never retried.
        if (error instanceof HttpError && !error.retriable) return false;
        return failureCount < 2;
      },
    },
    mutations: { retry: false },
  },
});
