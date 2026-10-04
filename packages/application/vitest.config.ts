import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    // Native integration tests need process isolation; worker threads can
    // segfault during addon teardown on macOS ARM64.
    pool: 'forks',
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
      '@balanceframe/protocol-generated': resolve(import.meta.dirname, '../protocol-generated/src'),
      '@balanceframe/protocol-generated/validators': resolve(
        import.meta.dirname,
        '../protocol-generated/src/validators.ts',
      ),
      '@balanceframe/actual-adapter': resolve(import.meta.dirname, '../actual-adapter/src'),
      '@balanceframe/actual-adapter/types': resolve(import.meta.dirname, '../actual-adapter/src/types.ts'),
      '@balanceframe/actual-adapter/credentials': resolve(
        import.meta.dirname,
        '../actual-adapter/src/credentials.ts',
      ),
      '@balanceframe/actual-adapter/connector': resolve(
        import.meta.dirname,
        '../actual-adapter/src/connector.ts',
      ),
      '@balanceframe/actual-adapter/normalizer': resolve(
        import.meta.dirname,
        '../actual-adapter/src/normalizer.ts',
      ),
      '@balanceframe/workflow-store': resolve(import.meta.dirname, '../workflow-store/src'),
      '@balanceframe/workflow-store/types': resolve(import.meta.dirname, '../workflow-store/src/types.ts'),
    },
  },
});
