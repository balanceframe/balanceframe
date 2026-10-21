import { expect, it } from 'vitest';
import fixture from '../../../protocol/fixtures/evidence-allocation-plan.json';
import planFixture from '../../../protocol/fixtures/evidence-allocation-plan-result.json';
import resolutionFixture from '../../../protocol/fixtures/evidence-allocation-resolution.json';
import { TransactionEvidenceResultSchema, sourceObservationSchema } from '../src/validators';
import {
  DeriveEvidenceAllocationPlanRequestSchema,
  EvidenceAllocationReviewSchema,
  EvidenceAllocationPlanSchema,
} from '../src/evidence-allocation';
it('preserves explicit allocation cells without accepting financial output or trusted-origin claims', () => {
  expect(DeriveEvidenceAllocationPlanRequestSchema.parse(fixture)).toEqual(fixture);
  for (const extra of [{ ledgerEffects: [] }, { authenticated: true }])
    expect(
      DeriveEvidenceAllocationPlanRequestSchema.safeParse({ ...fixture, ...extra }).success,
    ).toBe(false);
});
it('bounds matrix size and rejects noninteger monetary claims and unknown fields', () => {
  for (const change of [
    { cells: Array.from({ length: 10001 }, () => fixture.cells[0]) },
    { receiptIds: [] },
    { targetObservationIds: [' '] },
    { cells: [{ ...fixture.cells[0], amount: { minorUnits: '1.5', currency: 'USD' } }] },
  ])
    expect(
      DeriveEvidenceAllocationPlanRequestSchema.safeParse({ ...fixture, ...change }).success,
    ).toBe(false);
  expect(
    EvidenceAllocationReviewSchema.safeParse({
      contractVersion: '1',
      sourceHash: 'bad',
      allocationSetHash: 'bad',
      receiptIds: [],
      targetObservationIds: [],
      cells: [],
      lineCategories: [],
    }).success,
  ).toBe(false);
});

it('retains exact manifest-bearing native plans and financial source proofs without synthetic authority', () => {
  expect(EvidenceAllocationPlanSchema.parse(planFixture)).toEqual(planFixture);
  expect(TransactionEvidenceResultSchema.parse(resolutionFixture)).toEqual(resolutionFixture);
  for (const proof of resolutionFixture.events[0]!.projectionObservations!) {
    expect(sourceObservationSchema.parse(proof)).toEqual(proof);
    expect(sourceObservationSchema.safeParse({ ...proof, allocationReview: null }).success).toBe(
      false,
    );
  }
  expect(
    EvidenceAllocationPlanSchema.safeParse({ ...planFixture, authenticated: true }).success,
  ).toBe(false);
});
