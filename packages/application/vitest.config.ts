import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 10_000,
    bail: 1,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov', 'json'],
      reportsDirectory: '../../coverage/js/application',
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
  },
  resolve: {
    alias: {
      '@balanceframe/protocol-generated': resolve(__dirname, '../protocol-generated/src'),
      '@balanceframe/protocol-generated/validators': resolve(__dirname, '../protocol-generated/src/validators.ts'),
      '@balanceframe/actual-adapter': resolve(__dirname, '../actual-adapter/src'),
      '@balanceframe/actual-adapter/types': resolve(__dirname, '../actual-adapter/src/types.ts'),
      '@balanceframe/actual-adapter/credentials': resolve(__dirname, '../actual-adapter/src/credentials.ts'),
      '@balanceframe/actual-adapter/connector': resolve(__dirname, '../actual-adapter/src/connector.ts'),
      '@balanceframe/actual-adapter/normalizer': resolve(__dirname, '../actual-adapter/src/normalizer.ts'),
      '@balanceframe/workflow-store': resolve(__dirname, '../workflow-store/src'),
      '@balanceframe/workflow-store/types': resolve(__dirname, '../workflow-store/src/types.ts'),
    },
  },
});
