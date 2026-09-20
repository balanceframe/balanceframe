import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const checker = fileURLToPath(new URL('./check.mjs', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'balanceframe-coverage-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
  git('init', '-q');
  git('config', 'user.name', 'Coverage fixture');
  git('config', 'user.email', 'coverage@example.invalid');
  put('.gitignore', '/coverage/\n');
  const source = (path) => put(path, 'export const value = 1;\n');
  const pkg = (path) =>
    put(
      `${path}/package.json`,
      JSON.stringify({ name: `@balanceframe/${path.split('/').at(-1)}` }),
    );
  const report = (name, files) =>
    put(
      `coverage/js/${name}/lcov.info`,
      files
        .map(
          ([path, hit, total]) =>
            `TN:\nSF:${resolve(root, path)}\n${Array.from({ length: total }, (_, i) => `DA:${i + 1},${i < hit ? 1 : 0}`).join('\n')}\nLF:${total}\nLH:${hit}\nend_of_record\n`,
        )
        .join(''),
    );
  const rustReport = (files) =>
    put(
      'coverage/rust/coverage.json',
      JSON.stringify({
        type: 'llvm.coverage.json.export',
        version: '3.0.1',
        cargo_llvm_cov: { version: '0.8.5', manifest_path: resolve(root, 'Cargo.toml') },
        data: [
          {
            files: files.map(([path, covered, count]) => ({
              filename: resolve(root, path),
              summary: { lines: { count, covered, percent: count ? (100 * covered) / count : 0 } },
            })),
          },
        ],
      }),
    );
  const commit = () => {
    git('add', '.');
    git('commit', '--signoff', '-qm', 'fixture');
  };
  const check = (...args) =>
    spawnSync(process.execPath, [checker, '--root', root, ...args], { encoding: 'utf8' });
  return {
    root,
    put,
    git,
    pkg,
    source,
    report,
    rustReport,
    commit,
    check,
    summary: () => JSON.parse(readFileSync(join(root, 'coverage/summary.json'), 'utf8')),
  };
}

test('weights workspace lines and aggregates changed files instead of imposing per-file gates', (t) => {
  const f = fixture(t);
  f.pkg('packages/example');
  f.source('packages/example/src/large.ts');
  f.source('packages/example/src/small.ts');
  f.commit();
  f.source('packages/example/src/large.ts');
  f.put('packages/example/src/small.ts', 'export const value = 2;\n');
  f.put('packages/example/src/large.ts', 'export const value = 2;\n');
  f.report('example', [
    ['packages/example/src/large.ts', 90, 100],
    ['packages/example/src/small.ts', 0, 10],
  ]);
  const result = f.check();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.summary().packages['packages/example'].changed.total, 110);
  assert.equal(f.summary().workspace.line, (100 * 90) / 110);
});

test('fails a changed-file aggregate even when the whole package passes', (t) => {
  const f = fixture(t);
  f.pkg('packages/example');
  f.source('packages/example/src/old.ts');
  f.commit();
  f.source('packages/example/src/new.ts');
  f.report('example', [
    ['packages/example/src/old.ts', 100, 100],
    ['packages/example/src/new.ts', 0, 10],
  ]);
  assert.equal(f.check().status, 1);
  assert.equal(f.summary().packages['packages/example'].changed.line, 0);
});

test('enforces package-specific financial and protocol thresholds', (t) => {
  const f = fixture(t);
  f.pkg('packages/protocol-generated');
  f.source('packages/protocol-generated/src/index.ts');
  f.commit();
  f.report('protocol-generated', [['packages/protocol-generated/src/index.ts', 89, 100]]);
  assert.equal(f.check().status, 1);
  f.report('protocol-generated', [['packages/protocol-generated/src/index.ts', 90, 100]]);
  assert.equal(f.check().status, 0);
});

test('fails closed for missing reports, missing source records and malformed LCOV counts', (t) => {
  const f = fixture(t);
  f.pkg('packages/example');
  f.source('packages/example/src/index.ts');
  f.commit();
  assert.equal(f.check().status, 1);
  f.report('example', [['packages/example/src/other.ts', 1, 1]]);
  assert.equal(f.check().status, 1);
  f.put(
    'coverage/js/example/lcov.info',
    `SF:${f.root}/packages/example/src/index.ts\nDA:1,1\nLF:2\nLH:1\nend_of_record\n`,
  );
  assert.equal(f.check().status, 1);
  f.report('example', [['packages/example/src/index.ts', 1, 1]]);
  assert.equal(f.check().status, 0);
});

test('uses an available merge base, includes working and untracked files, and rejects nonexistent bases', (t) => {
  const f = fixture(t);
  f.pkg('packages/example');
  f.source('packages/example/src/base.ts');
  f.commit();
  const base = f.git('rev-parse', 'HEAD');
  f.source('packages/example/src/committed.ts');
  f.commit();
  f.source('packages/example/src/untracked.ts');
  f.report('example', [
    ['packages/example/src/base.ts', 10, 10],
    ['packages/example/src/committed.ts', 10, 10],
    ['packages/example/src/untracked.ts', 10, 10],
  ]);
  assert.equal(f.check('--base', base).status, 0);
  assert.equal(f.summary().packages['packages/example'].changed.total, 20);
  assert.equal(f.check('--base', 'missing-ref').status, 1);
});

test('discovers new code packages and never counts fixtures or declarations as production', (t) => {
  const f = fixture(t);
  f.put(
    'apps/new-app/package.json',
    JSON.stringify({
      name: '@balanceframe/new-app',
      scripts: { test: 'vitest run', coverage: 'vitest run --coverage' },
    }),
  );
  f.source('apps/new-app/src/index.ts');
  f.source('apps/new-app/src/fixtures/sample.ts');
  f.source('apps/new-app/src/index.test.ts');
  f.put('apps/new-app/src/types.d.ts', 'export interface Type {}');
  f.commit();
  assert.equal(f.check().status, 1);
  f.report('new-app', [['apps/new-app/src/index.ts', 1, 1]]);
  assert.equal(f.check().status, 0);
  assert.equal(f.summary().workspace.total, 1);
});

test('enforces Rust package thresholds using LLVM line summaries and excludes test-only modules', (t) => {
  const f = fixture(t);
  f.put(
    'crates/financial-core/Cargo.toml',
    '[package]\nname = "financial-core"\nversion = "0.1.0"\n',
  );
  f.put('crates/financial-core/src/lib.rs', 'pub fn value() -> u8 { 1 }\n');
  f.put('crates/financial-core/src/fuzz.rs', '#[test] fn test_only() {}\n');
  f.commit();
  f.rustReport([
    ['crates/financial-core/src/lib.rs', 94, 100],
    ['crates/financial-core/src/fuzz.rs', 0, 100],
  ]);
  assert.equal(f.check().status, 1);
  assert.equal(f.summary().workspace.total, 100);
  f.rustReport([['crates/financial-core/src/lib.rs', 95, 100]]);
  assert.equal(f.check().status, 0);
});

test('requires successful nonempty unskipped execution for source-free contract suites', (t) => {
  const f = fixture(t);
  f.pkg('packages/example');
  f.source('packages/example/src/index.ts');
  f.put(
    'tests/contract/package.json',
    JSON.stringify({
      name: '@balanceframe/test-contract',
      scripts: { coverage: 'vitest run --coverage' },
    }),
  );
  f.put('tests/contract/helpers.ts', 'export const helper = 1;\n');
  f.commit();
  f.report('example', [['packages/example/src/index.ts', 1, 1]]);
  f.report('test-contract', []);
  assert.equal(f.check('--require-execution').status, 1);
  const evidence = {
    success: true,
    numTotalTests: 2,
    numPassedTests: 1,
    numPendingTests: 1,
    numFailedTests: 0,
  };
  f.put('coverage/js/test-contract/tests.json', JSON.stringify(evidence));
  assert.equal(f.check('--require-execution').status, 1);
  f.put(
    'coverage/js/test-contract/tests.json',
    JSON.stringify({ ...evidence, numPassedTests: 2, numPendingTests: 0 }),
  );
  assert.equal(f.check('--require-execution').status, 0);
  assert.equal(f.summary().packages['tests/contract'].line, null);
  assert.equal(f.summary().packages['tests/contract'].sourceFiles, 0);
  const listed = f.check('--list');
  assert.equal(listed.status, 0);
  assert.deepEqual(listed.stdout.trim().split('\t'), [
    '@balanceframe/test-contract',
    'js/test-contract',
  ]);
});

test('resolves package-relative Vitest paths and counts runtime entrypoints outside src', (t) => {
  const f = fixture(t);
  f.pkg('apps/cli');
  f.source('apps/cli/bin/cli.js');
  f.pkg('apps/web');
  f.source('apps/web/server/api/example.ts');
  f.source('apps/web/app/pages/example.vue');
  f.commit();
  f.put('coverage/js/cli/lcov.info', 'SF:bin/cli.js\nDA:1,1\nLF:1\nLH:1\nend_of_record\n');
  f.put(
    'coverage/js/cli/entrypoint-lcov.info',
    'SF:bin/cli.js\nDA:1,1\nLF:1\nLH:1\nend_of_record\n',
  );
  f.report('web', [
    ['apps/web/server/api/example.ts', 1, 1],
    ['apps/web/app/pages/example.vue', 1, 1],
  ]);
  assert.equal(f.check().status, 0);
  assert.equal(f.summary().workspace.total, 3);
});

test('rejects truncated, duplicate and invalid numeric LCOV records rather than trusting totals', (t) => {
  const f = fixture(t);
  f.pkg('packages/example');
  f.source('packages/example/src/index.ts');
  f.commit();
  const source = `SF:${f.root}/packages/example/src/index.ts\n`;
  const record = `${source}DA:1,1\nLF:1\nLH:1\nend_of_record\n`;
  f.put('coverage/js/example/lcov.info', `${source}DA:1,1\nLF:1\nLH:1\n`);
  assert.equal(f.check().status, 1, 'unfinished record');
  f.put('coverage/js/example/lcov.info', record + record);
  assert.equal(f.check().status, 1, 'duplicate source cannot inflate coverage');
  f.put('coverage/js/example/lcov.info', `${source}DA:1,-1\nLF:1\nLH:0\nend_of_record\n`);
  assert.equal(f.check().status, 1, 'negative execution count');
  f.put('coverage/js/example/lcov.info', 'not an LCOV report\n');
  assert.equal(f.check().status, 1, 'invalid report syntax');
});

test('does not silently omit source in a newly introduced test workspace package', (t) => {
  const f = fixture(t);
  f.pkg('packages/example');
  f.source('packages/example/src/index.ts');
  f.pkg('tests/new-proof');
  f.source('tests/new-proof/src/index.ts');
  f.commit();
  f.report('example', [['packages/example/src/index.ts', 1, 1]]);
  assert.equal(f.check().status, 1);
  f.report('new-proof', [['tests/new-proof/src/index.ts', 1, 1]]);
  assert.equal(f.check().status, 0);
  assert.equal(f.summary().workspace.total, 2);
});

test('requires native Node loading evidence in addition to a passing Rust report', (t) => {
  const f = fixture(t);
  f.put('crates/node-binding/Cargo.toml', '[package]\nname = "node-binding"\nversion = "0.1.0"\n');
  f.put('crates/node-binding/src/lib.rs', 'pub fn value() -> u8 { 1 }\n');
  f.commit();
  f.rustReport([['crates/node-binding/src/lib.rs', 9, 10]]);
  assert.equal(f.check('--require-execution').status, 1);
  f.put('coverage/native/loads.log', '12345\n');
  assert.equal(f.check('--require-execution').status, 0);
});

test('uses actual CLI child-process coverage instead of the unimported Vitest placeholder', (t) => {
  const f = fixture(t);
  f.pkg('apps/cli');
  f.source('apps/cli/src/index.ts');
  f.source('apps/cli/bin/cli.js');
  f.commit();
  f.report('cli', [
    ['apps/cli/src/index.ts', 100, 100],
    ['apps/cli/bin/cli.js', 0, 10],
  ]);
  f.report('entrypoint', [['apps/cli/bin/cli.js', 10, 10]]);
  f.put(
    'coverage/js/cli/entrypoint-lcov.info',
    readFileSync(join(f.root, 'coverage/js/entrypoint/lcov.info'), 'utf8'),
  );
  assert.equal(f.check().status, 0);
  assert.equal(f.summary().packages['apps/cli'].covered, 110);
  rmSync(join(f.root, 'coverage/js/cli/entrypoint-lcov.info'));
  assert.equal(f.check().status, 1, 'missing required child source report');
});

test('does not let removal of coverage configuration opt a source-free required suite out', (t) => {
  const f = fixture(t);
  f.pkg('packages/example');
  f.source('packages/example/src/index.ts');
  f.put(
    'tests/contract/package.json',
    JSON.stringify({ name: '@balanceframe/test-contract', scripts: { test: 'vitest run' } }),
  );
  f.put(
    'tests/contract/contract.test.ts',
    'import { test } from "vitest"; test("contract", () => {});\n',
  );
  f.commit();
  f.report('example', [['packages/example/src/index.ts', 1, 1]]);
  assert.equal(f.check('--require-execution').status, 1);
  assert.equal(f.check('--list').status, 1);
});

test('requires configuration for newly added source-free tests even without convenience scripts', (t) => {
  const f = fixture(t);
  f.pkg('packages/example');
  f.source('packages/example/src/index.ts');
  f.pkg('tests/new-proof');
  f.put('tests/new-proof/test/contract.test.ts', 'export {};\n');
  f.commit();
  f.report('example', [['packages/example/src/index.ts', 1, 1]]);
  assert.equal(f.check('--require-execution').status, 1);
  assert.equal(f.check('--list').status, 1);
});

test('counts declared root and custom runtime entrypoints while excluding generated dist and declaration targets', (t) => {
  const f = fixture(t);
  f.pkg('packages/example');
  f.source('packages/example/src/index.ts');
  f.put(
    'packages/custom/package.json',
    JSON.stringify({
      name: '@balanceframe/custom',
      main: './index.js',
      module: './esm/start.js',
      bin: { custom: './commands/start.js' },
      exports: {
        '.': { types: './types.d.ts', import: './esm/start.js', require: './index.js' },
        './helpers/*': './helpers/*.js',
        './built': './dist/generated.js',
      },
    }),
  );
  for (const path of [
    'index.js',
    'esm/start.js',
    'commands/start.js',
    'helpers/nested/value.js',
    'dist/generated.js',
  ])
    f.source(`packages/custom/${path}`);
  f.put('packages/custom/types.d.ts', 'export interface Type {};\n');
  f.commit();
  f.report('example', [['packages/example/src/index.ts', 1, 1]]);
  assert.equal(f.check().status, 1, 'custom entrypoints cannot be labeled source-free');
  f.report('custom', [
    ['packages/custom/index.js', 1, 1],
    ['packages/custom/esm/start.js', 1, 1],
    ['packages/custom/commands/start.js', 1, 1],
    ['packages/custom/helpers/nested/value.js', 1, 1],
  ]);
  assert.equal(f.check().status, 0);
  assert.equal(f.summary().workspace.total, 5);
  f.source('packages/custom/helpers/new.js');
  assert.equal(f.check().status, 1, 'new untracked exported source must have coverage');
});

test('counts Nuxt runtime configuration as production source', (t) => {
  const f = fixture(t);
  f.pkg('apps/web');
  f.source('apps/web/src/index.ts');
  f.source('apps/web/nuxt.config.ts');
  f.commit();
  f.report('web', [['apps/web/src/index.ts', 1, 1]]);
  assert.equal(f.check().status, 1);
  f.report('web', [
    ['apps/web/src/index.ts', 1, 1],
    ['apps/web/nuxt.config.ts', 1, 1],
  ]);
  assert.equal(f.check().status, 0);
  assert.equal(f.summary().workspace.total, 2);
});

test('uses authoritative LLVM JSON summaries when instantiation totals differ from LCOV DA cardinality', (t) => {
  const f = fixture(t);
  f.put(
    'crates/core-protocol/Cargo.toml',
    '[package]\nname = "core-protocol"\nversion = "0.1.0"\n',
  );
  f.put('crates/core-protocol/src/lib.rs', 'pub fn value() -> u8 { 1 }\n');
  f.commit();
  f.put(
    'coverage/rust/lcov.info',
    `SF:${f.root}/crates/core-protocol/src/lib.rs\nDA:1,1\nLF:112\nLH:112\nend_of_record\n`,
  );
  f.rustReport([['crates/core-protocol/src/lib.rs', 112, 112]]);
  assert.equal(f.check().status, 0);
  assert.equal(f.summary().packages['crates/core-protocol'].total, 112);
  f.rustReport([['crates/core-protocol/src/lib.rs', 94, 100]]);
  assert.equal(f.check().status, 1);
});

test('rejects invalid LLVM producer, schema, counts, filenames and missing source records', (t) => {
  const f = fixture(t);
  f.put(
    'crates/core-protocol/Cargo.toml',
    '[package]\nname = "core-protocol"\nversion = "0.1.0"\n',
  );
  f.put('crates/core-protocol/src/lib.rs', 'pub fn value() -> u8 { 1 }\n');
  f.commit();
  f.report('temporary', [['crates/core-protocol/src/lib.rs', 1, 1]]);
  f.put(
    'coverage/rust/lcov.info',
    readFileSync(join(f.root, 'coverage/js/temporary/lcov.info'), 'utf8'),
  );
  const mutations = [
    (report) => {
      report.type = 'untrusted-export';
    },
    (report) => {
      report.version = 'unknown';
    },
    (report) => {
      report.cargo_llvm_cov.manifest_path = '/different/workspace/Cargo.toml';
    },
    (report) => {
      report.data[0].files[0].summary.lines.covered = 2;
    },
    (report) => {
      report.data[0].files[0].summary.lines.count = 1.5;
    },
    (report) => {
      report.data[0].files[0].filename = 'relative.rs';
    },
    (report) => {
      report.data[0].files.push(report.data[0].files[0]);
    },
    (report) => {
      report.data[0].files = [];
    },
  ];
  for (const mutate of mutations) {
    f.rustReport([['crates/core-protocol/src/lib.rs', 1, 1]]);
    const report = JSON.parse(readFileSync(join(f.root, 'coverage/rust/coverage.json'), 'utf8'));
    mutate(report);
    f.put('coverage/rust/coverage.json', JSON.stringify(report));
    assert.equal(f.check().status, 1, mutate.toString());
  }
  rmSync(join(f.root, 'coverage/rust/coverage.json'));
  assert.equal(f.check().status, 1, 'missing primary Rust JSON must fail');
});

test('reports absent strictly type-only TypeScript records as N/A rather than artificial full coverage', (t) => {
  const f = fixture(t);
  f.pkg('packages/example');
  f.source('packages/example/src/index.ts');
  f.pkg('packages/type-library');
  f.put(
    'packages/type-library/src/types.ts',
    "import type { Other } from 'type-dependency';\nexport interface Shape { value: Other }\nexport type Alias = Shape | null;\nexport type * from './more';\n",
  );
  f.commit();
  f.report('example', [['packages/example/src/index.ts', 1, 1]]);
  f.report('type-library', []);
  assert.equal(f.check().status, 0);
  assert.equal(f.summary().packages['packages/type-library'].line, null);
  assert.equal(f.summary().workspace.total, 1);
});

test('does not exempt missing runtime syntax or malformed TypeScript, nor discard existing provider counts', (t) => {
  const f = fixture(t);
  f.pkg('packages/example');
  f.source('packages/example/src/index.ts');
  f.commit();
  f.report('example', []);
  for (const source of [
    'export enum State { Ready }',
    'export const value = 1;',
    'export function value() { return 1; }',
    'doWork();',
    "import './side-effects';",
    "export * from './runtime';",
    "export { type Shape } from './runtime';",
    'export interface Broken {',
  ]) {
    f.put('packages/example/src/index.ts', source);
    assert.equal(f.check().status, 1, source);
  }
  f.put('packages/example/src/index.ts', 'export interface Shape { value: string }\n');
  f.report('example', [['packages/example/src/index.ts', 0, 1]]);
  assert.equal(f.check().status, 1, 'existing uncovered provider record remains authoritative');
});

test('allows absent conservative Rust declarations but never absent runtime constructs or macros', (t) => {
  const f = fixture(t);
  f.put(
    'crates/core-protocol/Cargo.toml',
    '[package]\nname = "core-protocol"\nversion = "0.1.0"\n',
  );
  f.put('crates/core-protocol/src/lib.rs', 'pub fn value() -> u8 { 1 }\n');
  f.put(
    'crates/core-protocol/src/model.rs',
    '//! Snapshot metadata.\n#![forbid(unsafe_code)]\nuse serde::Serialize;\n#[derive(Serialize)]\npub struct Model { pub value: u64 }\npub enum State { Ready }\n',
  );
  f.commit();
  f.rustReport([['crates/core-protocol/src/lib.rs', 1, 1]]);
  assert.equal(f.check().status, 0);
  assert.equal(f.summary().workspace.total, 1);
  for (const source of [
    'pub fn omitted() {}',
    'impl Model {}',
    'pub const VALUE: u64 = 1;',
    'static VALUE: u64 = 1;',
    'generate_runtime!();',
    '// fn inside ambiguous documentation must fail conservatively\npub struct Model;',
  ]) {
    f.put('crates/core-protocol/src/model.rs', source);
    assert.equal(f.check().status, 1, source);
  }
});

test('keeps untracked coverage infrastructure in the changed aggregate while ignoring generated reports', (t) => {
  const f = fixture(t);
  f.put('.gitignore', readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8'));
  f.pkg('packages/example');
  f.source('packages/example/src/index.ts');
  f.commit();
  f.source('scripts/coverage/check.mjs');
  f.report('example', [['packages/example/src/index.ts', 1, 1]]);
  f.report('coverage-gates', [['scripts/coverage/check.mjs', 1, 1]]);
  assert.equal(f.check().status, 0);
  assert.equal(f.summary().packages['scripts/coverage'].changed.total, 1);
  f.git('check-ignore', '--quiet', 'coverage/js/example/lcov.info');
});
