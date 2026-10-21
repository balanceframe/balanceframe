import { expect, it } from 'vitest';
import fixture from '../../../protocol/fixtures/evidence-settlement-plan.json';
import resultFixture from '../../../protocol/fixtures/evidence-settlement-plan-result.json';
import {
  DeriveEvidenceSettlementPlanRequestSchema,
  EvidenceSettlementPlanSchema,
} from '../src/evidence-settlement';
it('accepts exact source capture and explicit choices without trusting client financial effects', () => {
  expect(DeriveEvidenceSettlementPlanRequestSchema.parse(fixture)).toEqual(fixture);
  for (const extra of [{ ledgerEffect: {} }, { authenticated: true }, { scope: 'forged' }])
    expect(
      DeriveEvidenceSettlementPlanRequestSchema.safeParse({ ...fixture, ...extra }).success,
    ).toBe(false);
});
it('bounds selection and category choice inputs and rejects blank identifiers', () => {
  for (const change of [
    { receiptIds: [] },
    { receiptIds: Array.from({ length: 101 }, () => 'receipt') },
    { lineCategories: Array.from({ length: 10001 }, () => fixture.lineCategories[0]) },
    { targetObservationId: ' ' },
    { lineCategories: [{ receiptId: 'receipt', lineId: 'line', categoryId: '\n' }] },
  ])
    expect(
      DeriveEvidenceSettlementPlanRequestSchema.safeParse({ ...fixture, ...change }).success,
    ).toBe(false);
});

it('preserves the exact native plan and provenance while rejecting forged output fields', () => {
  expect(EvidenceSettlementPlanSchema.parse(resultFixture)).toEqual(resultFixture);
  for (const invalid of [
    { ...resultFixture, allocationHash: 'invalid' },
    { ...resultFixture, authenticated: true },
    {
      ...resultFixture,
      ledgerEffect: {
        ...resultFixture.ledgerEffect,
        amount: { minorUnits: '-01', currency: 'USD' },
      },
    },
  ])
    expect(EvidenceSettlementPlanSchema.safeParse(invalid).success).toBe(false);
});
