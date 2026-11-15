import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { request } from 'node:http';
const writeResult = process.stdout.write.bind(process.stdout);
const root = process.argv[2];
const { loadNuxt, build } = await import(
  pathToFileURL(join(root, 'apps/web/node_modules/nuxt/dist/index.mjs')).href
);
const directory = realpathSync(await mkdtemp(join(tmpdir(), 'balanceframe-nuxt-advisories-')));
const project = join(directory, 'project');
let nuxt;
process.once('SIGTERM', () => {
  void (async () => {
    try {
      await nuxt?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
      process.exit(143);
    }
  })();
});
function get(port, path, name) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          siblingMarker: body.includes('SYNTHETIC_PARENT_FILE_MARKER'),
          protectedMarker: body.includes('SYNTHETIC_PROTECTED_PAGE'),
          ordinaryMarker: body.includes('SYNTHETIC_ORDINARY_PAGE'),
          privateMarker: body.includes('SYNTHETIC_PRIVATE_RUNTIME_MARKER'),
          nonempty: body.trim().length > 0,
        }),
      );
      response.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error(`Owned probe request timed out: ${name}`)));
    req.end();
  });
}
try {
  await mkdir(join(project, 'app/pages'), { recursive: true });
  await mkdir(join(project, 'server/middleware'), { recursive: true });
  await writeFile(join(directory, 'pnpm-workspace.yaml'), 'onlyBuiltDependencies: []\n');
  const sibling = join(directory, 'synthetic-sibling.txt');
  await writeFile(sibling, 'SYNTHETIC_PARENT_FILE_MARKER');
  await writeFile(
    join(project, 'package.json'),
    '{"name":"fictional-nuxt-security","private":true,"type":"module"}',
  );
  await writeFile(join(project, 'app/app.vue'), '<template><NuxtPage /></template>');
  await writeFile(
    join(project, 'app/pages/index.vue'),
    '<template><main>SYNTHETIC_ORDINARY_PAGE</main></template>',
  );
  await writeFile(
    join(project, 'app/pages/admin.vue'),
    '<template><main>SYNTHETIC_PROTECTED_PAGE</main></template>',
  );
  await writeFile(
    join(project, 'server/middleware/guard.ts'),
    "export default defineEventHandler(event => { if (event.path.startsWith('/admin')) throw createError({statusCode:401}); });",
  );
  await symlink(join(root, 'apps/web/node_modules'), join(project, 'node_modules'), 'junction');
  nuxt = await loadNuxt({
    cwd: project,
    dev: true,
    overrides: {
      rootDir: project,
      srcDir: join(project, 'app'),
      buildDir: join(project, '.nuxt'),
      modules: [],
      devtools: { enabled: false },
      telemetry: false,
      runtimeConfig: { privateMarker: 'SYNTHETIC_PRIVATE_RUNTIME_MARKER' },
      devServer: { host: '127.0.0.1' },
      vite: { cacheDir: join(directory, '.vite-cache') },
    },
  });
  nuxt.hook('vite:serverCreated', (server) => {
    const cachePath = relative(directory, server.config.cacheDir);
    if (cachePath.startsWith('..') || isAbsolute(cachePath))
      throw new Error('Vite cache escaped the owned fixture root');
  });
  await build(nuxt);
  const listener = await nuxt.server.listen(0, {
    hostname: '127.0.0.1',
    public: false,
    showURL: false,
  });
  const port = listener.server.address().port;
  const results = {
    generated: {
      appSecretNonempty:
        (await readFile(join(project, '.nuxt/app-secret'), 'utf8')).trim().length > 0,
      devBundlePrivateMarker: (
        await readFile(join(project, '.nuxt/dev/index.mjs'), 'utf8')
      ).includes('SYNTHETIC_PRIVATE_RUNTIME_MARKER'),
    },
  };
  for (const [name, path] of Object.entries({
    ordinary: '/',
    normal: '/admin',
    dot: '/%2e/admin',
    parent: '/x/%2e%2e/admin',
    double: '//x/admin',
    triple: '///x/admin',
    sibling: '/_nuxt/@fs' + pathToFileURL(sibling).pathname,
    appSecret: '/_nuxt/@fs' + pathToFileURL(join(project, '.nuxt/app-secret')).pathname,
    devBundle: '/_nuxt/@fs' + pathToFileURL(join(project, '.nuxt/dev/index.mjs')).pathname,
  }))
    results[name] = await get(port, path, name);
  writeResult('SECURITY_PROBE_RESULT ' + JSON.stringify(results) + '\n');
} finally {
  if (nuxt) await nuxt.close();
  await rm(directory, { recursive: true, force: true });
}
