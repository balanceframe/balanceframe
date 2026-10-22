/** Static contracts for the production container's artifacts and safety guards. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');
const dockerfile = readFileSync(resolve(PROJECT_ROOT, 'Dockerfile'), 'utf8');
const runtimeStage = dockerfile.split(/^FROM /m).at(-1);

describe('Docker image safety', () => {
  it('runtime stage switches to non-root user before CMD', () => {
    const lines = runtimeStage.split('\n');
    const userLineIndex = lines.findLastIndex(line => line.trim().startsWith('USER '));
    const cmdLineIndex = lines.findIndex(line => line.trim().startsWith('CMD '));

    assert.equal(lines[userLineIndex]?.trim(), 'USER balanceframe');
    assert.ok(cmdLineIndex > userLineIndex);
  });

  it('runtime stage creates non-root user', () => {
    assert.match(runtimeStage, /^RUN groupadd -r balanceframe && useradd -r -g balanceframe /m);
  });

  it('runs the self-contained Nitro output copied from the builder', () => {
    assert.match(runtimeStage, /^WORKDIR \/app\s*$/m);
    assert.match(runtimeStage, /^COPY --from=builder \/app\/apps\/web\/\.output \.\/web-output\s*$/m);
    assert.match(runtimeStage, /^CMD \["node", "web-output\/server\/index\.mjs"\]\s*$/m);
  });

  it('copies the native addon and wrapper into the runtime package directory', () => {
    assert.match(runtimeStage, /^RUN mkdir -p \/app\/node_modules\/@balanceframe\/native\s*$/m);
    for (const artifact of ['balanceframe.node', 'index.js', 'index.d.ts']) {
      assert.ok(runtimeStage.split('\n').includes(
        `COPY --from=builder /app/crates/node-binding/${artifact} ./node_modules/@balanceframe/native/${artifact}`,
      ), `${artifact} is copied into the runtime native package`);
    }
  });

  it('entrypoint rejects development-only environment variables', () => {
    const entrypoint = readFileSync(resolve(PROJECT_ROOT, 'docker-entrypoint.sh'), 'utf8');
    const forbiddenVars = [
      'NUXT_DEV_BYPASS_AUTH',
      'BALANCEFRAME_DEV_BYPASS_AUTH',
      'NUXT_REVIEW_AND_APPLY',
      'BALANCEFRAME_SEED_ALLOWED',
    ];
    for (const variable of forbiddenVars) {
      assert.ok(entrypoint.includes(variable));
    }
    assert.ok(entrypoint.includes('exit 1'));
  });
});

describe('.dockerignore configuration', () => {
  it('exists in project root', () => {
    assert.ok(existsSync(resolve(PROJECT_ROOT, '.dockerignore')));
  });

  it('excludes development-only directories', () => {
    const content = readFileSync(resolve(PROJECT_ROOT, '.dockerignore'), 'utf8');
    const exclusions = ['.git/', 'node_modules/', 'tests/', 'docs/', '*.md'];
    for (const exclusion of exclusions) {
      assert.ok(content.includes(exclusion));
    }
  });

  it('excludes CI and tooling config', () => {
    const content = readFileSync(resolve(PROJECT_ROOT, '.dockerignore'), 'utf8');
    assert.ok(content.includes('.github/'));
    assert.ok(content.includes('.env'));
    assert.ok(content.includes('flake.nix'));
  });
});
