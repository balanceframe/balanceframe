import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('loads the public validator barrel directly in Node for Actual fixture setup', () => {
  const validators = new URL('../src/validators.ts', import.meta.url).href;
  const fixture = new URL('../../../protocol/fixtures/representative.json', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    const validators = await import(${JSON.stringify(validators)});
    const source = JSON.parse(readFileSync(new URL(${JSON.stringify(fixture)}), 'utf8'));
    assert.equal(validators.canonicalProtocolSnapshotSchema.safeParse(source).success, true);
    for (const name of ['TransactionEvidenceRequestSchema', 'EvidenceAllocationReviewSchema', 'CompareSpendSessionReceiptRequestSchema']) {
      assert.equal(typeof validators[name].safeParse, 'function');
    }
    process.stdout.write('validator-boundary-ok');
  `;
  expect(
    execFileSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' }),
  ).toBe('validator-boundary-ok');
});
