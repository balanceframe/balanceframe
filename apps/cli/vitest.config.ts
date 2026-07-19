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
      '@balanceframe/protocol-generated': resolve(__dirname, '../../packages/protocol-generated/src'),
      '@balanceframe/protocol-generated/validators': resolve(__dirname, '../../packages/protocol-generated/src/validators.ts'),
      '@balanceframe/application': resolve(__dirname, '../../packages/application/src'),
      '@balanceframe/application/*': resolve(__dirname, '../../packages/application/src/*'),
      '@balanceframe/actual-adapter': resolve(__dirname, '../../packages/actual-adapter/src'),
      '@balanceframe/actual-adapter/types': resolve(__dirname, '../../packages/actual-adapter/src/types.ts'),
      '@balanceframe/actual-adapter/credentials': resolve(__dirname, '../../packages/actual-adapter/src/credentials.ts'),
    },
  },
});
