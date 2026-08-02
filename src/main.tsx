import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { HttpError } from '@/lib/api';
import { App } from '@/App';
import '@/styles/index.css';

const queryClient = new QueryClient({
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

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

// Install the service worker only in production, after the app is interactive.
// In dev (Vite) the caching layer would mask hot reloads and is best skipped.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[tagnest] service worker registration failed:', err);
    });
  });
}

