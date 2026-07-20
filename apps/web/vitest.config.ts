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
  },
  resolve: {
    alias: [
      { find: '@balanceframe/workflow-store', replacement: srcDir },
    ],
  },
});
