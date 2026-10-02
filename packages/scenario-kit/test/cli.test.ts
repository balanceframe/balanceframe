import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repository = fileURLToPath(new URL('../../../', import.meta.url));

describe('root scenario commands', () => {
  it('lists every checked feature without launching a workspace', () => {
    const result = spawnSync('pnpm', ['scenarios', 'list'], {
      cwd: repository,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('funded-purchase');
    expect(result.stdout).toContain('coapproval-completion');
    expect(result.stdout).toContain('ambiguous-completion');
    expect(result.stdout).not.toContain('secret');
  }, 65_000);

  it('rejects unlisted scenario IDs before opening the demo listener', () => {
    const result = spawnSync('pnpm', ['scenarios', 'run', '../../unexpected'], {
      cwd: repository,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('/demo');
    expect(result.stderr).toContain('Unknown scenario ID');
  }, 65_000);

  it('executes the selected live scenario instead of reporting a skipped suite as success', () => {
    const result = spawnSync('pnpm', ['scenarios', 'verify', 'funded-purchase'], {
      cwd: repository,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '1' },
      timeout: 180_000,
    });
    expect(result.status).toBe(0);
    const reportLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith('{"type":"scenario-verification",'));
    expect(reportLine).toBeDefined();
    const report = JSON.parse(reportLine!) as Record<string, unknown>;
    expect(report).toMatchObject({
      type: 'scenario-verification',
      catalogVersion: '1',
      scenarioId: 'funded-purchase',
      status: 'passed',
      evidence: { backend: 'disposable-actual', auth: 'better-auth' },
    });
    expect(report.anchor).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(report.assertions).toEqual(
      expect.objectContaining({
        name: expect.stringContaining('funded-purchase'),
        count: expect.any(Number),
      }),
    );
    expect((report.assertions as { count: number }).count).toBeGreaterThan(0);
  }, 185_000);
  it('reports all named native/service fault variants without launching Actual', () => {
    const result = spawnSync('pnpm', ['scenarios', 'verify', '--faults'], {
      cwd: repository,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '1' },
      timeout: 60_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('[Breadcrumb] Loading budget');
    const reports = result.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith('{"type":"fault-verification",'))
      .map(
        (line) =>
          JSON.parse(line) as {
            faultId: string;
            status: string;
            catalogVersion: string;
            anchor: string;
            assertions: { count: number };
            evidence: { backend: string };
          },
      );
    expect(reports.map((report) => report.faultId).sort()).toEqual([
      'ambiguous-transfer',
      'authoritative-schedule-claim-overlap',
      'completion-crash-retry',
      'source-coverage-receipt-integrity:duplicate',
      'source-coverage-receipt-integrity:missing',
    ]);
    for (const report of reports) {
      expect(report).toMatchObject({
        status: 'passed',
        catalogVersion: '1',
        anchor: '2026-09-06T12:00:00.000Z',
        evidence: { backend: 'native-service-fault' },
      });
      expect(report.assertions.count).toBeGreaterThan(0);
    }
  }, 65_000);
});
