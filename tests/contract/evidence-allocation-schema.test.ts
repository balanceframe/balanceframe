import { registerProtocolSchemas } from './src/schema-registry.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import Ajv from 'ajv';
import { expect, it } from 'vitest';
import {
  DeriveEvidenceAllocationPlanRequestSchema,
  EvidenceAllocationPlanSchema,
  TransactionEvidenceResultSchema,
} from '@balanceframe/protocol-generated/validators';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const fixture = read('protocol/fixtures/evidence-allocation-plan.json');
const ajv = new Ajv({ strict: false });
registerProtocolSchemas(ajv);
const schema = (name: string) =>
  ajv.compile({
    $ref: `https://balanceframe.dev/schemas/evidence-allocation-v1.json#/$defs/${name}`,
  });
it('matches explicit allocation matrix contracts and rejects forged effects or scope', () => {
  expect(schema('DeriveEvidenceAllocationPlanRequest')(fixture)).toBe(true);
  expect(DeriveEvidenceAllocationPlanRequestSchema.parse(fixture)).toEqual(fixture);
  for (const invalid of [
    { ...fixture, scope: 'forged' },
    {
      ...fixture,
      cells: [{ ...fixture.cells[0], amount: { minorUnits: '1.5', currency: 'USD' } }],
    },
  ]) {
    expect(schema('DeriveEvidenceAllocationPlanRequest')(invalid)).toBe(false);
    expect(DeriveEvidenceAllocationPlanRequestSchema.safeParse(invalid).success).toBe(false);
  }
});
it('round trips native allocation plan and manifest-bearing plural proofs', () => {
  const native = createRequire(import.meta.url)('../../crates/node-binding/balanceframe.node') as {
    deriveEvidenceAllocationPlan(input: string): string;
    resolveTransactionEvidence(input: string): string;
  };
  const plan = JSON.parse(native.deriveEvidenceAllocationPlan(JSON.stringify(fixture)));
  expect(schema('EvidenceAllocationPlan')(plan)).toBe(true);
  expect(EvidenceAllocationPlanSchema.parse(plan)).toEqual(plan);
  expect(plan).toEqual(read('protocol/fixtures/evidence-allocation-plan-result.json'));
  const request = structuredClone(fixture.evidence);
  request.allocationReview = plan.review;
  for (const p of plan.projections) {
    const o = request.observations.find((o: { id: string }) => o.id === p.targetObservationId);
    o.ledgerEffect = p.ledgerEffect;
    o.reviewedLedgerEffect = true;
  }
  const output = JSON.parse(native.resolveTransactionEvidence(JSON.stringify(request)));
  expect(TransactionEvidenceResultSchema.parse(output)).toEqual(output);
  expect(output).toEqual(read('protocol/fixtures/evidence-allocation-resolution.json'));
  expect(
    ajv.compile({
      $ref: 'https://balanceframe.dev/schemas/transaction-evidence-v1.json#/$defs/TransactionEvidenceResult',
    })(output),
  ).toBe(true);
});
