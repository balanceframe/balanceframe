import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 10_000,
    bail: 1,
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
    },
  },
});
