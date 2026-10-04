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
      reportsDirectory: '../../coverage/js/cli',
      include: ['src/**', 'bin/**'],
      exclude: [
        'test/**',
        'test/build-smoke.test.ts',
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
      '@balanceframe/protocol-generated': resolve(
        import.meta.dirname,
        '../../packages/protocol-generated/src',
      ),
      '@balanceframe/protocol-generated/validators': resolve(
        import.meta.dirname,
        '../../packages/protocol-generated/src/validators.ts',
      ),
      '@balanceframe/application': resolve(import.meta.dirname, '../../packages/application/src'),
      '@balanceframe/application/*': resolve(import.meta.dirname, '../../packages/application/src/*'),
      '@balanceframe/actual-adapter': resolve(import.meta.dirname, '../../packages/actual-adapter/src'),
      '@balanceframe/actual-adapter/types': resolve(
        import.meta.dirname,
        '../../packages/actual-adapter/src/types.ts',
      ),
      '@balanceframe/actual-adapter/credentials': resolve(
        import.meta.dirname,
        '../../packages/actual-adapter/src/credentials.ts',
      ),
    },
  },
});
