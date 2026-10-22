// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { ConsequentialActionProposal } from '@balanceframe/application';
import {
  consequentialActionIntentSchema,
  EvidenceAllocationReviewSchema,
} from '@balanceframe/protocol-generated/validators';
import fixture from '../../../../protocol/fixtures/consequential-evidence-actions.json';
import allocationFixture from '../../../../protocol/fixtures/evidence-allocation-plan-result.json';
import walletFixture from '../../../../protocol/fixtures/wallet-statement-result.json';
import {
  projectConsequentialActionProposal,
  type ActionProposalApproval,
} from '../../server/utils/proposal-route';

type Action = ConsequentialActionProposal['payload']['plan']['action'];
const credit = consequentialActionIntentSchema.parse(fixture.creditIntent);
const amendment = consequentialActionIntentSchema.parse(fixture.amendmentIntent);
if (credit.kind !== 'evidence_credit' || amendment.kind !== 'evidence_amendment')
  throw new Error('Canonical evidence fixtures must contain credit and amendment intents');

const approval: ActionProposalApproval = {
  requesterMembershipCurrent: true,
  requiredApprovers: 1,
  approvers: [],
  canApprove: true,
  canExecute: false,
  disposition: 'approval_required',
};
const PRIVATE = 'private-native-source-marker';

function proposal(action: Action): ConsequentialActionProposal {
  return {
    id: 'evidence-proposal',
    operation: 'consequential_action',
    budgetId: 'budget',
    spaceId: 'space',
    policyVersion: 'generic-mutation-v1',
    requesterActorId: 'requester',
    governancePolicyVersion: 'governance-v1',
    currentGovernancePolicyVersion: 'governance-v1',
    payloadHash: 'a'.repeat(64),
    financialPolicyVersion: 'financial-v1',
    currentFinancialPolicyVersion: 'financial-v1',
    requiredApprovers: 1,
    decisionContext: null,
    payload: {
      kind: 'consequential_action',
      plan: {
        version: '1',
        action,
        source: {
          snapshotReference: '00000000-0000-4000-8000-000000000001',
          policyVersion: 'policy-v1',
          financialPolicyVersion: 'financial-v1',
          claimSetRevision: 'claims-v1',
        },
        evidenceReferences: [],
        expiresAt: '2026-09-06T17:00:00.000Z',
        reasonCodes: ['evidence_resolution'],
        impacts: [],
        expectedPostconditions: [],
      },
    },
    expiresAt: '2026-09-06T17:00:00.000Z',
    supersededAt: null,
    createdAt: '2026-09-06T10:00:00.000Z',
    version: 1,
    state: { phase: 'proposed', outcome: null },
  };
}

function project(action: Action) {
  return projectConsequentialActionProposal(proposal(action), approval, 'create_approval_proposal');
}

describe('governed evidence demo proposal projection', () => {
  it('preserves the exact nonzero wallet opening equity without native extras', () => {
    const anchor = walletFixture.wallets[0]!.balanceAnchors[0]!;
    const action: Extract<Action, { kind: 'wallet_materialization' }> = {
      kind: 'wallet_materialization',
      walletId: anchor.walletId,
      accountName: 'Reviewed wallet',
      currency: anchor.amount.currency,
      opening: {
        amount: anchor.amount,
        date: anchor.asOfDate,
        proofSetHash: anchor.proofSetHash,
        activityManifestHash: anchor.activityManifestHash,
      },
    };
    const withExtras = {
      ...action,
      nativeHash: PRIVATE,
      opening: {
        ...action.opening!,
        nativeHash: PRIVATE,
        amount: { ...anchor.amount, nativeHash: PRIVATE },
      },
    };
    const result = project(withExtras);
    expect(result.payload.plan.action).toEqual(action);
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
  });

  it('keeps opening absent for an existing zero-opening wallet action', () => {
    const action: Action = {
      kind: 'wallet_materialization',
      walletId: 'wallet',
      accountName: 'Reviewed wallet',
      currency: 'USD',
    };
    expect(project(action).payload.plan.action).toEqual(action);
    expect(project(action).payload.plan.action).not.toHaveProperty('opening');
  });

  it.each([credit, amendment])('publishes the source-bound $kind intent', (action) => {
    const result = project(action);
    expect(result.payload.plan.action).toEqual(action);
    expect(result).toMatchObject({
      requesterMembershipCurrent: true,
      requiredApprovers: 1,
      canApprove: true,
      canExecute: false,
    });
  });

  it('publishes every credit and amendment in a plural composite in order', () => {
    const action: Action = {
      kind: 'composite',
      actions: [
        amendment,
        credit,
        { kind: 'manual_transaction', transaction: credit.transaction },
        { ...credit, kind: 'evidence_projection' },
      ],
    };
    expect(project(action).payload.plan.action).toEqual(action);
  });

  it.each([
    credit,
    amendment,
    { ...credit, kind: 'evidence_projection' as const },
  ])('preserves the reviewed economic event for $kind', (action) => {
    const bound = { ...action, resolutionSubjectId: 'reviewed-economic-event', nativeHash: PRIVATE };
    const result = project(bound);
    expect(result.payload.plan.action).toEqual({
      ...action,
      resolutionSubjectId: 'reviewed-economic-event',
    });
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
  });

  it('preserves only the permitted exact allocation review fields', () => {
    const review = EvidenceAllocationReviewSchema.parse(allocationFixture.review);
    const withExtras = {
      ...review,
      rawDocument: PRIVATE,
      cells: review.cells.map((cell) => ({
        ...cell,
        nativeHash: PRIVATE,
        amount: { ...cell.amount, nativeHash: PRIVATE },
      })),
      lineCategories: review.lineCategories.map((line) => ({ ...line, nativeHash: PRIVATE })),
    };
    const input = proposal({ kind: 'composite', actions: [amendment, credit] });
    const result = projectConsequentialActionProposal({
      ...input,
      payload: {
        ...input.payload,
        plan: { ...input.payload.plan, allocationReviews: [withExtras] },
      },
    }, approval, 'create_approval_proposal');

    expect(result.payload.plan).toHaveProperty('allocationReviews', [review]);
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
  });

  it('does not reintroduce an allocation review or event ID absent from the scoped view', () => {
    const result = project(credit);
    expect(result.payload.plan).not.toHaveProperty('allocationReviews');
    expect(result.payload.plan.action).not.toHaveProperty('resolutionSubjectId');
  });

  it('keeps the bounded financial decision context alongside an evidence proposal', () => {
    const input = proposal(credit);
    const amount = credit.transaction.amount;
    const decisionContext: NonNullable<ConsequentialActionProposal['decisionContext']> = {
      horizon: { startsAt: input.createdAt, endsAt: input.expiresAt },
      validUntil: input.expiresAt,
      items: [{
        id: 'reviewed-item',
        categoryId: 'food',
        accountId: credit.transaction.accountId,
        amount,
        purchaseAt: input.createdAt,
        requiredBy: input.expiresAt,
        priority: 'required',
        quantity: 1,
        categoryAllocations: [{ categoryId: 'food', amount }],
      }],
      adjustments: [{ kind: 'tax', categoryId: 'food', amount }],
      warningThresholds: [
        { id: 'cart', basis: 'cart_total', maximum: amount },
        { id: 'food', basis: 'category_charge', categoryId: 'food', maximum: amount },
      ],
    };
    const result = projectConsequentialActionProposal({
      ...input,
      decisionContext: {
        ...decisionContext,
        items: decisionContext.items.map((item) => ({
          ...item,
          nativeHash: PRIVATE,
          amount: { ...amount, nativeHash: PRIVATE },
          categoryAllocations: [{ categoryId: 'food', amount, nativeHash: PRIVATE }],
        })),
        adjustments: decisionContext.adjustments!.map((adjustment) => ({ ...adjustment, nativeHash: PRIVATE })),
        warningThresholds: decisionContext.warningThresholds!.map((threshold) => ({ ...threshold, nativeHash: PRIVATE })),
      },
    }, approval, 'create_approval_proposal');
    expect(result.decisionContext).toEqual(decisionContext);
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
  });

  it('allowlists amendment source fields recursively without publishing native extras', () => {
    const child = {
      ...amendment.expectedSource,
      id: 'original-child',
      categoryId: 'food',
      categoryName: 'Food',
      tags: ['reviewed'],
      subtransactions: [],
    };
    const expectedSource = { ...amendment.expectedSource, subtransactions: [child] };
    const split = { categoryId: 'food', amount: amendment.transaction.amount };
    const expected = { ...amendment.expected, splits: [split] };
    const transaction = { ...amendment.transaction, splits: [split] };
    const withExtras = {
      ...amendment,
      nativeHash: PRIVATE,
      transaction: {
        ...transaction,
        nativeHash: PRIVATE,
        amount: { ...transaction.amount, nativeHash: PRIVATE },
        splits: [{ ...split, nativeHash: PRIVATE, amount: { ...split.amount, nativeHash: PRIVATE } }],
      },
      expected: {
        ...expected,
        nativeHash: PRIVATE,
        amount: { ...expected.amount, nativeHash: PRIVATE },
        splits: [{ ...split, nativeHash: PRIVATE, amount: { ...split.amount, nativeHash: PRIVATE } }],
      },
      expectedSource: {
        ...expectedSource,
        nativeHash: PRIVATE,
        amount: { ...expectedSource.amount, nativeHash: PRIVATE },
        subtransactions: [{ ...child, nativeHash: PRIVATE, amount: { ...child.amount, nativeHash: PRIVATE } }],
      },
    };

    const result = project(withExtras);
    expect(result.payload.plan.action).toEqual({ ...amendment, transaction, expected, expectedSource });
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
  });
});
