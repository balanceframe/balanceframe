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
      reportsDirectory: '../../coverage/js/inference',
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
      '@balanceframe/inference': resolve(import.meta.dirname, '../inference/src'),
      '@balanceframe/inference/types': resolve(import.meta.dirname, '../inference/src/types.ts'),
      '@balanceframe/inference/policy': resolve(import.meta.dirname, '../inference/src/policy.ts'),
      '@balanceframe/inference/redactor': resolve(import.meta.dirname, '../inference/src/redactor.ts'),
      '@balanceframe/inference/classifier': resolve(import.meta.dirname, '../inference/src/classifier.ts'),
      '@balanceframe/inference/orchestrator': resolve(
        import.meta.dirname,
        '../inference/src/orchestrator.ts',
      ),
      '@balanceframe/inference/providers/types': resolve(
        import.meta.dirname,
        '../inference/src/providers/types.ts',
      ),
      '@balanceframe/inference/providers/local': resolve(
        import.meta.dirname,
        '../inference/src/providers/local.ts',
      ),
      '@balanceframe/inference/providers/openai': resolve(
        import.meta.dirname,
        '../inference/src/providers/openai.ts',
      ),
      '@balanceframe/inference/validators': resolve(import.meta.dirname, '../inference/src/validators.ts'),
    },
  },
});
