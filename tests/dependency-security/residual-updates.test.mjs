import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const root = process.env.BALANCEFRAME_RESIDUAL_TEST_ROOT || resolve(import.meta.dirname, '../..');
const require = createRequire(join(root, 'node_modules/.pnpm/node_modules/security-probe.cjs'));

test('approved override edges satisfy their actual consuming package ranges', () => {
  const semver = require('semver');
  const lock = require('yaml').parse(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const targets = new Set([
    'nitropack',
    '@nuxt/devtools',
    'postcss',
    'baseline-browser-mapping',
    'fast-uri',
    'brace-expansion',
    'serialize-javascript',
  ]);
  const directory = join(root, 'node_modules/.pnpm');
  const installed = readdirSync(directory);
  let checked = 0;
  for (const [key, snapshot] of Object.entries(lock.snapshots)) {
    const owner = key.split('(')[0];
    const separator = owner.lastIndexOf('@');
    const name = owner.slice(0, separator),
      ownerVersion = owner.slice(separator + 1);
    for (const [target, resolution] of Object.entries(snapshot.dependencies ?? {})) {
      if (!targets.has(target)) continue;
      const resolved = resolution.split('(')[0];
      for (const [selector, version] of Object.entries(manifest.pnpm.overrides)) {
        const parts = selector.split('>');
        if (parts.at(-1) !== target) continue;
        if (parts.length > 1) {
          const parentSeparator = parts[0].lastIndexOf('@');
          if (
            name !== parts[0].slice(0, parentSeparator) ||
            !semver.satisfies(ownerVersion, parts[0].slice(parentSeparator + 1))
          )
            continue;
        }
        assert.equal(resolved, version, `${owner} uses the exact configured ${target} override`);
      }
      const prefix = name.replace('/', '+') + '@' + ownerVersion;
      const entry = installed.find((value) => value === prefix || value.startsWith(prefix + '_'));
      assert.ok(entry, `installed owner ${owner}`);
      const dependency = JSON.parse(
        readFileSync(join(directory, entry, 'node_modules', target, 'package.json'), 'utf8'),
      );
      assert.equal(
        dependency.version,
        resolved,
        `${owner}'s installed ${target} matches its lock edge`,
      );
      const metadata = JSON.parse(
        readFileSync(join(directory, entry, 'node_modules', name, 'package.json'), 'utf8'),
      );
      const range =
        metadata.dependencies?.[target] ??
        metadata.optionalDependencies?.[target] ??
        metadata.peerDependencies?.[target];
      assert.ok(range, `${owner} declares ${target}`);
      assert.ok(
        semver.satisfies(resolved, range),
        `${owner} requires ${target} ${range}; resolved ${resolved}`,
      );
      checked++;
    }
  }
  assert.ok(checked > 0, 'the configured dependency edges were validated');
});

test('PostCSS does not disclose an absolute annotated map without a source file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'balanceframe-postcss-security-'));
  try {
    const map = {
      version: 3,
      sources: ['synthetic-private.ts'],
      names: [],
      mappings: 'AAAA',
      sourcesContent: ['SYNTHETIC_PRIVATE_SOURCE'],
    };
    const path = join(directory, 'private.map');
    writeFileSync(path, JSON.stringify(map));
    const tailwindRequire = createRequire(require.resolve('@tailwindcss/postcss'));
    const postcss = tailwindRequire('postcss');
    const result = await postcss([]).process(`a{color:red}\n/*# sourceMappingURL=${path} */`, {
      from: undefined,
      map: { inline: false },
    });
    assert.doesNotMatch(JSON.stringify(result.map?.toJSON()) ?? '', /SYNTHETIC_PRIVATE_SOURCE/);
    const ordinary = await postcss([]).process('a{color:red}', {
      from: 'ordinary.css',
      map: { inline: false },
    });
    assert.match(ordinary.css, /a\{color:red\}/);
    assert.ok(ordinary.map.toJSON().sources.some((source) => source.endsWith('ordinary.css')));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Nuxt CSS optimization bounds selector work or removes the affected parser dependency', async () => {
  let parser;
  try {
    parser = require('postcss-selector-parser');
  } catch (error) {
    assert.equal(error.code, 'MODULE_NOT_FOUND');
    const calcRequire = createRequire(require.resolve('postcss-calc'));
    assert.throws(() => calcRequire.resolve('postcss-selector-parser'), {
      code: 'MODULE_NOT_FOUND',
    });
    const postcss = require('postcss');
    const result = await postcss([require('cssnano')()]).process('.a { color: rgb(255,0,0) }', {
      from: undefined,
    });
    assert.equal(result.css, '.a{color:red}');
    return;
  }
  const original = Array.prototype.indexOf;
  let scanned = 0;
  Array.prototype.indexOf = function (...args) {
    scanned += this.length;
    return original.apply(this, args);
  };
  let ast;
  try {
    ast = parser().astSync('.a'.repeat(256));
  } finally {
    Array.prototype.indexOf = original;
  }
  assert.equal(ast.first.nodes.length, 256);
  assert.ok(scanned < 256 * 20, `flat selector performed ${scanned} array-search steps`);
  assert.equal(parser().processSync('a.b\\.c#d:hover'), 'a.b\\.c#d:hover');
});

test('baseline browser mapping throws on invalid configuration without terminating its caller', () => {
  const script = `
    const assert = require('node:assert/strict');
    const mapping = require(${JSON.stringify(require.resolve('baseline-browser-mapping'))});
    assert.throws(() => mapping.getCompatibleVersions({ targetYear: 2020, widelyAvailableOnDate: '2020-01-01' }));
    assert.throws(() => mapping.getCompatibleVersions({ includeDownstreamBrowsers: false, includeKaiOS: true }));
    const versions = mapping.getCompatibleVersions({ targetYear: 2020, suppressWarnings: true });
    assert.ok(versions.some(entry => entry.browser === 'chrome'));
    process.stdout.write('caller-survived');
  `;
  const child = spawnSync(process.execPath, ['--input-type=commonjs', '-e', script], {
    timeout: 3000,
    encoding: 'utf8',
    maxBuffer: 65536,
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'caller-survived');
});

test('fast-uri folds percent-decoded scheme-relative hosts before comparison', () => {
  const uri = require('fast-uri');
  assert.equal(uri.parse('//%41.com').host, 'a.com');
  assert.equal(uri.equal('//%41.com', '//a.com'), true);
  assert.equal(uri.parse('//Example.com').host, 'example.com');
});

test('fast-uri refuses encoded schemes instead of activating them', () => {
  const uri = require('fast-uri');
  for (const value of ['%6Aavascript:alert(1)', '%u006Aavascript:alert(1)']) {
    assert.notEqual(uri.parse(value).scheme, 'javascript');
    assert.notEqual(uri.normalize(value), 'javascript:alert(1)');
  }
  assert.equal(uri.normalize('https://example.com/budget'), 'https://example.com/budget');
});

test('fast-uri preserves relative-path references before resolution', () => {
  const uri = require('fast-uri');
  assert.equal(uri.normalize('../x'), '../x');
  assert.equal(
    uri.resolve('https://example.com/budget/', uri.normalize('a/../b')),
    'https://example.com/budget/b',
  );
  assert.equal(uri.resolve('https://example.com/budget/', '../x'), 'https://example.com/x');
});

test('fast-uri reports malformed authorities rather than silently rewriting their hosts', () => {
  const uri = require('fast-uri');
  for (const value of ['http://a@b@evil.example/', 'http://ex\tample.com/']) {
    assert.ok(uri.parse(value).error, 'ambiguous authority must fail parsing');
  }
  assert.equal(uri.parse('https://example.com/').host, 'example.com');
});

test('fast-uri escapes a first-segment colon in suffix references', () => {
  const uri = require('fast-uri');
  assert.equal(
    uri.serialize({ scheme: 'ignored', path: 'javascript:alert(1)' }, { reference: 'suffix' }),
    'javascript%3Aalert(1)',
  );
  assert.equal(uri.normalize('budget/plan', { reference: 'suffix' }), 'budget/plan');
});

test('brace-expansion bounds parser rewrites before output limits apply', () => {
  const { expand } = require('brace-expansion');
  const original = String.prototype.match;
  let rewrites = 0;
  String.prototype.match = function (pattern) {
    if (String(pattern) === '/,(?!,).*\\}/') rewrites++;
    return original.call(this, pattern);
  };
  try {
    expand('{a}' + '}'.repeat(300) + ',z}', { max: 2, maxLength: 10000, maxRewrites: 8 });
  } finally {
    String.prototype.match = original;
  }
  assert.ok(rewrites <= 8, `parser restarted ${rewrites} times`);
  assert.deepEqual(expand('file-{a,b}.{js,ts}'), [
    'file-a.js',
    'file-a.ts',
    'file-b.js',
    'file-b.ts',
  ]);
  assert.deepEqual(expand('{a},b}'), ['a}', 'b']);
});

test('serialization escapes a closing script token at the end of a function source', () => {
  const serialize = require('serialize-javascript');
  function value() {}
  value.toString = () => 'function value(){ return 1 }//</script';
  assert.doesNotMatch(serialize({ value }, { space: 2 }), /<\/script/i);
  const ordinary = serialize({ amount: '1234', text: 'budget <plan>' });
  assert.deepEqual(JSON.parse(ordinary), { amount: '1234', text: 'budget <plan>' });
});

async function mocker() {
  const vitestRequire = createRequire(require.resolve('vitest/package.json'));
  return {
    ...(await import(pathToFileURL(vitestRequire.resolve('@vitest/mocker')).href)),
    ...(await import(pathToFileURL(vitestRequire.resolve('@vitest/mocker/node')).href)),
  };
}

test('manual mock URLs remain data in the generated module', async () => {
  const { MockerRegistry, interceptorPlugin } = await mocker();
  const registry = new MockerRegistry();
  const plugin = interceptorPlugin({
    registry,
    globalThisAccessor: '"__balanceframe_security_mocker__"',
  });
  const url = 'x"); globalThis.__balanceframe_injected__ = 1; void("';
  registry.register('manual', '', '/synthetic-module', url, async () => ({ value: 'ordinary' }));
  let received;
  globalThis.__balanceframe_security_mocker__ = {
    getFactoryModule(value) {
      received = value;
      return { value: 'ordinary' };
    },
  };
  try {
    const source = await plugin.load.handler('/synthetic-module');
    const module = await import(
      'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
    );
    assert.equal(module.value, 'ordinary');
    assert.equal(received, url);
    assert.equal(globalThis.__balanceframe_injected__, undefined);
  } finally {
    delete globalThis.__balanceframe_security_mocker__;
    delete globalThis.__balanceframe_injected__;
  }
});

test('redirect registration normalizes Windows separators before the real Vite allowlist check', async () => {
  const { MockerRegistry, interceptorPlugin } = await mocker();
  const { resolveConfig } = await import(pathToFileURL(require.resolve('vite')).href);
  const directory = mkdtempSync(join(tmpdir(), 'balanceframe-mocker-security-'));
  try {
    const project = join(directory, 'project');
    mkdirSync(project);
    writeFileSync(join(project, 'ordinary.js'), 'export const value = 1;');
    const config = await resolveConfig(
      {
        configFile: false,
        root: project,
        logLevel: 'silent',
        server: { fs: { strict: true, allow: [project] } },
      },
      'serve',
    );
    const registry = new MockerRegistry();
    const plugin = interceptorPlugin({ registry });
    const handlers = new Map();
    plugin.configureServer({
      config,
      ws: {
        on(name, handler) {
          handlers.set(name, handler);
        },
        send() {},
      },
    });
    const register = handlers.get('vitest:interceptor:register');
    for (const [id, redirect] of [
      ['/slash', 'probe:../outside.js'],
      ['/backslash', 'probe:..\\outside.js'],
    ]) {
      register({ type: 'redirect', raw: '', id, url: id, redirect });
      assert.equal(registry.getById(id), undefined, `${id} traversal must not register`);
    }
    register({
      type: 'redirect',
      raw: '',
      id: '/ordinary',
      url: '/ordinary',
      redirect: 'probe:ordinary.js',
    });
    assert.equal(await plugin.load.handler('/ordinary'), 'export const value = 1;');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('built Nuxt reports route and link security states through machine-readable CI output', () => {
  const environment = {
    ...process.env,
    NODE_ENV: 'production',
    CI: 'true',
    NITRO_PRESET: 'node-server',
    NUXT_TELEMETRY_DISABLED: '1',
  };
  delete environment.NODE_TEST_CONTEXT;
  const child = spawnSync(
    process.execPath,
    [join(import.meta.dirname, 'fixtures/nuxt-runtime.mjs'), root],
    {
      timeout: 90000,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      env: environment,
    },
  );
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stderr);
  const line = child.stdout.split('\n').find((value) => value.startsWith('SECURITY_PROBE_RESULT '));
  assert.ok(line, 'disposable production server returned its observed states');
  const observed = JSON.parse(line.slice('SECURITY_PROBE_RESULT '.length));
  assert.equal(observed.rootStatus, 200);
  assert.equal(observed.normalStatus, 307);
  assert.equal(observed.normalLocation, '/denied');
  assert.equal(observed.variantStatus, 307);
  assert.equal(observed.variantLocation, '/denied');
  assert.doesNotMatch(observed.link, /href="[\u0000-\u0020]*javascript:/i);
  assert.match(observed.ordinary, /href="\/ordinary"/);
});
