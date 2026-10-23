import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = fs.readFileSync(
  path.resolve(projectRoot, '.github/workflows/release.yml'),
  'utf-8',
);

function jobSection(name: string): string {
  const lines = workflow.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) return '';

  const nextSection = lines.findIndex(
    (line, index) =>
      index > start && (/^ {2}[A-Za-z0-9_-]+:\s*$/u.test(line) || /^[^\s#]/u.test(line)),
  );

  return lines.slice(start, nextSection === -1 ? undefined : nextSection).join('\n');
}

const verifyJob = jobSection('verify');
const publishJob = jobSection('publish');
const releasePolicy = fs.readFileSync(path.resolve(projectRoot, 'docs/releases.md'), 'utf-8');
const acceptanceStatus = fs.readFileSync(
  path.resolve(projectRoot, 'docs/roadmap/post-mvp/11-5-implementation-status.md'),
  'utf-8',
);

const publishingMarkers = [
  'uses: docker/setup-buildx-action@',
  'uses: docker/login-action@',
  'uses: docker/metadata-action@',
  'uses: docker/build-push-action@',
  'push: true',
  'just release-assets',
  'cosign sign',
  'uses: anchore/sbom-action@',
  'uses: softprops/action-gh-release@',
] as const;

const verificationCommands = [
  'nix flake check --print-build-logs',
  'just release-verify',
  'pnpm build',
  'pnpm typecheck',
  'pnpm lint',
  'pnpm test',
  'cargo test --workspace',
  'cargo clippy --workspace --all-targets -- -D warnings',
] as const;

describe('release workflow job boundaries', () => {
  it('defines a 45-minute verification gate and a dependent 60-minute publish job', () => {
    expect(verifyJob, 'jobs.verify must exist').not.toBe('');
    expect(publishJob, 'jobs.publish must exist separately from jobs.verify').not.toBe('');
    expect(verifyJob).toMatch(/^ {4}timeout-minutes: 45$/mu);
    expect(publishJob).toMatch(/^ {4}needs: verify$/mu);
    expect(publishJob).toMatch(/^ {4}timeout-minutes: 60$/mu);
  });

  it('keeps Docker publishing, signing, SBOM, and release work only in publish', () => {
    for (const marker of publishingMarkers) {
      expect(publishJob, `${marker} must be in jobs.publish`).toContain(marker);
      expect(verifyJob, `${marker} must not be in jobs.verify`).not.toContain(marker);
    }
  });

  it('keeps verification commands only in verify', () => {
    for (const command of verificationCommands) {
      expect(verifyJob, `${command} must be in jobs.verify`).toContain(command);
      expect(publishJob, `${command} must not be in jobs.publish`).not.toContain(command);
    }
  });
});

describe('acceptance-testing beta policy', () => {
  it('keeps prerelease classification and stable image aliases isolated', () => {
    expect(workflow).toContain("- 'v*.*.*'");
    expect(publishJob).toContain('docker/metadata-action@902fa8ec7d6ecbf8d84d538b9b233a880e428804');
    expect(publishJob.match(/^ +type=.+$/gmu)?.map((line) => line.trim())).toEqual([
      'type=semver,pattern={{version}}',
      'type=semver,pattern={{major}}.{{minor}}',
      'type=semver,pattern={{major}}',
      "type=raw,value=latest,enable=${{ !contains(github.ref_name, '-') }}",
    ]);
    expect(publishJob).not.toMatch(/^ +(?:flavor:|prefix=|latest=true)/mu);
    expect(publishJob).toContain('draft: false');
    expect(publishJob).toContain("prerelease: ${{ contains(github.ref_name, '-') }}");
  });

  it('allows isolated beta acceptance without completing stable acceptance or roadmap exit', () => {
    expect(releasePolicy).toContain('All automated release gates apply unchanged to beta tags.');
    expect(releasePolicy).toContain(
      'An acceptance-testing beta does not complete the stable release or roadmap exit.',
    );
    expect(releasePolicy).toContain('ghcr.io/balanceframe/balanceframe:0.9.0-beta.1');
    expect(acceptanceStatus).toContain(
      'The stable release and authoritative roadmap exit must not be marked complete',
    );
    expect(acceptanceStatus).toContain('../../releases.md#acceptance-testing-betas');
  });
});
