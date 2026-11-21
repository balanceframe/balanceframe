import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const root = process.env.BALANCEFRAME_OWNER_TEST_ROOT || resolve(import.meta.dirname, '../..');
const require = createRequire(join(root, 'node_modules/.pnpm/node_modules/security-probe.cjs'));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const semver = require('semver');

for (const contract of [
  {
    owner: 'js-beautify',
    ownerVersion: '2.0.3',
    range: '^13.0.6',
    child: 'glob',
    version: '14.0.6',
  },
  {
    owner: 'fontless',
    ownerVersion: '0.2.1',
    range: '^0.27.0',
    child: 'esbuild',
    version: '0.28.2',
  },
]) {
  test(`security compatibility update remains scoped to ${contract.owner}'s tested consumer`, () => {
    const entry = require.resolve(contract.owner);
    const ownerDirectory = dirname(dirname(entry));
    const owner = JSON.parse(readFileSync(join(ownerDirectory, 'package.json'), 'utf8'));
    const ownerRequire = createRequire(entry);
    const child = ownerRequire(`${contract.child}/package.json`);
    assert.equal(owner.name, contract.owner);
    assert.equal(
      owner.version,
      contract.ownerVersion,
      'owner changes require new compatibility evidence',
    );
    assert.equal(owner.dependencies[contract.child], contract.range);
    assert.equal(child.version, contract.version);
    assert.equal(
      semver.satisfies(child.version, contract.range),
      false,
      'this is an explicit tested compatibility choice, not an upstream semver claim',
    );
    const selector = `${contract.owner}@${contract.ownerVersion}>${contract.child}`;
    assert.equal(manifest.pnpm.overrides[selector], contract.version);
    assert.equal(
      manifest.pnpm.overrides[contract.child],
      undefined,
      'no global cross-range override',
    );
    assert.deepEqual(
      Object.keys(manifest.pnpm.overrides).filter((key) => key.endsWith(`>${contract.child}`)),
      [selector],
    );
    assert.equal(
      semver.subset(manifest.engines.node, child.engines.node),
      true,
      'the update must preserve every declared application Node version',
    );
    assert.equal(semver.satisfies(process.versions.node, child.engines.node), true);
  });
}
