import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { queryClient } from '@/lib/queryClient';
import { App } from '@/App';
import '@/styles/index.css';
import '@/styles/atelier.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

// Global runtime error net. ErrorBoundary catches render-time exceptions, but
// fire-and-forget async work (event handlers, timers, dynamic imports) can
// still reject outside React's tree. Log with a stable prefix so production
// console telemetry is greppable; the browser devtools surface the rest.
window.addEventListener('error', (event) => {
  console.error('[tagnest] uncaught error', event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[tagnest] unhandled rejection', event.reason);
});

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

