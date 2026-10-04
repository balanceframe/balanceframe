import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

const workflowStoreSrcDir = resolve(import.meta.dirname, '../../packages/workflow-store/src');
const applicationSrcDir = resolve(import.meta.dirname, '../../packages/application/src');

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@balanceframe/workflow-store': workflowStoreSrcDir,
      '@balanceframe/workflow-store/*': resolve(workflowStoreSrcDir, '*'),
      '@balanceframe/application': applicationSrcDir,
      '@balanceframe/application/*': resolve(applicationSrcDir, '*'),
      // Nuxt virtual modules — tests supply their runtime exports with vi.mock.
      '#app': resolve(import.meta.dirname, 'test/nuxt-app-shim.ts'),
      '#imports': resolve(import.meta.dirname, 'test/nuxt-app-shim.ts'),
      // Match Nuxt's srcDir alias for components and pages imported directly by Vitest.
      '@': resolve(import.meta.dirname, 'app'),
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
    testTimeout: 10_000,
    bail: 1,
    coverage: {
      provider: 'v8',
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
    server: {
      deps: {
        // better-sqlite3 is a native addon — must not be bundled by Vite.
        external: ['better-sqlite3'],
        inline: ['@nuxt/ui'],
      },
    },
  },
});
