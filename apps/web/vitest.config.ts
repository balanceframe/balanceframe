import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

const srcDir = resolve(__dirname, '../../packages/workflow-store/src');

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 10_000,
    bail: 1,
    globals: true,
  },
  resolve: {
    alias: [
      { find: '@balanceframe/workflow-store', replacement: srcDir },
    ],
  },
});
