import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.mjs'],
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov', 'json'],
      reportsDirectory: '../../coverage/js/receipt-ocr',
      include: ['src/**'],
    },
  },
});
