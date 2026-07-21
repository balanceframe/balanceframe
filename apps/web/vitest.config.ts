import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

const srcDir = resolve(__dirname, '../../packages/workflow-store/src');

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 10_000,
    bail: 1,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov', 'json'],
      reportsDirectory: '../../coverage/js/web',
      include: ['src/**'],
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
  },
  server: {
    deps: {
      // better-sqlite3 is a native addon — must not be bundled by Vite.
      external: ['better-sqlite3'],
    },
  },
});
