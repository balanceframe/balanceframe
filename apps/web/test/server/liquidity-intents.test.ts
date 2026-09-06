import { describe, expect, it } from 'vitest';
import {
  liquidityPurchaseQuerySchema,
  liquidityObservationInputSchema,
  liquidityPolicyInputSchema,
  transferPreviewInputSchema,
  transferProposalInputSchema,
  transferActionInputSchema,
  spendSessionInputSchema,
} from '@balanceframe/application';

const amount = { minorUnits: '2000', currency: 'USD' };
const time = '2026-09-06T12:00:00.000Z';
const preview = {
  kind: 'purchase',
  categoryId: 'food',
  amount,
  purchaseAt: time,
  requiredBy: time,
};
describe('public liquidity trust boundary', () => {
  it('accepts account-optional purchase intent but rejects private evaluation context', () => {
    expect(
      liquidityPurchaseQuerySchema.parse({ categoryId: 'food', amount: '2000', currency: 'USD' })
        .accountId,
    ).toBeUndefined();
    for (const injection of [
      { actorId: 'owner' },
      { context: {} },
      { claims: [] },
      { policy: {} },
      { accountAware: {} },
    ])
      expect(
        liquidityPurchaseQuerySchema.safeParse({
          categoryId: 'food',
          amount: '2000',
          currency: 'USD',
          ...injection,
        }).success,
      ).toBe(false);
  });
  it('never accepts browser transfer plans, callbacks or settlement evidence', () => {
    expect(transferPreviewInputSchema.safeParse(preview).success).toBe(true);
    expect(transferPreviewInputSchema.safeParse({ ...preview, plan: {} }).success).toBe(false);
    expect(
      transferProposalInputSchema.safeParse({
        previewId: 'preview',
        payloadHash: 'a'.repeat(64),
        idempotencyKey: 'key',
        plan: {},
      }).success,
    ).toBe(false);
    for (const injection of [
      { actorId: 'owner' },
      { evidence: [] },
      { records: [] },
      { verifier: true },
      { claimSet: {} },
    ])
      expect(
        transferActionInputSchema.safeParse({
          payloadHash: 'a'.repeat(64),
          expectedVersion: 1,
          idempotencyKey: 'key',
          ...injection,
        }).success,
      ).toBe(false);
  });
  it('permits current-ledger attestation but never client provenance or binding hash', () => {
    const input = {
      expectedVersion: 0,
      expiresAt: time,
      observations: [{ accountId: 'cash', currentLedgerConfirmed: true }],
    };
    expect(liquidityObservationInputSchema.safeParse(input).success).toBe(true);
    for (const injection of [
      { observedAt: time },
      { ledgerConfirmationHash: 'forged' },
      { recordedBalance: amount },
      { source: 'institution_provider' },
      { evidence: { state: 'known' } },
    ])
      expect(
        liquidityObservationInputSchema.safeParse({
          ...input,
          observations: [{ ...input.observations[0], ...injection }],
        }).success,
      ).toBe(false);
  });
  it('does not let sessions reserve cash or inject trusted historical routes', () => {
    const input = {
      accountId: null,
      expiresAt: time,
      items: [
        {
          id: 'item',
          categoryId: 'food',
          amount,
          purchaseAt: time,
          requiredBy: time,
          accountId: null,
        },
      ],
    };
    expect(spendSessionInputSchema.safeParse(input).success).toBe(true);
    expect(spendSessionInputSchema.safeParse({ ...input, claim: {} }).success).toBe(false);
    expect(
      spendSessionInputSchema.safeParse({
        ...input,
        items: [
          { ...input.items[0], routeSelection: { historicalRoute: { accountId: 'private' } } },
        ],
      }).success,
    ).toBe(false);
  });
  it('rejects client-controlled policy hash and version identity', () => {
    expect(
      liquidityPolicyInputSchema.safeParse({
        expectedVersion: null,
        expiresAt: time,
        accounts: [],
        transferRoutes: [],
        approvalPolicy: { minimumApprovers: 1 },
        policyHash: 'forged',
      }).success,
    ).toBe(false);
  });
});
