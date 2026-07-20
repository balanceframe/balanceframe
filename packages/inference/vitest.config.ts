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
      '@balanceframe/protocol-generated': resolve(__dirname, '../protocol-generated/src'),
      '@balanceframe/protocol-generated/validators': resolve(__dirname, '../protocol-generated/src/validators.ts'),
      '@balanceframe/inference': resolve(__dirname, '../inference/src'),
      '@balanceframe/inference/types': resolve(__dirname, '../inference/src/types.ts'),
      '@balanceframe/inference/policy': resolve(__dirname, '../inference/src/policy.ts'),
      '@balanceframe/inference/redactor': resolve(__dirname, '../inference/src/redactor.ts'),
      '@balanceframe/inference/classifier': resolve(__dirname, '../inference/src/classifier.ts'),
      '@balanceframe/inference/orchestrator': resolve(__dirname, '../inference/src/orchestrator.ts'),
      '@balanceframe/inference/providers/types': resolve(__dirname, '../inference/src/providers/types.ts'),
      '@balanceframe/inference/providers/local': resolve(__dirname, '../inference/src/providers/local.ts'),
      '@balanceframe/inference/providers/openai': resolve(__dirname, '../inference/src/providers/openai.ts'),
      '@balanceframe/inference/validators': resolve(__dirname, '../inference/src/validators.ts'),
    },
  },
});
