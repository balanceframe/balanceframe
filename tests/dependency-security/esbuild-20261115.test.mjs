import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { pathToFileURL } from 'node:url';

const root = process.env.BALANCEFRAME_ESBUILD_TEST_ROOT || resolve(import.meta.dirname, '../..');
const require = createRequire(join(root, 'node_modules/.pnpm/node_modules/security-probe.cjs'));
const entry = require.resolve('fontless');
const ownerRequire = createRequire(entry);
const esbuild = ownerRequire('esbuild');
const { transformCSS, resolveMinifyCssEsbuildOptions } = await import(pathToFileURL(entry).href);
const expected = JSON.parse(
  readFileSync(new URL('./fixtures/fontless-20261115.json', import.meta.url), 'utf8'),
);
after(() => esbuild.stop());

for (const [scenario, dev, esbuildOptions] of [
  ['production-default', false, {}],
  ['development', true, {}],
  ['ascii', false, { charset: 'ascii' }],
  [
    'configured-minification',
    false,
    resolveMinifyCssEsbuildOptions({ minifyWhitespace: false, charset: 'utf8' }),
  ],
  ['error-fallback', false, { unsupportedSyntheticOption: true }],
]) {
  test(`fontless preserves its actual CSS consumer: ${scenario}`, async () => {
    const input = '@charset "UTF-8";\n.probe { font-family: "Próbé", sans-serif; color: red; }';
    const output = await transformCSS(
      {
        dev,
        processCSSVariables: 'font-prefixed-only',
        esbuildOptions,
        fontsToPreload: new Map(),
        shouldPreload: () => false,
        resolveFontFace: async (family) => {
          assert.equal(family, 'Próbé');
          return {
            fonts: [
              {
                src: [{ url: '/synthetic-probe.woff2', format: 'woff2' }],
                weight: '400',
                style: 'normal',
                display: 'swap',
              },
            ],
            fallbacks: [],
          };
        },
      },
      input,
      '/synthetic/input.css',
    );
    assert.equal(output.toString(), expected[scenario]);
    assert.deepEqual(
      output.generateMap({ hires: true, includeContent: true, source: 'input.css' }).sourcesContent,
      [input],
    );
  });
}

function get(port, path) {
  return new Promise((resolveResponse, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('error', reject);
      response.on('end', () => resolveResponse({ status: response.statusCode, body }));
    });
    req.setTimeout(5_000, () => req.destroy(new Error('Synthetic serve request timed out')));
    req.on('error', reject);
    req.end();
  });
}

test('esbuild rejects raw and encoded backslash traversal before serving sibling files', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'balanceframe-esbuild-containment-')));
  const publicDirectory = join(directory, 'public');
  mkdirSync(publicDirectory);
  const marker = 'SYNTHETIC_OUTSIDE_SERVE_ROOT';
  writeFileSync(join(directory, 'sibling-marker.txt'), marker);
  writeFileSync(join(publicDirectory, 'ordinary.txt'), 'ordinary synthetic file');
  let context;
  try {
    context = await esbuild.context({
      stdin: { contents: 'export {};', loader: 'js' },
      outfile: join(publicDirectory, 'bundle.js'),
      write: false,
      logLevel: 'silent',
    });
    const server = await context.serve({ host: '127.0.0.1', port: 0, servedir: publicDirectory });
    assert.deepEqual(await get(server.port, '/ordinary.txt'), {
      status: 200,
      body: 'ordinary synthetic file',
    });
    for (const path of ['/..\\sibling-marker.txt', '/..%5csibling-marker.txt']) {
      const result = await get(server.port, path);
      assert.equal(
        result.status,
        400,
        'backslashes must be rejected before filesystem interpretation',
      );
      assert.equal(result.body.includes(marker), false);
    }
  } finally {
    await context?.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
