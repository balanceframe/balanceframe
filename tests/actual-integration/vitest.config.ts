import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    // Integration tests connect to a live Actual server; they can take time.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    teardownTimeout: 30_000,

    // Node environment — no DOM needed.
    environment: 'node',

    // Fail fast on integration test regression.
    bail: 1,

    // Retry flaky network-dependent tests once.
    retry: 1,

    // Output
    reporters: ['default', 'verbose'],
    outputFile: { junit: './test-results/junit.xml' },

    // Global test file patterns.
    include: ['*.test.ts'],

    // Env: load .env.test if present (created by setup-fixture-server.sh).
    env: {
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
    },
  },
});
