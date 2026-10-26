// @vitest-environment node
import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';

it('preserves Zod inlining and the native Actual/SQLite production boundaries', async () => {
  vi.stubGlobal('defineNuxtConfig', <T>(config: T): T => config);
  try {
    const { default: config } = await import('../nuxt.config');
    const externals = config.nitro?.externals;
    if (!externals) throw new Error('Explicit production externals are required');
    expect(externals.inline).toContain('zod');
    expect(externals.external).toContain('better-sqlite3');
    expect(externals.traceInclude).toContain(createRequire(import.meta.url).resolve('@actual-app/api'));

    const isExternal = config.nitro?.rollupConfig?.external;
    if (typeof isExternal !== 'function') throw new Error('Actual package externalization is required');
    expect(isExternal('@actual-app/api', undefined, false)).toBe(true);
    expect(isExternal('@actual-app/api/internal', undefined, false)).toBe(true);
    expect(isExternal('@actual-app/api-other', undefined, false)).toBe(false);
    expect(isExternal('zod', undefined, false)).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});
