// @vitest-environment node
import { isBuiltin, createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import type { UserConfig } from 'vitest/config';
import { describe, expect, it } from 'vitest';

const webRoot = resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
// Use the Vue plugin's declared Vite peer without adding a dependency.
const vitePath = createRequire(require.resolve('@vitejs/plugin-vue')).resolve('vite');
const { build } = await import(pathToFileURL(vitePath).href) as {
  build: (config: UserConfig) => Promise<unknown>;
};
const serverPackages = ['@balanceframe/native', '@balanceframe/workflow-store', '@actual-app/api', 'better-sqlite3'];

describe('Decision Card explanation browser boundary', () => {
  it('bundles the actual component through production exports without server modules', async () => {
    await expect(build({
      root: webRoot,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'reject-server-imports',
          enforce: 'pre',
          resolveId(id) {
            if (isBuiltin(id) || serverPackages.some((name) => id === name || id.startsWith(name + '/')))
              throw new Error('Browser explanation imported server-only module: ' + id);
          },
        },
        vue(),
      ],
      build: {
        write: false,
        minify: false,
        lib: {
          entry: resolve(webRoot, 'app/components/DecisionCardExplanation.vue'),
          formats: ['es'],
        },
      },
    })).resolves.toBeDefined();
  });

  it.each([
    ['application', 'dist/application/src/decision-card-explanation.js'],
    ['inference', 'dist/decision-card-explanation.js'],
  ])('exposes the existing %s explanation module as a supported subpath', (name, target) => {
    expect(require.resolve('@balanceframe/' + name + '/decision-card-explanation')).toBe(
      resolve(webRoot, '../../packages', name, target),
    );
  });
});
