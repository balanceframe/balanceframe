import { describe, expect, it, vi } from 'vitest';
import type { FinancialSnapshot, SourceObservation } from '@balanceframe/protocol-generated';
import {
  NotificationRuntime,
  createNativeAnalysisProtocol,
  createObserveComposition,
  financialDecisionDedupKey,
  type ChannelAdapter,
  type NativeBindingShim,
  type NotificationPolicy,
} from '../src';

const CAPTURED_AT = '2026-08-23T12:00:00Z';
const STALE_AT = '2026-08-20T09:00:00Z';
const SNAPSHOT_ID = 'snapshot-attention-2026-08-23';
const REVISION_ONE = 'sha256:attention-revision-1';
const REVISION_TWO = 'sha256:attention-revision-2';
const POLICY_VERSION = 'financial-attention-v1';
const BUDGET_ID = 'budget-attention';
const ACTOR_ID = 'actor-attention';

const FINANCIAL_CLASSIFICATIONS = [
  'account_readiness_blocker',
  'transfer_needs_attention',
  'reservation_conflict',
  'commitment_conflict',
  'evidence_connector_degradation',
  'unresolved_material_evidence',
] as const;

const LEGACY_SNAPSHOT = {
  schemaVersion: '1.0',
  actualVersion: '26.8.0',
  snapshotDate: '2026-08-23',
  accounts: [],
  transactions: [],
  categories: [],
  payees: [],
  rules: [],
  schedules: [],
  budgets: [],
  tags: [],
};

const OBSERVATIONS: SourceObservation[] = [
  {
    kind: 'account_freshness',
    scope: { kind: 'account', id: 'account-card' },
    state: 'stale',
    observedAt: STALE_AT,
    evidence: [
      {
        evidenceId: 'bank-sync-card-119',
        kind: 'bank_sync',
        authorized: true,
        redaction: 'visible',
      },
    ],
  },
  {
    kind: 'account_freshness',
    scope: { kind: 'account', id: 'account-cash' },
    state: 'unavailable',
    observedAt: null,
    evidence: [
      {
        evidenceId: 'connector-error-cash-7',
        kind: 'connector_error',
        authorized: false,
        redaction: 'redacted',
      },
    ],
  },
  {
    kind: 'transfer_ambiguity',
    scope: { kind: 'transaction', id: 'transfer-one-sided' },
    state: 'ambiguous',
    observedAt: CAPTURED_AT,
    evidence: [
      {
        evidenceId: 'transfer-counterpart-card',
        kind: 'transfer_candidate',
        authorized: false,
        redaction: 'redacted',
      },
    ],
  },
  {
    kind: 'reconciliation',
    scope: { kind: 'account', id: 'account-checking' },
    state: 'unreconciled',
    observedAt: CAPTURED_AT,
    evidence: [
      {
        evidenceId: 'transaction-pending',
        kind: 'transaction',
        authorized: true,
        redaction: 'visible',
      },
    ],
  },
];

function financialSnapshot(contentHash = REVISION_ONE): FinancialSnapshot {
  return {
    contractVersion: '1.0',
    snapshotId: SNAPSHOT_ID,
    contentHash,
    source: {
      ledgerBackend: 'actual',
      ledgerId: 'ledger-attention',
      budgetId: BUDGET_ID,
      spaceId: 'space-attention',
    },
    capturedAt: CAPTURED_AT,
    sourceNormalizationVersion: 'normalization-1',
    legacySnapshot: LEGACY_SNAPSHOT,
    coverage: {
      accounts: 'complete',
      transactions: 'empty',
      categories: 'empty',
      payees: 'empty',
      rules: 'empty',
      schedules: 'empty',
      budgets: 'empty',
      tags: 'empty',
    },
    inclusionScope: {
      pendingActivity: 'included',
      unclearedActivity: 'included',
    },
    observations: OBSERVATIONS,
  };
}

function nativeShim(): NativeBindingShim {
  return {
    evaluateTargetHealth: vi.fn(() =>
      JSON.stringify({
        categories: [],
        overallLabel: 'healthy',
        healthyCount: 0,
        atRiskCount: 0,
        sinkingFundCount: 0,
      }),
    ),
    evaluateFinancialState: vi.fn(() =>
      JSON.stringify({
        overallLabel: 'healthy',
        netWorth: { minorUnits: '0', currency: 'USD' },
        monthlyCashFlow: { minorUnits: '0', currency: 'USD' },
        budgetAdherencePercent: 100,
        categoriesAtRisk: 0,
        sinkingFundsUnderfunded: 0,
        advice: [],
        freshness: null,
      }),
    ),
  } as unknown as NativeBindingShim;
}

function ledgerWithFinancialSnapshot(snapshot = financialSnapshot()) {
  const synchronization = { snapshot: LEGACY_SNAPSHOT, financialSnapshot: snapshot };
  return {
    getLatestSynchronization: vi.fn(() => synchronization),
    synchronize: vi.fn(async () => synchronization),
  };
}

function notificationPolicy(
  channels: NotificationPolicy['channels'] = [
    { type: 'in_app', enabled: true, rateLimitPerMinute: 60, displayName: 'In app' },
  ],
): NotificationPolicy {
  return {
    policyVersion: POLICY_VERSION,
    eligibility: [
      {
        classifications: [...FINANCIAL_CLASSIFICATIONS],
        minSeverity: 'normal',
        requiredCapability: 'notification:receive',
        requiredScope: `budget:${BUDGET_ID}`,
      },
    ],
    recipients: [
      {
        actorId: ACTOR_ID,
        channels: channels.map(({ type }) => type),
        quietHours: null,
      },
    ],
    channels,
    redaction: {
      restricted: { visibleFields: ['title', 'summary', 'classification', 'scope', 'snapshotId'] },
    },
    maxRetries: 3,
    defaultRedactionClass: 'restricted',
  };
}

function notificationEvent(classification = 'reservation_conflict') {
  return {
    id: `event-${classification}`,
    eventVersion: 1,
    budgetId: BUDGET_ID,
    classification,
    recipientId: ACTOR_ID,
    scope: `budget:${BUDGET_ID}`,
    redactionClass: 'restricted',
    channelConfigVersion: null,
    policyVersion: POLICY_VERSION,
    correlationId: 'financial-decision-key',
    payload: JSON.stringify({ title: 'Decision attention', summary: 'Review required' }),
    createdAt: CAPTURED_AT,
  };
}

function outbox(id: string, eventId: string) {
  return {
    id,
    eventId,
    deliveryKey: `delivery-${id}`,
    channelType: 'in_app',
    channelConfigVersion: null,
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    claimToken: null,
    claimExpiresAt: null,
    lastAttemptedAt: null,
    nextAttemptAt: null,
    acknowledgedAt: null,
    failedAt: null,
    failureReason: null,
    suppressedAt: null,
    suppressedReason: null,
    correlationId: 'financial-decision-key',
    createdAt: CAPTURED_AT,
    updatedAt: CAPTURED_AT,
  };
}

describe('canonical financial observations on the existing attention home result', () => {
  it('classifies actionable observations and carries one shared issue plus finding metadata', async () => {
    const protocol = await createNativeAnalysisProtocol(async () => nativeShim());
    const result = await protocol.attentionHome!(ledgerWithFinancialSnapshot(), {});

    const byClassification = new Map(
      result.blockers.map((blocker) => [blocker.classification, blocker]),
    );

    expect([...byClassification.keys()]).toEqual(
      expect.arrayContaining([
        'account_readiness_blocker',
        'transfer_needs_attention',
        'evidence_connector_degradation',
        'unresolved_material_evidence',
      ]),
    );

    expect(byClassification.get('account_readiness_blocker')).toEqual(
      expect.objectContaining({
        code: 'account_freshness_coverage',
        snapshotId: SNAPSHOT_ID,
        policyVersion: POLICY_VERSION,
        revision: REVISION_ONE,
        findingStatus: 'open',
        findingVersion: 1,
        issue: {
          code: 'account_freshness_coverage',
          severity: 'warning',
          effect: 'blocks',
          scope: { kind: 'account', id: 'account-card' },
          evidence: OBSERVATIONS[0].evidence,
          remediation: expect.any(Object),
          redaction: 'visible',
        },
      }),
    );
    expect(byClassification.get('transfer_needs_attention')).toEqual(
      expect.objectContaining({
        snapshotId: SNAPSHOT_ID,
        revision: REVISION_ONE,
        issue: expect.objectContaining({
          code: 'duplicate_transfer_ambiguity',
          scope: { kind: 'transaction', id: 'transfer-one-sided' },
          evidence: OBSERVATIONS[2].evidence,
        }),
      }),
    );
    expect(byClassification.get('evidence_connector_degradation')).toEqual(
      expect.objectContaining({
        issue: expect.objectContaining({
          scope: { kind: 'account', id: 'account-cash' },
          evidence: OBSERVATIONS[1].evidence,
          redaction: 'redacted',
        }),
      }),
    );
  });

  it('deduplicates repeat observations but emits a new identity for a changed revision', async () => {
    const protocol = await createNativeAnalysisProtocol(async () => nativeShim());
    const first = await protocol.attentionHome!(ledgerWithFinancialSnapshot(), {});
    const repeated = await protocol.attentionHome!(ledgerWithFinancialSnapshot(), {});
    const revised = await protocol.attentionHome!(
      ledgerWithFinancialSnapshot(financialSnapshot(REVISION_TWO)),
      {},
    );

    const keyFor = (result: Awaited<ReturnType<NonNullable<typeof protocol.attentionHome>>>) =>
      result.blockers.find(({ classification }) => classification === 'account_readiness_blocker')
        ?.dedupKey;

    expect(keyFor(first)).toEqual(expect.any(String));
    expect(keyFor(first)?.length).toBeGreaterThan(0);
    expect(keyFor(repeated)).toBe(keyFor(first));
    expect(keyFor(revised)).not.toBe(keyFor(first));
  });
});

describe('financial decision notification identity and policy', () => {
  it('uses classification, canonical scope, snapshot, policy, and revision as its full identity', () => {
    const identity = {
      classification: 'reservation_conflict',
      scope: { kind: 'category' as const, id: 'category-groceries' },
      snapshotId: SNAPSHOT_ID,
      policyVersion: POLICY_VERSION,
      revision: REVISION_ONE,
    };

    const first = financialDecisionDedupKey(identity);
    const repeated = financialDecisionDedupKey({ ...identity });

    expect(repeated).toBe(first);
    for (const changed of [
      { ...identity, classification: 'commitment_conflict' },
      { ...identity, scope: { kind: 'category' as const, id: 'category-rent' } },
      { ...identity, snapshotId: 'snapshot-next' },
      { ...identity, policyVersion: 'financial-attention-v2' },
      { ...identity, revision: REVISION_TWO },
    ]) {
      expect(financialDecisionDedupKey(changed)).not.toBe(first);
    }
  });

  it('makes every financial finding classification eligible in the default composition policy', async () => {
    const store = {
      cancelPendingJobs: vi.fn(),
      deleteActorMembership: vi.fn(),
      recordExport: vi.fn(),
      getLastExport: vi.fn(),
      deleteScopeData: vi.fn(),
      createNotificationEvent: vi.fn(),
      getNotificationEvent: vi.fn(),
      enqueueNotification: vi.fn(),
      claimNotificationDelivery: vi.fn(),
      completeNotificationDelivery: vi.fn(),
      failNotificationDelivery: vi.fn(),
      acknowledgeNotification: vi.fn(),
      suppressNotification: vi.fn(),
      getOutboxRecord: vi.fn(),
      getPendingNotifications: vi.fn(),
      getRetryableNotifications: vi.fn(),
      getDeliveryAttempts: vi.fn(),
      listOutboxRecords: vi.fn(),
      getNotificationPolicy: vi.fn(),
      getActorMembership: vi.fn(),
      appendAuditRecord: vi.fn(),
    };
    const composition = await createObserveComposition({
      analysisProtocol: {} as never,
      workflowStore: store as never,
      actorId: ACTOR_ID,
      requestId: 'request-attention-2026-08-23',
    });

    expect(composition.notificationRuntime).not.toBeNull();
    for (const classification of FINANCIAL_CLASSIFICATIONS) {
      expect(composition.notificationRuntime!.evaluateEligibility(classification, 'high')).toBe(
        true,
      );
    }
  });

  it('rejects an explicitly targeted recipient that is not a recipient in the active policy', async () => {
    const store = {
      createNotificationEvent: vi.fn(),
      enqueueNotification: vi.fn(),
      appendAuditRecord: vi.fn(),
      getActorMembership: vi.fn(),
    };
    const runtime = new NotificationRuntime(store as never, notificationPolicy(), []);
    runtime.setReAuthorizationHook(async () => true);

    await expect(
      runtime.create({
        budgetId: BUDGET_ID,
        classification: 'reservation_conflict',
        severity: 'high',
        payload: JSON.stringify({ title: 'Decision attention' }),
        recipientId: 'actor-outside-policy',
        scope: `budget:${BUDGET_ID}`,
        redactionClass: 'restricted',
      }),
    ).rejects.toThrow();

    expect(store.createNotificationEvent).not.toHaveBeenCalled();
    expect(store.enqueueNotification).not.toHaveBeenCalled();
  });

  it('rejects creation before persistence when the requested scope is not the exact policy scope', async () => {
    const store = {
      createNotificationEvent: vi.fn(),
      enqueueNotification: vi.fn(),
      appendAuditRecord: vi.fn(),
      getActorMembership: vi.fn(),
    };
    const runtime = new NotificationRuntime(store as never, notificationPolicy(), []);
    const reauthorize = vi.fn(
      async (_actorId: string, _capability: string, scope: string) =>
        scope === `budget:${BUDGET_ID}`,
    );
    runtime.setReAuthorizationHook(reauthorize);

    await expect(
      runtime.create({
        budgetId: BUDGET_ID,
        classification: 'reservation_conflict',
        severity: 'high',
        payload: JSON.stringify({ title: 'Decision attention' }),
        recipientId: ACTOR_ID,
        scope: 'budget:budget-outside-policy',
        redactionClass: 'restricted',
      }),
    ).rejects.toThrow();

    expect(store.createNotificationEvent).not.toHaveBeenCalled();
    expect(store.enqueueNotification).not.toHaveBeenCalled();
  });

  it('creates the matching policy recipient only after exact-scope authorization succeeds', async () => {
    const event = notificationEvent();
    const record = outbox('outbox-authorized', event.id);
    const store = {
      createNotificationEvent: vi.fn(async () => event),
      enqueueNotification: vi.fn(async () => record),
      appendAuditRecord: vi.fn(),
      getActorMembership: vi.fn(),
    };
    const runtime = new NotificationRuntime(store as never, notificationPolicy(), []);
    const reauthorize = vi.fn(async () => true);
    runtime.setReAuthorizationHook(reauthorize);

    const result = await runtime.create({
      budgetId: BUDGET_ID,
      classification: 'reservation_conflict',
      severity: 'high',
      payload: event.payload,
      recipientId: ACTOR_ID,
      scope: `budget:${BUDGET_ID}`,
      redactionClass: 'restricted',
    });

    expect(reauthorize).toHaveBeenCalledWith(
      ACTOR_ID,
      'notification:receive',
      `budget:${BUDGET_ID}`,
    );
    expect(store.createNotificationEvent).toHaveBeenCalledTimes(1);
    expect(store.enqueueNotification).toHaveBeenCalledTimes(1);
    expect(result.outboxRecords).toEqual([record]);
  });

  it.each([`budget:${BUDGET_ID}`, '*'])(
    'accepts an active store membership scoped to %s without a custom re-authorization hook',
    async (membershipScope) => {
      const event = notificationEvent();
      const record = outbox(`outbox-membership-${membershipScope}`, event.id);
      const store = {
        createNotificationEvent: vi.fn(async () => event),
        enqueueNotification: vi.fn(async () => record),
        appendAuditRecord: vi.fn(),
        getActorMembership: vi.fn(async () => ({
          actorId: ACTOR_ID,
          status: 'active',
          capabilities: ['notification:receive'],
          scope: membershipScope,
        })),
      };
      const runtime = new NotificationRuntime(store as never, notificationPolicy(), []);

      const result = await runtime.create({
        budgetId: BUDGET_ID,
        classification: 'reservation_conflict',
        severity: 'high',
        payload: event.payload,
        recipientId: ACTOR_ID,
        scope: `budget:${BUDGET_ID}`,
        redactionClass: 'restricted',
      });

      expect(result.outboxRecords).toEqual([record]);
      expect(store.createNotificationEvent).toHaveBeenCalledTimes(1);
      expect(store.enqueueNotification).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects creation before persistence when store membership has a different scope', async () => {
    const store = {
      createNotificationEvent: vi.fn(),
      enqueueNotification: vi.fn(),
      appendAuditRecord: vi.fn(),
      getActorMembership: vi.fn(async () => ({
        actorId: ACTOR_ID,
        status: 'active',
        capabilities: ['notification:receive'],
        scope: 'budget:budget-other',
      })),
    };
    const runtime = new NotificationRuntime(store as never, notificationPolicy(), []);

    await expect(
      runtime.create({
        budgetId: BUDGET_ID,
        classification: 'reservation_conflict',
        severity: 'high',
        payload: notificationEvent().payload,
        recipientId: ACTOR_ID,
        scope: `budget:${BUDGET_ID}`,
        redactionClass: 'restricted',
      }),
    ).rejects.toThrow();

    expect(store.createNotificationEvent).not.toHaveBeenCalled();
    expect(store.enqueueNotification).not.toHaveBeenCalled();
  });
});

describe('financial decision notification delivery isolation', () => {
  it('re-authorizes the recipient capability and exact scope again at dispatch', async () => {
    const event = notificationEvent();
    const record = outbox('outbox-revoked', event.id);
    const store = {
      claimNotificationDelivery: vi.fn(async () => record),
      getNotificationEvent: vi.fn(async () => event),
      failNotificationDelivery: vi.fn(async () => ({ ...record, status: 'failed' })),
      appendAuditRecord: vi.fn(),
    };
    const deliver = vi.fn();
    const adapter: ChannelAdapter = {
      channelType: 'in_app',
      isHealthy: () => true,
      deliver,
    };
    const runtime = new NotificationRuntime(store as never, notificationPolicy(), [adapter]);
    const reauthorize = vi.fn(async () => false);
    runtime.setReAuthorizationHook(reauthorize);

    const result = await runtime.dispatch(record.id, 'claim-revoked');

    expect(reauthorize).toHaveBeenCalledWith(
      ACTOR_ID,
      'notification:receive',
      `budget:${BUDGET_ID}`,
    );
    expect(result.status).toBe('failed');
    expect(store.failNotificationDelivery).toHaveBeenCalledWith(
      record.id,
      'claim-revoked',
      'Recipient authorization revoked',
      false,
    );
    expect(deliver).not.toHaveBeenCalled();
  });

  it('denies dispatch when store membership is not scoped to the event', async () => {
    const event = notificationEvent();
    const record = outbox('outbox-membership-scope-mismatch', event.id);
    const store = {
      claimNotificationDelivery: vi.fn(async () => record),
      getNotificationEvent: vi.fn(async () => event),
      getActorMembership: vi.fn(async () => ({
        actorId: ACTOR_ID,
        status: 'active',
        capabilities: ['notification:receive'],
        scope: 'budget:budget-other',
      })),
      completeNotificationDelivery: vi.fn(async () => ({ ...record, status: 'delivered' })),
      failNotificationDelivery: vi.fn(async () => ({ ...record, status: 'failed' })),
      appendAuditRecord: vi.fn(),
    };
    const deliver = vi.fn(async () => ({ ok: true, code: 'accepted' }));
    const adapter: ChannelAdapter = {
      channelType: 'in_app',
      isHealthy: () => true,
      deliver,
    };
    const runtime = new NotificationRuntime(store as never, notificationPolicy(), [adapter]);

    const result = await runtime.dispatch(record.id, 'claim-membership-scope-mismatch');

    expect(result.status).toBe('failed');
    expect(deliver).not.toHaveBeenCalled();
    expect(store.completeNotificationDelivery).not.toHaveBeenCalled();
  });

  it('denies dispatch when the classification rule required scope differs from the event scope', async () => {
    const event = {
      ...notificationEvent(),
      scope: 'budget:budget-outside-policy',
    };
    const record = outbox('outbox-rule-scope-mismatch', event.id);
    const store = {
      claimNotificationDelivery: vi.fn(async () => record),
      getNotificationEvent: vi.fn(async () => event),
      getActorMembership: vi.fn(async () => ({
        actorId: ACTOR_ID,
        status: 'active',
        capabilities: ['notification:receive'],
        scope: '*',
      })),
      completeNotificationDelivery: vi.fn(async () => ({ ...record, status: 'delivered' })),
      failNotificationDelivery: vi.fn(async () => ({ ...record, status: 'failed' })),
      appendAuditRecord: vi.fn(),
    };
    const deliver = vi.fn(async () => ({ ok: true, code: 'accepted' }));
    const adapter: ChannelAdapter = {
      channelType: 'in_app',
      isHealthy: () => true,
      deliver,
    };
    const runtime = new NotificationRuntime(store as never, notificationPolicy(), [adapter]);

    const result = await runtime.dispatch(record.id, 'claim-rule-scope-mismatch');

    expect(result.status).toBe('failed');
    expect(deliver).not.toHaveBeenCalled();
    expect(store.completeNotificationDelivery).not.toHaveBeenCalled();
  });

  it('applies the restricted policy before the adapter sees a delivery payload', async () => {
    const secret = 'provider-secret-that-must-not-reach-an-adapter';
    const event = {
      ...notificationEvent(),
      payload: JSON.stringify({
        title: 'Decision attention',
        summary: 'Review required',
        classification: 'reservation_conflict',
        scope: `budget:${BUDGET_ID}`,
        snapshotId: SNAPSHOT_ID,
        rawEvidence: { accountId: 'account-restricted', value: secret },
        rawPayload: { providerResponse: secret },
        secrets: { accessToken: secret },
      }),
    };
    const record = outbox('outbox-restricted', event.id);
    const store = {
      claimNotificationDelivery: vi.fn(async () => record),
      getNotificationEvent: vi.fn(async () => event),
      completeNotificationDelivery: vi.fn(async () => ({ ...record, status: 'delivered' })),
      failNotificationDelivery: vi.fn(),
      appendAuditRecord: vi.fn(),
    };
    const deliver = vi.fn(async () => ({ ok: true, code: 'accepted' }));
    const adapter: ChannelAdapter = {
      channelType: 'in_app',
      isHealthy: () => true,
      deliver,
    };
    const runtime = new NotificationRuntime(store as never, notificationPolicy(), [adapter]);
    const reauthorize = vi.fn(async () => true);
    runtime.setReAuthorizationHook(reauthorize);

    const result = await runtime.dispatch(record.id, 'claim-restricted');

    expect(result.status).toBe('delivered');
    expect(reauthorize).toHaveBeenCalledWith(
      ACTOR_ID,
      'notification:receive',
      `budget:${BUDGET_ID}`,
    );
    expect(deliver).toHaveBeenCalledWith(
      {
        title: 'Decision attention',
        summary: 'Review required',
        classification: 'reservation_conflict',
        scope: `budget:${BUDGET_ID}`,
        snapshotId: SNAPSHOT_ID,
      },
      ACTOR_ID,
    );
    expect(deliver.mock.calls[0]?.[1]).toBe(ACTOR_ID);
    expect(deliver.mock.calls[0]?.[1]).not.toBe(record.deliveryKey);
    const adapterPayload = deliver.mock.calls[0]?.[0];
    expect(adapterPayload).not.toHaveProperty('rawEvidence');
    expect(adapterPayload).not.toHaveProperty('rawPayload');
    expect(adapterPayload).not.toHaveProperty('secrets');
    expect(JSON.stringify(adapterPayload)).not.toContain(secret);
  });

  it('allows one delivery to fail without preventing an independent delivery', async () => {
    const failedEvent = notificationEvent('reservation_conflict');
    const deliveredEvent = {
      ...notificationEvent('commitment_conflict'),
      id: 'event-commitment-conflict',
    };
    const failedOutbox = outbox('outbox-failed', failedEvent.id);
    const deliveredOutbox = outbox('outbox-delivered', deliveredEvent.id);
    const records = new Map([
      [failedOutbox.id, failedOutbox],
      [deliveredOutbox.id, deliveredOutbox],
    ]);
    const events = new Map([
      [failedEvent.id, failedEvent],
      [deliveredEvent.id, deliveredEvent],
    ]);
    const store = {
      claimNotificationDelivery: vi.fn(async (id: string) => records.get(id) ?? null),
      getNotificationEvent: vi.fn(async (id: string) => events.get(id) ?? null),
      failNotificationDelivery: vi.fn(async () => ({ ...failedOutbox, status: 'pending' })),
      completeNotificationDelivery: vi.fn(async () => ({
        ...deliveredOutbox,
        status: 'delivered',
      })),
      appendAuditRecord: vi.fn(),
    };
    const deliver = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'email provider unavailable' })
      .mockResolvedValueOnce({ ok: true, code: 'accepted' });
    const adapter: ChannelAdapter = {
      channelType: 'in_app',
      isHealthy: () => true,
      deliver,
    };
    const runtime = new NotificationRuntime(store as never, notificationPolicy(), [adapter]);
    runtime.setReAuthorizationHook(async () => true);

    const failed = await runtime.dispatch(failedOutbox.id, 'claim-failed');
    const delivered = await runtime.dispatch(deliveredOutbox.id, 'claim-delivered');

    expect(failed.status).toBe('retryable');
    expect(delivered.status).toBe('delivered');
    expect(store.failNotificationDelivery).toHaveBeenCalledWith(
      failedOutbox.id,
      'claim-failed',
      'email provider unavailable',
      true,
    );
    expect(store.completeNotificationDelivery).toHaveBeenCalledWith(
      deliveredOutbox.id,
      'claim-delivered',
      { code: 'accepted', body: undefined },
    );
  });
});
