import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
const root = process.argv[2];
const { loadNuxt, build: buildNuxt } = await import(
  pathToFileURL(join(root, 'apps/web/node_modules/nuxt/dist/index.mjs')).href
);
const directory = await mkdtemp(join(tmpdir(), 'balanceframe-nuxt-security-'));
let nuxt, child;
process.once('SIGTERM', () => {
  child?.kill('SIGKILL');
  void rm(directory, { recursive: true, force: true }).finally(() => process.exit(143));
});
try {
  await mkdir(join(directory, 'app'), { recursive: true });
  await symlink(join(root, 'apps/web/node_modules'), join(directory, 'node_modules'), 'junction');
  await writeFile(
    join(directory, 'app/app.vue'),
    `<script setup>const target='\\u0001javascript:SYNTHETIC_LINK'</script><template><main><NuxtLink :to="target">Synthetic link</NuxtLink><NuxtLink to="/ordinary">Ordinary link</NuxtLink></main></template>`,
  );
  nuxt = await loadNuxt({
    cwd: directory,
    dev: false,
    overrides: {
      rootDir: directory,
      srcDir: join(directory, 'app'),
      buildDir: join(directory, '.nuxt'),
      modules: [],
      pages: false,
      devtools: { enabled: false },
      telemetry: false,
      routeRules: { '/protected/**': { redirect: '/denied' } },
    },
  });
  await buildNuxt(nuxt);
  await nuxt.close();
  nuxt = null;
  const socket = createServer();
  await new Promise((r) => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  child = spawn(process.execPath, [join(directory, '.output/server/index.mjs')], {
    cwd: directory,
    env: {
      ...process.env,
      NITRO_HOST: '127.0.0.1',
      HOST: '127.0.0.1',
      NITRO_PORT: String(port),
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (c) => {
      logs = (logs + c).slice(-20000);
    });
  const base = 'http://127.0.0.1:' + port;
  let response;
  for (let i = 0; i < 150; i++) {
    try {
      response = await fetch(base, { signal: AbortSignal.timeout(500) });
      break;
    } catch {
      if (child.exitCode !== null) throw Error(logs);
      await delay(100);
    }
  }
  if (!response) throw Error('Server startup timeout ' + logs);
  const html = await response.text();
  const normal = await fetch(base + '/protected/secret', { redirect: 'manual' });
  const variant = await fetch(base + '/Protected/secret', { redirect: 'manual' });
  console.log(
    'SECURITY_PROBE_RESULT',
    JSON.stringify({
      rootStatus: response.status,
      normalStatus: normal.status,
      variantStatus: variant.status,
      normalLocation: normal.headers.get('location'),
      variantLocation: variant.headers.get('location'),
      link: html.match(/<a[^>]*>Synthetic link<\/a>/)?.[0],
      ordinary: html.match(/<a[^>]*>Ordinary link<\/a>/)?.[0],
    }),
  );
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('close', r));
  }
  if (nuxt) await nuxt.close();
  await rm(directory, { recursive: true, force: true });
}
