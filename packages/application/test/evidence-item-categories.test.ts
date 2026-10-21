import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  applyReviewedItemCategories,
  prepareItemCategoryDecisions,
  itemCategoryReviewInputSchema,
} from '../src/evidence-item-categories.js';
import { actualLiquidityRequest } from '../../../tests/contract/fixtures/actual-liquidity.js';
import type {
  TransactionEvidenceRequest,
  TransactionEvidenceResult,
} from '@balanceframe/protocol-generated';
const native = createRequire(import.meta.url)('@balanceframe/native') as {
  resolveTransactionEvidence(input: string): string;
};
const now = '2026-10-21T12:00:00.000Z';
const actor = {
  actorId: 'owner',
  budgetId: 'budget',
  spaceId: 'space',
  membershipId: 'member',
  governancePolicyVersion: 'policy-1',
};
function setup() {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        '../../../protocol/fixtures/transaction-evidence-item-learning.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const request = fixture.evidence as TransactionEvidenceRequest;
  request.policyVersion = actor.governancePolicyVersion;
  const result = JSON.parse(
    native.resolveTransactionEvidence(JSON.stringify(request)),
  ) as TransactionEvidenceResult;
  const snapshot = actualLiquidityRequest(false).financialSnapshot;
  snapshot.legacySnapshot.accounts = [
    { ...snapshot.legacySnapshot.accounts[0]!, id: 'checking', isClosed: false },
  ];
  snapshot.legacySnapshot.categories = [
    { ...snapshot.legacySnapshot.categories[0]!, id: 'food', deleted: false },
  ];
  const input = {
    receiptId: 'receipt-1',
    lineId: 'line-1',
    accountId: 'checking',
    categoryId: 'food',
  };
  return { request, result, snapshot, input };
}
describe('explicit source-bound human item categories', () => {
  it('binds the exact immutable source and server-selected human provenance, including revocation', () => {
    const { request, result, snapshot, input } = setup();
    const outcome = prepareItemCategoryDecisions(
      [input],
      request,
      result,
      snapshot,
      actor,
      now,
      () => true,
    )[0]!;
    expect(outcome).toMatchObject({
      ...input,
      documentId: 'doc-wallet',
      contentHash: 'a'.repeat(64),
      actorId: 'owner',
      membershipId: 'member',
      policyVersion: 'policy-1',
      reviewedAt: now,
    });
    expect(applyReviewedItemCategories(request, [outcome], actor, () => true)).toEqual([outcome]);
    expect(request.receipts[0]!.lines[0]!.categoryId).toBe('food');
    expect(
      applyReviewedItemCategories(request, [{ ...outcome, categoryId: null }], actor, () => true),
    ).toHaveLength(1);
    expect(request.receipts[0]!.lines[0]!.categoryId).toBeNull();
    expect(itemCategoryReviewInputSchema.safeParse({ ...input, actorId: 'forged' }).success).toBe(
      false,
    );
  });
  it('requires native conservation, exact line identity, available targets and current authority', () => {
    const { request, result, snapshot, input } = setup();
    for (const value of [
      [input, input],
      [{ ...input, receiptId: 'missing' }],
      [{ ...input, lineId: 'missing' }],
    ])
      expect(() =>
        prepareItemCategoryDecisions(value, request, result, snapshot, actor, now, () => true),
      ).toThrow();
    expect(() =>
      prepareItemCategoryDecisions(
        [input],
        request,
        { ...result, receipts: [] },
        snapshot,
        actor,
        now,
        () => true,
      ),
    ).toThrow(/Conserved/);
    expect(() =>
      prepareItemCategoryDecisions([input], request, result, null, actor, now, () => true),
    ).toThrow(/authority/);
    expect(() =>
      prepareItemCategoryDecisions([input], request, result, snapshot, actor, now, () => false),
    ).toThrow(/authority/);
    snapshot.legacySnapshot.categories[0]!.deleted = true;
    expect(() =>
      prepareItemCategoryDecisions([input], request, result, snapshot, actor, now, () => true),
    ).toThrow(/authority/);
  });
  it('abstains after source/hash/parser/policy/membership/category or account grants change', () => {
    const { request, result, snapshot, input } = setup();
    const outcome = prepareItemCategoryDecisions(
      [input],
      request,
      result,
      snapshot,
      actor,
      now,
      () => true,
    )[0]!;
    for (const change of [
      { documentId: 'different' },
      { contentHash: 'b'.repeat(64) },
      { parserVersion: 'new' },
      { policyVersion: 'new' },
      { membershipId: 'new' },
      { actorId: 'other' },
      { lineId: 'missing' },
    ])
      expect(
        applyReviewedItemCategories(
          structuredClone(request),
          [{ ...outcome, ...change }],
          actor,
          () => true,
        ),
      ).toEqual([]);
    expect(applyReviewedItemCategories(request, [outcome], actor, () => false)).toEqual([]);
  });
});
