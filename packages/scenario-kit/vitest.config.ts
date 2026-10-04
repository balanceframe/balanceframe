import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Each live case owns an Actual and Nuxt child; native addons need fork isolation.
    pool: 'forks',
    maxWorkers: 1,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov', 'json'],
      reportsDirectory: '../../coverage/js/scenario-kit',
      include: ['src/**'],
      exclude: ['test/**', '**/*.test.ts', '**/node_modules/**', 'dist/**'],
    },
  },
});
