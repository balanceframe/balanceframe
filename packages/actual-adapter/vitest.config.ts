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
    },
  },
});
