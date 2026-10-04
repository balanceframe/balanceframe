// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { it } from 'vitest';

const WEB_ROOT = resolve(import.meta.dirname, '../..');

it('exposes distinct resolved Vite environments through authorized DevTools RPC', { timeout: 180_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'balanceframe-devtools-'));
  try {
    await mkdir(resolve(root, 'app'));
    await mkdir(resolve(root, 'config/.nuxt/devtools'), { recursive: true });
    await symlink(resolve(WEB_ROOT, 'node_modules'), resolve(root, 'node_modules'), 'junction');
    await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'devtools-fixture', private: true, type: 'module' }));
    await writeFile(resolve(root, 'app/app.vue'), '<template><h1>DevTools fixture</h1></template>');
    await writeFile(resolve(root, 'config/.nuxt/devtools/dev-auth-token.txt'), 'isolated-devtools-fixture-token');
    const env: typeof process.env = { ...process.env, NODE_ENV: 'development', XDG_CONFIG_HOME: resolve(root, 'config') };
    delete env.TEST;
    delete env.VITEST;
    execFileSync(process.execPath, ['--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import { build, loadNuxt } from 'nuxt';
      const root = process.argv[1];
      const nuxt = await loadNuxt({ cwd: root, overrides: {
        dev: true, test: false, ssr: true, telemetry: false,
        compatibilityDate: '2026-07-01', devtools: { enabled: true },
        vite: { server: { ws: { port: 0 } } },
      } });
      const servers = [];
      nuxt.hook('vite:serverCreated', server => { servers.push(server); });
      try {
        await build(nuxt);
        for (const server of servers) {
          for (const name of ['client', 'ssr']) {
            await server.environments[name].transformRequest('/@fs' + root + '/app/app.vue');
          }
        }
        const getServerData = nuxt.devtools.rpc.functions.getServerData;
        await assert.rejects(() => getServerData('invalid-token'), /Invalid dev auth token/);
        const data = await getServerData('isolated-devtools-fixture-token');
        assert.equal(data.vite.client?.root, nuxt.options.srcDir, 'Client configuration must be captured');
        assert.equal(data.vite.server?.root, nuxt.options.srcDir, 'Server configuration must be captured');
        assert.equal(data.vite.client.consumer, 'client');
        assert.equal(data.vite.server.consumer, 'server');
      } finally { await nuxt.close(); }
    `, root], { cwd: WEB_ROOT, env, stdio: 'pipe' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
