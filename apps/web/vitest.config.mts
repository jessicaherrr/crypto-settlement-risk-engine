import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    // Most of this app's logic (lib/format, lib/escrow, lib/indexer, API
    // route handlers) is plain Node code with no DOM - default to the
    // faster `node` environment and opt individual component test files
    // into jsdom with a `// @vitest-environment jsdom` comment.
    environment: 'node',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    alias: {
      // The real `server-only` package's whole purpose is to make an
      // accidental client-bundle import fail Next.js's build; it isn't
      // meant to run under a plain Node test runner at all, so route it
      // to a no-op module here instead of trying to satisfy it for real.
      'server-only': new URL('./vitest.server-only-stub.ts', import.meta.url).pathname,
    },
  },
});
