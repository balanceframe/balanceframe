// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';
import { expect, it } from 'vitest';

it('archives Nitro Azure functions with nested, hidden and followed-symlink content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'balanceframe-nitro-archive-'));
  try {
    const outputDir = join(root, 'output');
    const serverDir = join(outputDir, 'server');
    const linkedDir = join(root, 'linked-source');
    await mkdir(join(serverDir, 'assets', 'nested'), { recursive: true });
    await mkdir(join(outputDir, '.hidden'), { recursive: true });
    await mkdir(linkedDir);

    const nestedContent = Buffer.from([0, 1, 127, 128, 255]);
    await writeFile(join(serverDir, 'index.mjs'), 'export const handle = () => "ok";\n');
    await writeFile(join(serverDir, 'assets', 'nested', 'data.bin'), nestedContent);
    await writeFile(join(outputDir, '.hidden', 'config.json'), '{"hidden":true}\n');
    await writeFile(join(linkedDir, 'external.txt'), 'followed symlink content\n');
    await symlink(linkedDir, join(outputDir, 'linked'), 'junction');

    // Resolve the Nitro instance Nuxt actually uses, including pnpm's dependency isolation.
    const require = createRequire(import.meta.url);
    const nuxtRequire = createRequire(require.resolve('nuxt/package.json'));
    const nitroServerRequire = createRequire(nuxtRequire.resolve('@nuxt/nitro-server/package.json'));
    const nitroRoot = dirname(nitroServerRequire.resolve('nitropack/package.json'));
    const { writeFunctionsRoutes } = await import(
      pathToFileURL(join(nitroRoot, 'dist/presets/azure/utils.mjs')).href
    );
    await writeFunctionsRoutes({ options: { output: { dir: outputDir, serverDir } } });

    const host = { version: '2.0', extensions: { http: { routePrefix: '' } } };
    const functionDefinition = {
      entryPoint: 'handle',
      bindings: [
        {
          authLevel: 'anonymous',
          type: 'httpTrigger',
          direction: 'in',
          name: 'req',
          route: '{*url}',
          methods: ['delete', 'get', 'head', 'options', 'patch', 'post', 'put'],
        },
        { type: 'http', direction: 'out', name: 'res' },
      ],
    };
    expect(JSON.parse(await readFile(join(outputDir, 'host.json'), 'utf8'))).toEqual(host);
    expect(JSON.parse(await readFile(join(serverDir, 'function.json'), 'utf8'))).toEqual(
      functionDefinition,
    );

    const archive = new AdmZip(await readFile(join(outputDir, 'deploy.zip')));
    const expectedFiles: Record<string, Buffer> = {
      '.hidden/config.json': Buffer.from('{"hidden":true}\n'),
      'host.json': Buffer.from(JSON.stringify(host)),
      'linked/external.txt': Buffer.from('followed symlink content\n'),
      'server/assets/nested/data.bin': nestedContent,
      'server/function.json': Buffer.from(JSON.stringify(functionDefinition)),
      'server/index.mjs': Buffer.from('export const handle = () => "ok";\n'),
    };
    // The generated archive is not an input fixture; Nitro may glob it while writing.
    const archivedNames = archive
      .getEntries()
      .map((entry) => entry.entryName)
      .filter((name) => name !== 'deploy.zip')
      .sort();
    expect(archivedNames).toEqual(Object.keys(expectedFiles).sort());
    for (const [name, content] of Object.entries(expectedFiles)) {
      expect(archive.readFile(name), name).toEqual(content);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
