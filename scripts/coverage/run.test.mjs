import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

async function waitForFile(path) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
    await delay(10);
  }
  throw new Error(`Timed out waiting for owned shim: ${path}`);
}
function running(pid) {
  try {
    return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return false;
  }
}
function fixture(t, mode = 'exit') {
  const root = mkdtempSync(join(tmpdir(), 'balanceframe-runner-contract-'));
  const put = (path, text, executable = false) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    if (executable) chmodSync(target, 0o755);
  };
  const nodeScript = (path, code) => put(path, `#!${process.execPath}\n${code}`, true);
  put('scripts/coverage/.keep', '');
  for (const name of ['run.sh', 'check.mjs'])
    copyFileSync(
      fileURLToPath(new URL(name, import.meta.url)),
      join(root, 'scripts/coverage', name),
    );
  put(
    'packages/example/package.json',
    JSON.stringify({
      name: '@balanceframe/example',
      scripts: { test: 'vitest run', coverage: 'vitest run --coverage' },
    }),
  );
  put('crates/node-binding/balanceframe.node', 'owned fake build input');
  put('.gitignore', 'coverage/\n.coverage-run.lock/\n');
  put('config.json', JSON.stringify({ openId: { client_secret: 'fake-cwd-secret' } }));
  put('caller/actual.json', JSON.stringify({ openId: { client_secret: 'fake-caller-secret' } }));
  const callerPaths = ['config.json', 'workflow.db', 'auth.db', 'nuxt-auth.db', 'nuxt-workflow.db'];
  for (const path of callerPaths) put(`caller/${path}`, 'untouched fake caller state');
  put('tests/actual-integration/.env.test', "ACTUAL_SECRET_KEY='prior-test-only-secret'\n");
  chmodSync(join(root, 'tests/actual-integration/.env.test'), 0o600);
  nodeScript(
    'shims/cargo',
    `
if (process.argv.includes('show-env')) {
  console.log('export CARGO_LLVM_COV_TARGET_DIR="' + process.env.CARGO_TARGET_DIR + '/instrumented"');
}
`,
  );
  for (const name of ['llvm-cov', 'llvm-profdata', 'actual-server', 'gdb'])
    put(`shims/${name}`, '#!/bin/sh\nexit 0\n', true);
  nodeScript(
    'shims/actual-server-child.mjs',
    `
import { writeFileSync, readFileSync } from 'node:fs';
const actual = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('ACTUAL_')));
const configPath = process.env.ACTUAL_CONFIG_PATH || process.cwd() + '/config.json';
writeFileSync(process.env.TEST_SERVER_READY, JSON.stringify({ pid: process.pid, actual, config: JSON.parse(readFileSync(configPath, 'utf8')) }));
setInterval(() => {}, 1000);
`,
  );
  nodeScript(
    'shims/grandchild.mjs',
    `
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
writeFileSync(process.env.TEST_GRANDCHILD_READY, JSON.stringify({ pid: process.pid }));
setInterval(() => {}, 1000);
`,
  );
  nodeScript(
    'shims/pnpm',
    `
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
if (process.argv.includes('napi')) {
  fs.mkdirSync('coverage/native', { recursive: true });
  fs.writeFileSync('coverage/native/balanceframe.node', 'owned fake build output');
} else if (process.argv.includes('@balanceframe/native')) {
  fs.writeFileSync(process.env.BALANCEFRAME_COVERAGE_LOADS, process.pid + '\\n');
} else if (process.argv.includes('vitest')) {
  const names = ['BALANCEFRAME_CONFIG_PATH', 'BALANCEFRAME_WORKFLOW_DB_PATH', 'BALANCEFRAME_AUTH_DB_PATH', 'NUXT_AUTH_DB_PATH', 'NUXT_WORKFLOW_DB_PATH'];
  const paths = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const target of Object.values(paths)) {
    if (target && target !== ':memory:') { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'owned suite write'); }
  }
  fs.writeFileSync(process.env.TEST_SUITE_READY, JSON.stringify({ pid: process.pid, paths }));
  if (process.env.TEST_MODE === 'hang' || process.env.TEST_MODE === 'fail-child') {
    spawn(process.execPath, [process.env.TEST_ROOT + '/shims/grandchild.mjs'], { stdio: 'ignore', env: process.env });
    setInterval(() => {
      if (process.env.TEST_MODE === 'fail-child' && fs.existsSync(process.env.TEST_GRANDCHILD_READY)) process.exit(27);
    }, 10);
  } else process.exit(27);
}
`,
  );
  put(
    'tests/actual-integration/setup-fixture-server.sh',
    `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$ACTUAL_SERVER_DATA_DIR"
ACTUAL_DATA_DIR="$ACTUAL_SERVER_DATA_DIR" node "$TEST_ROOT/shims/actual-server-child.mjs" &
echo "$!" > "$ACTUAL_SERVER_DATA_DIR/.actual-server.pid"
printf "ACTUAL_SECRET_KEY='owned-fixture-secret'\\nBALANCEFRAME_ACTUAL_FIXTURE='1'\\n" > "$TEST_ROOT/tests/actual-integration/.env.test"
chmod 600 "$TEST_ROOT/tests/actual-integration/.env.test"
`,
    true,
  );
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync(
    'git',
    ['-c', 'user.name=Coverage fixture', '-c', 'user.email=coverage@example.invalid', 'add', '.'],
    { cwd: root },
  );
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Coverage fixture',
      '-c',
      'user.email=coverage@example.invalid',
      'commit',
      '--signoff',
      '-qm',
      'owned runner fixture',
    ],
    { cwd: root },
  );
  const env = {
    ...process.env,
    PATH: `${root}/shims:${process.env.PATH}`,
    TEST_ROOT: root,
    TEST_MODE: mode,
    TEST_SERVER_READY: `${root}/server-ready.json`,
    TEST_SUITE_READY: `${root}/suite-ready.json`,
    TEST_GRANDCHILD_READY: `${root}/grandchild-ready.json`,
    ACTUAL_CONFIG_PATH: `${root}/caller/actual.json`,
    ACTUAL_OPENID_CLIENT_SECRET: 'fake-environment-secret',
    ACTUAL_HTTPS_KEY: `${root}/caller/private-key`,
    ACTUAL_SERVER_URL: 'https://production.invalid',
    BALANCEFRAME_CONFIG_PATH: `${root}/caller/config.json`,
    BALANCEFRAME_WORKFLOW_DB_PATH: `${root}/caller/workflow.db`,
    BALANCEFRAME_AUTH_DB_PATH: `${root}/caller/auth.db`,
    NUXT_AUTH_DB_PATH: `${root}/caller/nuxt-auth.db`,
    NUXT_WORKFLOW_DB_PATH: `${root}/caller/nuxt-workflow.db`,
    LLVM_COV: `${root}/shims/llvm-cov`,
    LLVM_PROFDATA: `${root}/shims/llvm-profdata`,
  };
  delete env.NODE_OPTIONS;
  const child = spawn('bash', ['scripts/coverage/run.sh'], {
    cwd: root,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    for (const name of ['server-ready.json', 'suite-ready.json', 'grandchild-ready.json']) {
      if (existsSync(join(root, name))) {
        const { pid } = JSON.parse(readFileSync(join(root, name), 'utf8'));
        if (running(pid)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {}
        }
      }
    }
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
      await exited;
    }
    if (existsSync(join(root, 'server-ready.json'))) {
      const server = JSON.parse(readFileSync(join(root, 'server-ready.json'), 'utf8'));
      rmSync(dirname(server.actual.ACTUAL_DATA_DIR), { recursive: true, force: true });
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, child, exited, output: () => output, callerPaths };
}

test('starts Actual with private explicit empty configuration and no inherited identity or TLS secrets', async (t) => {
  const f = fixture(t);
  const server = await waitForFile(join(f.root, 'server-ready.json'));
  const [code] = await f.exited;
  assert.equal(code, 27, f.output());
  assert.equal(server.actual.ACTUAL_OPENID_CLIENT_SECRET, undefined);
  assert.equal(server.actual.ACTUAL_HTTPS_KEY, undefined);
  assert.deepEqual(server.config, {});
  assert.equal(server.actual.ACTUAL_HOSTNAME, '127.0.0.1');
  assert.notEqual(server.actual.ACTUAL_CONFIG_PATH, join(f.root, 'caller/actual.json'));
  assert.equal(
    readFileSync(join(f.root, 'tests/actual-integration/.env.test'), 'utf8'),
    "ACTUAL_SECRET_KEY='prior-test-only-secret'\n",
  );
  assert.equal(existsSync(join(f.root, '.coverage-run.lock')), false);
});

test('isolates caller connection and database paths before a coverage consumer can write them', async (t) => {
  const f = fixture(t);
  await waitForFile(join(f.root, 'suite-ready.json'));
  const [code] = await f.exited;
  assert.equal(code, 27, f.output());
  for (const path of f.callerPaths)
    assert.equal(
      readFileSync(join(f.root, 'caller', path), 'utf8'),
      'untouched fake caller state',
      path,
    );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`direct ${signal} cancels an owned hanging suite and its descendant before restoring the fixture`, async (t) => {
    const f = fixture(t, 'hang');
    const server = await waitForFile(join(f.root, 'server-ready.json'));
    const suite = await waitForFile(join(f.root, 'suite-ready.json'));
    const grandchild = await waitForFile(join(f.root, 'grandchild-ready.json'));
    f.child.kill(signal);
    const result = await Promise.race([f.exited, delay(5000).then(() => null)]);
    assert.notEqual(result, null, `Runner did not bound cancellation: ${f.output()}`);
    assert.equal(result[0], signal === 'SIGINT' ? 130 : 143);
    assert.equal(running(suite.pid), false, 'suite survived cancellation');
    assert.equal(running(grandchild.pid), false, 'owned descendant survived cancellation');
    assert.equal(running(server.pid), false, 'owned fixture server survived cancellation');
    assert.equal(
      readFileSync(join(f.root, 'tests/actual-integration/.env.test'), 'utf8'),
      "ACTUAL_SECRET_KEY='prior-test-only-secret'\n",
    );
    assert.equal(existsSync(join(f.root, '.coverage-run.lock')), false);
  });
}

test('terminates a failed command’s surviving descendant before restoring fixture state', async (t) => {
  const f = fixture(t, 'fail-child');
  const server = await waitForFile(join(f.root, 'server-ready.json'));
  const grandchild = await waitForFile(join(f.root, 'grandchild-ready.json'));
  const [code] = await f.exited;
  assert.equal(code, 27, f.output());
  assert.equal(running(grandchild.pid), false, 'failed command left its owned descendant running');
  assert.equal(running(server.pid), false);
  assert.equal(
    readFileSync(join(f.root, 'tests/actual-integration/.env.test'), 'utf8'),
    "ACTUAL_SECRET_KEY='prior-test-only-secret'\n",
  );
  assert.equal(existsSync(join(f.root, '.coverage-run.lock')), false);
});
