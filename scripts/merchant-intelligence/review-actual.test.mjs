import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('publishes 50k imported source rows and settles first and repeated authenticated Review Sync',
  { timeout: 1800000 }, async (t) => {
    const artifacts = mkdtempSync(path.join(tmpdir(), 'balanceframe-review-publication-test-'));
    const output = path.join(artifacts, 'publication.json');
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/merchant-intelligence/review.mjs'),
      '--sizes', '50000', '--warmups', '1', '--iterations', '1', '--deadline-ms', '120000',
      '--dataset-deadline-ms', '1200000', '--output', output],
    { cwd: ROOT, stdio: 'ignore' });
    const abort = () => child.kill('SIGTERM');
    t.signal.addEventListener('abort', abort, { once: true });
    try {
      const result = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      assert.equal(result.signal, null);
      // A short run deliberately cannot establish the two-warmup/twenty-sample reference p95.
      assert.equal(result.code, 2);
      const dataset = JSON.parse(readFileSync(output, 'utf8')).datasets[0];
      assert.equal(dataset.cleanupStatus, 'completed');
      assert.equal(dataset.source.count, 50000, `publication failed: ${dataset.failureCode}`);
      assert.equal(dataset.source.originalCount, 50000);
      assert.equal(dataset.source.retainedCount, 50000);
      assert.equal(dataset.source.truncatedCount, 0);
      assert.equal(dataset.source.exactReadback, true);
      assert.equal(dataset.source.independentPublishedCapture, true);
      assert.equal(dataset.money.accountBalanceAfterMinorUnits,
        dataset.money.accountBalanceBeforeMinorUnits + Number(dataset.money.generatedMinorUnits));
      assert.equal(dataset.firstPopulation.status, 'completed', `first Sync failed: ${dataset.failureCode}`);
      assert.equal(dataset.firstPopulation.sourceCount, 50000);
      assert.equal(dataset.completedWarmups, 1);
      assert.equal(dataset.completedSamples, 1);
      assert.equal(dataset.queue.stable, true);
      assert.equal(dataset.p95ElapsedMs, null);
      assert.equal(statSync(output).mode & 0o777, 0o600);
    } finally {
      t.signal.removeEventListener('abort', abort);
      rmSync(artifacts, { recursive: true, force: true });
    }
  });
