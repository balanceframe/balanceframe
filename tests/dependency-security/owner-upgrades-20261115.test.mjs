import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
const root = process.env.BALANCEFRAME_RESIDUAL_TEST_ROOT || resolve(import.meta.dirname, '../..');
const web = createRequire(join(root, 'apps/web/package.json'));
const nuxt = createRequire(web.resolve('nuxt/package.json'));
const server = createRequire(nuxt.resolve('@nuxt/nitro-server/package.json'));
const nitro = createRequire(server.resolve('nitropack/package.json'));
test('Nitro Azure utilities load the retained archiver8 API and preserve ordinary ZIP content', async () => {
  await import(
    pathToFileURL(
      join(dirname(nitro.resolve('nitropack/package.json')), 'dist/presets/azure/utils.mjs'),
    ).href
  );
  const { ZipArchive } = nitro('archiver');
  const archive = new ZipArchive({ zlib: { level: 9 } }),
    chunks = [];
  const complete = new Promise((resolve, reject) => {
    archive.on('data', (c) => chunks.push(c));
    archive.on('end', resolve);
    archive.on('error', reject);
  });
  archive.append('SYNTHETIC_ZIP_CONTENT', { name: 'fixture.txt' });
  await archive.finalize();
  await complete;
  const AdmZip = web('adm-zip');
  assert.equal(
    new AdmZip(Buffer.concat(chunks)).readAsText('fixture.txt'),
    'SYNTHETIC_ZIP_CONTENT',
  );
});

test('DevTools captures Vite environment configuration without bypassing RPC authentication', async () => {
  const req = createRequire(nuxt.resolve('@nuxt/devtools/package.json'));
  const source = readFileSync(
    join(dirname(req.resolve('./package.json')), 'dist/chunks/module-main.mjs'),
    'utf8',
  );
  const start = source.indexOf('function setupServerDataRPC({');
  const end = source.indexOf('async function watchStorageMount(', start);
  assert.ok(start > 0 && end > start);
  const plugins = [],
    hooks = new Map();
  const setup = new Function(
    'addVitePlugin',
    source.slice(start, end) + ';return setupServerDataRPC;',
  )((plugin) => plugins.push(plugin));
  const rpc = setup({
    nuxt: { options: { rootDir: 'fictional-root' }, hook: (name, fn) => hooks.set(name, fn) },
    ensureDevAuthToken: async (token) => {
      if (token !== 'fixture-token') throw Error('fixture denial');
    },
  });
  const config = {
    root: 'fictional-root',
    env: { MODE: 'fictional' },
    plugins: [{ name: 'ordinary', api: { marker: 'private-plugin-api' } }],
    inlineConfig: { marker: 'private-inline' },
  };
  if (hooks.has('vite:serverCreated'))
    hooks.get('vite:serverCreated')(
      {
        config,
        environments: {
          client: { config, plugins: config.plugins },
          ssr: { config, plugins: config.plugins },
        },
      },
      { isClient: true, isServer: true },
    );
  else
    for (const name of ['client', 'ssr'])
      for (const plugin of plugins)
        plugin.buildStart.call({ environment: { name, config, getTopLevelConfig: () => config } });
  await assert.rejects(rpc.getServerData('wrong-token'), /fixture denial/);
  const result = await rpc.getServerData('fixture-token');
  for (const name of ['client', 'server']) {
    assert.equal(result.vite[name].root, 'fictional-root');
    assert.deepEqual(result.vite[name].environments, { MODE: null });
    assert.equal(result.vite[name].plugins[0].api, undefined);
    assert.equal(result.vite[name].inlineConfig, null);
  }
});
