/**
 * Container safety and configuration exclusion tests.
 *
 * Verifies that the Docker image runs as non-root,
 * development-only env vars are rejected at startup,
 * and the .dockerignore is present.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(__dirname, '../..');

describe('Docker image safety', () => {
  it('Dockerfile switches to non-root user before CMD', () => {
    const dockerfile = readFileSync(resolve(PROJECT_ROOT, 'Dockerfile'), 'utf-8');
    const lines = dockerfile.split('\n');

    const userLineIndex = lines.findIndex(l => l.trim().startsWith('USER '));
    const cmdLineIndex = lines.findIndex(l => l.trim().startsWith('CMD '));

    expect(userLineIndex).toBeGreaterThanOrEqual(0);
    expect(cmdLineIndex).toBeGreaterThan(userLineIndex);
  });

  it('runtime stage creates non-root user', () => {
    const dockerfile = readFileSync(resolve(PROJECT_ROOT, 'Dockerfile'), 'utf-8');
    expect(dockerfile).toContain('useradd');
    expect(dockerfile).toContain('balanceframe');
  });

  it('entrypoint rejects development-only environment variables', () => {
    const entrypoint = readFileSync(resolve(PROJECT_ROOT, 'docker-entrypoint.sh'), 'utf-8');
    const forbiddenVars = [
      'NUXT_DEV_BYPASS_AUTH',
      'BALANCEFRAME_DEV_BYPASS_AUTH',
      'NUXT_REVIEW_AND_APPLY',
      'BALANCEFRAME_SEED_ALLOWED',
    ];
    for (const v of forbiddenVars) {
      expect(entrypoint).toContain(v);
    }
    expect(entrypoint).toContain('exit 1');
  });
});

describe('.dockerignore configuration', () => {
  it('exists in project root', () => {
    expect(existsSync(resolve(PROJECT_ROOT, '.dockerignore'))).toBe(true);
  });

  it('excludes development-only directories', () => {
    const content = readFileSync(resolve(PROJECT_ROOT, '.dockerignore'), 'utf-8');
    const exclusions = ['.git/', 'node_modules/', 'tests/', 'docs/', '*.md'];
    for (const e of exclusions) {
      expect(content).toContain(e);
    }
  });

  it('excludes CI and tooling config', () => {
    const content = readFileSync(resolve(PROJECT_ROOT, '.dockerignore'), 'utf-8');
    expect(content).toContain('.github/');
    expect(content).toContain('.env');
    expect(content).toContain('flake.nix');
  });
});
