import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },

  server: {
    port: 5173,
    // `wrangler pages dev` serves the API on 8788 during local development.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: true,
      },
    },
  },

  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 700,
    // Some sandboxed/managed environments block the recursive unlink Vite uses
    // to clear the output directory, which fails the build for no good reason.
    // TN_KEEP_DIST=1 skips the wipe; CI leaves it unset and gets a clean dir.
    emptyOutDir: process.env.TN_KEEP_DIST !== '1',
    rollupOptions: {
      output: {
        // Keep the initial payload small: React and the data layer change far
        // less often than app code, so they get their own long-lived chunks.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react';
          if (id.includes('@tanstack')) return 'vendor-query';
          if (id.includes('lucide-react')) return 'vendor-icons';
        },
      },
    },
  },

  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    css: false,
  },
});
