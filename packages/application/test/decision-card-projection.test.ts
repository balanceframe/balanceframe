import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type {
  DecisionCard,
  DecisionCardRequest,
  FinancialSnapshot,
} from '@balanceframe/protocol-generated';
import { decisionCardRequestSchema, decisionCardSchema } from '@balanceframe/protocol-generated/validators';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import { actualLiquidityRequest } from '../../../tests/contract/fixtures/actual-liquidity.js';
import { LiquidityProjector } from '../src/liquidity-projector.js';

type NativeCardBinding = {
  evaluateDecisionCard(input: string): string;
};

type CanonicalCardFixture = {
  snapshotId: string;
  contentHash: string;
  evaluatedAt: string;
  horizon: DecisionCardRequest['context']['horizon'];
  facts: NonNullable<FinancialSnapshot['liquidity']>;
  liquidityPolicy: DecisionCardRequest['liquidityPolicy'];
  claimSet: DecisionCardRequest['claimSet'];
  scenario: {
    kind: 'purchases';
    items: Array<Omit<DecisionCardRequest['items'][number], 'priority'>>;
  };
  validUntil: string;
};

type GrantResource = {
  resourceKind: 'budget' | 'account' | 'category';
  resourceId: string;
};

const native = createRequire(import.meta.url)('@balanceframe/native') as NativeCardBinding;
const cardFixture = JSON.parse(
  readFileSync(new URL('../../../protocol/fixtures/account-aware-liquidity.json', import.meta.url), 'utf8'),
) as CanonicalCardFixture;
const money = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const unauthorizedEvidenceId = 'private-savings-unauthorized-884';
const redactedEvidenceId = 'private-savings-redacted-885';
const cardCapabilities = [
  'conclusion',
  'existence',
  'name',
  'balance',
  'history',
  'liquidity',
  'source',
  'category',
  'proposal',
  'approval',
  'initiation-report',
  'confirmation',
  'audit',
  'policy',
  'session',
] as const;

/**
 * Fixture assumptions: canonical liquidity facts provide known USD evidence for
 * food, checking, and savings. Checking has a 10,000 protected buffer and the
 * 2,000 food purchase therefore evaluates as funded but requires the exact
 * 3,000 savings -> checking transfer arriving at 11:00 UTC before payment.
 *
 * The Actual fixture supplies a real FinancialSnapshot/source budget and legacy
 * account/category records; its provider-derived account evidence is replaced by
 * the canonical, fully evidenced facts so this test can exercise exact native
 * before/after arithmetic rather than an intentional insufficient-data result.
 */
function composeRequest(): DecisionCardRequest {
  const source = actualLiquidityRequest(true);
  if (source.scenario.kind !== 'purchases') throw new Error('Purchase fixture required');

  const snapshot = structuredClone(source.financialSnapshot);
  snapshot.snapshotId = cardFixture.snapshotId;
  snapshot.contentHash = cardFixture.contentHash;
  snapshot.capturedAt = cardFixture.evaluatedAt;
  snapshot.liquidity = structuredClone(cardFixture.facts);
  snapshot.coverage.accounts = 'complete';
  snapshot.coverage.categories = 'complete';
  snapshot.coverage.transactions = 'complete';
  snapshot.coverage.schedules = 'complete';
  snapshot.coverage.budgets = 'complete';

  const accountTemplate = snapshot.legacySnapshot.accounts[0];
  const categoryTemplate = snapshot.legacySnapshot.categories.find((category) => category.id === 'food');
  if (!accountTemplate || !categoryTemplate) throw new Error('Actual fixture identity records are required');
  snapshot.legacySnapshot.accounts = [
    { ...accountTemplate, id: 'checking', name: 'Checking account' },
    { ...accountTemplate, id: 'savings', name: 'Savings account' },
  ];
  snapshot.legacySnapshot.categories = [{ ...categoryTemplate, id: 'food', name: 'Food' }];
  snapshot.observations = [
    {
      kind: 'account_freshness',
      scope: { kind: 'account', id: 'checking' },
      state: 'fresh',
      observedAt: cardFixture.evaluatedAt,
      evidence: [
        {
          evidenceId: 'checking-freshness',
          kind: 'bank_sync',
          authorized: true,
          redaction: 'visible',
        },
      ],
    },
    {
      kind: 'account_freshness',
      scope: { kind: 'account', id: 'savings' },
      state: 'fresh',
      observedAt: cardFixture.evaluatedAt,
      evidence: [
        {
          evidenceId: unauthorizedEvidenceId,
          kind: 'bank_sync',
          authorized: false,
          redaction: 'visible',
        },
        {
          evidenceId: redactedEvidenceId,
          kind: 'bank_sync',
          authorized: true,
          redaction: 'redacted',
        },
      ],
    },
  ];

  const context = structuredClone(source.context);
  context.evaluatedAt = cardFixture.evaluatedAt;
  context.horizon = structuredClone(cardFixture.horizon);
  context.snapshotId = cardFixture.snapshotId;
  context.contentHash = cardFixture.contentHash;
  context.policyVersion = cardFixture.liquidityPolicy.version;
  context.policyHash = cardFixture.liquidityPolicy.policyHash;
  context.policy.maxBankSyncAgeMinutes = null;

  const item = {
    ...structuredClone(cardFixture.scenario.items[0]),
    priority: 'planned' as const,
  };
  return decisionCardRequestSchema.parse({
    financialSnapshot: snapshot,
    context,
    liquidityPolicy: structuredClone(cardFixture.liquidityPolicy),
    claimSet: structuredClone(cardFixture.claimSet),
    priorAllocation: null,
    items: [item],
    categoryPolicies: [
      {
        categoryId: item.categoryId,
        kind: 'ordinary',
        donorEligible: false,
        minimumRetained: money('0'),
        projectedRemainingNeed: money('0'),
      },
    ],
    validUntil: cardFixture.validUntil,
    requestId: 'request-card-actual-projection',
    correlationId: 'correlation-card-actual-projection',
    decisionId: 'decision-card-actual-projection',
  });
}

function evaluate(request: DecisionCardRequest): DecisionCard {
  return decisionCardSchema.parse(
    JSON.parse(native.evaluateDecisionCard(JSON.stringify(request))) as unknown,
  );
}

async function grantResources(
  store: SqliteWorkflowStore,
  actor: { actorId: string; budgetId: string },
  resources: GrantResource[],
  now: string,
): Promise<void> {
  await store.upsertActorMembership(
    actor.actorId,
    'active',
    ['observe', ...cardCapabilities.map((capability) => `liquidity:${capability}`)],
    `budget:${actor.budgetId}`,
  );
  for (const resource of resources)
    for (const capability of cardCapabilities)
      store.liquidity.setResourceGrant({
        ...actor,
        ...resource,
        capability,
        granted: true,
        now,
      });
}

function expectRestrictedProjection(publicCard: unknown, rawCard: DecisionCard): void {
  expect(publicCard).toMatchObject({
    outcome: 'insufficient_data',
    budgetFundingStatus: 'insufficient_data',
    paymentLiquidityStatus: 'insufficient_data',
    before: null,
    after: null,
    fundingPaths: [],
    evidence: [],
    selectedAccountId: null,
    blockers: ['restricted_financial_scope'],
  });
  expect(publicCard).not.toHaveProperty('reasons');
  expect(publicCard).not.toHaveProperty('assumptions');
  for (const key of [
    'decisionId',
    'requestId',
    'correlationId',
    'snapshotId',
    'contentHash',
    'policyHash',
    'claimSetRevision',
    'planHash',
  ])
    expect(publicCard).not.toHaveProperty(key);
  const serialized = JSON.stringify(publicCard);
  for (const hidden of [
    rawCard.decisionId,
    rawCard.requestId,
    rawCard.correlationId,
    rawCard.snapshotId,
    rawCard.contentHash,
    rawCard.policyHash,
    rawCard.claimSetRevision,
    rawCard.planHash,
    'savings',
    unauthorizedEvidenceId,
    redactedEvidenceId,
    'private_savings_activity_unknown',
  ])
    expect(serialized).not.toContain(hidden);
}

describe('Decision Card public projection', () => {
  it('projects exact category money and transfer readiness, then retracts them after current revocation', async () => {
    const request = composeRequest();
    const card = evaluate(request);
    expect(card.outcome).toBe('safe_after_date');
    expect(card.budgetFundingStatus).toBe('funded');
    expect(card.paymentLiquidityStatus).toBe('transfer_required');

    const store = new SqliteWorkflowStore(':memory:');
    const actor = { actorId: 'card-reader', budgetId: request.financialSnapshot.source.budgetId };
    const now = request.context.evaluatedAt;
    try {
      await grantResources(
        store,
        actor,
        [
          { resourceKind: 'budget', resourceId: actor.budgetId },
          { resourceKind: 'category', resourceId: 'food' },
          { resourceKind: 'account', resourceId: 'checking' },
          { resourceKind: 'account', resourceId: 'savings' },
        ],
        now,
      );
      const projector = new LiquidityProjector(store, actor, request.financialSnapshot);
      const projected = projector.card(card);
      expect(projected).toMatchObject({
        outcome: 'safe_after_date',
        budgetFundingStatus: 'funded',
        paymentLiquidityStatus: 'transfer_required',
        selectedAccountId: 'checking',
      });
      expect(projected).not.toHaveProperty('snapshotId');
      expect(projected).not.toHaveProperty('contentHash');
      expect(projected).not.toHaveProperty('policyHash');
      expect(projected).not.toHaveProperty('planHash');
      expect(projected.before?.categories.find((category) => category.categoryId === 'food')).toEqual(
        expect.objectContaining({
          categoryId: 'food',
          asOfMonth: '2026-09',
          availability: money('2000'),
        }),
      );
      expect(projected.after?.categories.find((category) => category.categoryId === 'food')).toEqual(
        expect.objectContaining({
          categoryId: 'food',
          asOfMonth: '2026-09',
          availability: money('0'),
        }),
      );
      expect(projected.fundingPaths).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'account_transfer',
            legs: expect.arrayContaining([
              expect.objectContaining({
                sourceAccountId: 'savings',
                destinationAccountId: 'checking',
                amount: money('3000'),
              }),
            ]),
          }),
        ]),
      );
      expect(projected.evidence).toEqual([
        {
          evidenceId: 'checking-freshness',
          kind: 'bank_sync',
          authorized: true,
          redaction: 'visible',
        },
      ]);
      const projectedSerialized = JSON.stringify(projected);
      expect(projectedSerialized).not.toContain(unauthorizedEvidenceId);
      expect(projectedSerialized).not.toContain(redactedEvidenceId);

      store.liquidity.setResourceGrant({
        ...actor,
        resourceKind: 'account',
        resourceId: 'savings',
        capability: 'liquidity',
        granted: false,
        now,
      });
      expectRestrictedProjection(projector.card(card), card);
    } finally {
      store.close();
    }
  });

  it('fails closed when a restricted actor lacks the hidden transfer source, including for a blocked native card', async () => {
    const request = composeRequest();
    const blockedRequest = structuredClone(request);
    const savings = blockedRequest.financialSnapshot.liquidity?.accounts.find(
      (account) => account.accountId === 'savings',
    );
    if (!savings) throw new Error('Canonical fixture savings account is required');
    savings.activityEvidence = {
      ...savings.activityEvidence,
      state: 'unknown',
      reasons: ['private_savings_activity_unknown'],
    };
    const blockedCard = evaluate(blockedRequest);
    expect(blockedCard.outcome).toBe('insufficient_data');
    expect(blockedCard.after).toBeNull();
    expect(blockedCard.evidence.map(({ evidenceId }) => evidenceId)).not.toContain(
      unauthorizedEvidenceId,
    );
    expect(blockedCard.evidence.map(({ evidenceId }) => evidenceId)).not.toContain(
      redactedEvidenceId,
    );

    const store = new SqliteWorkflowStore(':memory:');
    const actor = {
      actorId: 'restricted-card-reader',
      budgetId: request.financialSnapshot.source.budgetId,
    };
    try {
      // The requested category and destination account are visible; the private
      // savings source is deliberately not granted any resource capability.
      await grantResources(
        store,
        actor,
        [
          { resourceKind: 'budget', resourceId: actor.budgetId },
          { resourceKind: 'category', resourceId: 'food' },
          { resourceKind: 'account', resourceId: 'checking' },
        ],
        request.context.evaluatedAt,
      );
      const projector = new LiquidityProjector(store, actor, request.financialSnapshot);
      expectRestrictedProjection(projector.card(blockedCard), blockedCard);
    } finally {
      store.close();
    }
  });
});
