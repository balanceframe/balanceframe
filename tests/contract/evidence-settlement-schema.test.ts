import { registerProtocolSchemas } from './src/schema-registry.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import Ajv from 'ajv';
import { expect, it } from 'vitest';
import {
  DeriveEvidenceSettlementPlanRequestSchema,
  EvidenceSettlementPlanSchema,
} from '@balanceframe/protocol-generated/validators';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const fixture = read('protocol/fixtures/evidence-settlement-plan.json');
const ajv = new Ajv({ strict: false });
registerProtocolSchemas(ajv);
const schema = (name: string) =>
  ajv.compile({
    $ref: `https://balanceframe.dev/schemas/evidence-settlement-v1.json#/$defs/${name}`,
  });
it('accepts explicit choices and rejects financial effects or forged authority at every declarative boundary', () => {
  expect(schema('DeriveEvidenceSettlementPlanRequest')(fixture)).toBe(true);
  expect(DeriveEvidenceSettlementPlanRequestSchema.parse(fixture)).toEqual(fixture);
  for (const invalid of [
    { ...fixture, ledgerEffect: {} },
    { ...fixture, authenticated: true },
    { ...fixture, receiptIds: [] },
    { ...fixture, lineCategories: [{ receiptId: 'receipt', lineId: 'line', categoryId: '\n' }] },
  ]) {
    expect(schema('DeriveEvidenceSettlementPlanRequest')(invalid)).toBe(false);
    expect(DeriveEvidenceSettlementPlanRequestSchema.safeParse(invalid).success).toBe(false);
  }
});
it('validates the native derived effect and shared canonical proof without accepting stale or duplicate allocations', () => {
  const native = createRequire(import.meta.url)('../../crates/node-binding/balanceframe.node') as {
    deriveEvidenceSettlementPlan(input: string): string;
  };
  const result = JSON.parse(native.deriveEvidenceSettlementPlan(JSON.stringify(fixture)));
  expect(schema('EvidenceSettlementPlan')(result)).toBe(true);
  expect(EvidenceSettlementPlanSchema.parse(result)).toEqual(result);
  expect(result).toEqual(read('protocol/fixtures/evidence-settlement-plan-result.json'));
  for (const change of ['missing', 'duplicate', 'overallocated']) {
    const input = structuredClone(fixture);
    if (change === 'missing') input.lineCategories = [];
    if (change === 'duplicate') input.receiptIds.push(input.receiptIds[0]);
    if (change === 'overallocated')
      input.evidence.relationships[0].allocatedAmount.minorUnits = '401';
    expect(() => native.deriveEvidenceSettlementPlan(JSON.stringify(input))).toThrow();
  }
});
