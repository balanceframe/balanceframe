import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';


loadEnv({ path: resolve(__dirname, '.env.test') });

export default defineConfig({
  test: {
    // Integration tests connect to a live Actual server; they can take time.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    teardownTimeout: 30_000,

    // Node environment — no DOM needed.
    environment: 'node',
    setupFiles: [resolve(__dirname, 'setup.ts')],

    // Actual's embedded API owns process-global services, and the fixture
    // server rate-limits concurrent authentication. Run live proof files
    // serially so each client lifecycle is isolated.
    fileParallelism: false,

    // Fail fast on integration test regression.
    bail: 1,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov', 'json'],
      reportsDirectory: '../../../coverage/js/actual-integration',
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

    // Live proofs are deterministic and must not mask failures with retries.
    retry: 0,

    // Output
    reporters: ['default', 'verbose'],
    outputFile: { junit: './test-results/junit.xml' },

    // Global test file patterns.
    include: ['*.test.ts'],

    // Env: load .env.test if present (created by setup-fixture-server.sh).
    env: {
      NODE_ENV: 'production',
      // These can be overridden by .env.test or environment.
      ACTUAL_SERVER_URL: process.env.ACTUAL_SERVER_URL || 'http://localhost:5006',
      ACTUAL_SECRET_KEY: process.env.ACTUAL_SECRET_KEY || '',
      ACTUAL_BUDGET_ID: process.env.ACTUAL_BUDGET_ID || '',
      ACTUAL_GROUP_ID: process.env.ACTUAL_GROUP_ID || '',
    },
  },

  resolve: {
    alias: {
      // Allow tests to import from the monorepo workspace packages.
      '@balanceframe/actual-adapter': resolve(
        __dirname,
        '../../packages/actual-adapter/src',
      ),
      '@balanceframe/workflow-store': resolve(
        __dirname,
        '../../packages/workflow-store/src',
      ),
      '@balanceframe/protocol-generated': resolve(
        __dirname,
        '../../packages/protocol-generated/src',
      ),
    },
  },
});
