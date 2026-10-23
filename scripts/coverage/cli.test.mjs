import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = fileURLToPath(new URL('../../apps/cli/bin/cli.js', import.meta.url));
const { version } = JSON.parse(
  readFileSync(new URL('../../apps/cli/package.json', import.meta.url), 'utf8'),
);

function invoke(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      BALANCEFRAME_SERVER_URL: '',
      BALANCEFRAME_API_KEY: '',
      BALANCEFRAME_SESSION_COOKIE: '',
      BALANCEFRAME_SPACE_ID: '',
    },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

test('executable prints the package version without credentials', () => {
  assert.equal(invoke(['--version']), `${version}\n`);
});

test('executable explains consequential action approval boundaries', () => {
  const output = invoke(['proposals', 'action', '--help']);
  assert.match(output, /proposals action --action-file ACTION.json --json/);
  assert.match(output, /proposals approve PROPOSAL_ID --payload-hash DISPLAYED_HASH --json/);
  assert.match(output, /Actual credentials are never accepted from this file/);
});

test('executable explains research consent and human policy for every help route', () => {
  for (const args of [
    ['--help'],
    ['merchant', '--help'],
    ['merchant', 'research', '--help'],
    ['merchant', 'space-policy', '--help'],
  ]) {
    const output = invoke(args);
    assert.match(output, /merchant research preview/);
    assert.match(output, /--preview-token TOKEN --consent true --idempotency-key ID/);
    assert.match(output, /Space-policy replacement requires a fresh human session/);
  }
});

test('executable dispatches invalid commands and flags to error envelopes', () => {
  for (const [args, code] of [
    [[], 'no_command'],
    [['unknown-command'], 'unknown_command'],
    [['--version', '--json'], 'unknown_flags'],
  ]) {
    const output = JSON.parse(invoke(args));
    assert.equal(output.status, 'error');
    assert.equal(output.error.code, code);
  }
});
