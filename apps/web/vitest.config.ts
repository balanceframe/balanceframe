import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

const srcDir = resolve(__dirname, '../../packages/workflow-store/src');

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      // Nuxt virtual module — resolved to a test shim so middleware tests
      // can mock #app imports via vi.mock outside the Nuxt build pipeline.
      '#app': resolve(__dirname, 'test/nuxt-app-shim.ts'),
      // Match Nuxt's srcDir alias for components and pages imported directly by Vitest.
      '@': resolve(__dirname, 'app'),
      // Nuxt/Nitro server-utils path — `../../utils/` from server/api/* files
      // resolves to server/utils/ via the alias.
      '../../utils': resolve(__dirname, 'server/utils'),
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
    testTimeout: 10_000,
    bail: 1,
    coverage: {
      provider: 'v8',
      all: true,
      reporter: ['text-summary', 'lcov', 'json'],
      reportsDirectory: '../../coverage/js/web',
      include: [
        'src/**',
        'app/**',
        'server/**',
        'lib/**',
        'composables/**',
        'types/**',
        'nuxt.config.ts',
      ],
      exclude: [
        'test/**',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/__tests__/**',
        '**/fixtures/**',
        '**/node_modules/**',
        'dist/**',
        'build/**',
      ],
    },
    globals: true,
    env: {
      // Use an in-memory SQLite database for Better Auth during tests.
      BALANCEFRAME_AUTH_DB_PATH: ':memory:',
    },
    setupFiles: ['./vitest.setup.ts'],
  },
  server: {
    deps: {
      // better-sqlite3 is a native addon — must not be bundled by Vite.
      external: ['better-sqlite3'],
    },
  },
});
