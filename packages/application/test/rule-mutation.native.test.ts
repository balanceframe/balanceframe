import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ProtocolSnapshot } from '@balanceframe/protocol-generated';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import {
  SqliteWorkflowStore, GENERIC_MUTATION_POLICY_VERSION, deriveProposalAuthorizationFacts,
} from '@balanceframe/workflow-store';
import type { HumanControlContext, ResourceGrantRestrictions } from '@balanceframe/workflow-store';
import type { BudgetLedger, LedgerSnapshotResult, RuleCreatePrecondition, RuleProposal } from '@balanceframe/actual-adapter';
import { ActualConnector } from '../../actual-adapter/src/connector';
import type { RuleEntity } from '@actual-app/core/types/models';
import {
  merchantFixture, now as merchantNow, candidateId, payeeId, categoryId, evidenceKey,
} from './merchant-service.fixture';
import { RuleMutationService, createNativeRuleMutationProtocol } from '../src/rule-mutation';
import type { RuleProposalInput } from '../src/rule-mutation';
import type { ResolveCurrentRuleReviewContext, ResolveRuleReplayPublicationAuthority } from '../src/rule-mutation';

// The package alias must load the current source, not the previously built package, in this module-boundary test.
vi.mock('@balanceframe/workflow-store', async () => await import('../../workflow-store/src/index'));

interface NativeRuleBindings {
  planCreateRule(input: string): string;
  simulateCreateRulePlan(input: string): string;
  verifyRuleMutation(input: string): string;
}


const native = createRequire(import.meta.url)('@balanceframe/native') as NativeRuleBindings;
const createRulePlanSchema = z.object({
  planId: z.string().min(1),
  ruleName: z.string(),
  trigger: z.object({
    stage: z.literal('post'),
    conditionsOp: z.literal('and'),
    conditions: z.tuple([z.object({ field: z.literal('payee'), op: z.literal('is'), value: z.string() }).strict()]),
  }).strict(),
  actions: z.tuple([z.object({ op: z.literal('set'), field: z.literal('category'), value: z.string() }).strict()]),
  hash: z.string().min(1),
  conditions: z.array(
    z.object({ field: z.string(), operation: z.string(), value: z.string() }),
  ),
});
const verificationSchema = z.object({
  verified: z.boolean(),
  reasonCodes: z.array(z.string()),
  message: z.string().nullable(),
});
const ruleSimulationSchema = z.object({
  ruleId: z.string(),
  name: z.string(),
  transactionsMatched: z.number().int().nonnegative(),
  transactionsAffected: z.array(z.string()),
  categoryDistribution: z.record(z.number().int().nonnegative()),
  conflicts: z.array(z.string()),
  examples: z.array(
    z.object({
      txId: z.string(),
      payee: z.string().nullable(),
      amount: z.object({ minorUnits: z.string(), currency: z.string() }),
      currentCategory: z.string().nullable(),
      wouldChange: z.boolean(),
    }),
  ),
});

const baseSnapshot = canonicalProtocolSnapshotSchema.parse(
  JSON.parse(
    readFileSync(
      new URL('../../../protocol/fixtures/representative.json', import.meta.url),
      'utf8',
    ),
  ),
);
const reviewContext = {
  scope: { spaceId: 'space-native-rule', budgetId: 'budget-native-rule', connectionId: 'connection-native-rule' },
  sourceFactsHash: 'native-source-v1',
  evidenceKey: null,
  evidenceRevision: 'direct-settings-v1',
  merchantPolicyVersion: 'merchant-policy-v1',
  visibilityHash: 'native-visibility-v1',
  expiresAt: '2099-01-01T00:00:00Z',
};

function verifyRuleMutation(plan: unknown, snapshot: ProtocolSnapshot) {
  return verificationSchema.parse(
    JSON.parse(native.verifyRuleMutation(JSON.stringify({ plan, snapshot }))),
  );
}

describe('compiled native rule mutation contract', () => {
  it('plans, simulates, and verifies a matching wrapped Actual rule with the compiled native API', () => {
    const plan = createRulePlanSchema.parse(
      JSON.parse(
        native.planCreateRule(
          JSON.stringify({
            ruleName: 'Whole Foods categorization',
            payeeId: 'pay_3',
            categoryId: 'cat_2',
            reviewContext,
            snapshot: baseSnapshot,
          }),
        ),
      ),
    );

    expect(plan).toMatchObject({
      ruleName: 'Whole Foods categorization',
      trigger: {
        stage: 'post', conditionsOp: 'and',
        conditions: [{ field: 'payee', op: 'is', value: 'pay_3' }],
      },
      actions: [{ op: 'set', field: 'category', value: 'cat_2' }],
      conditions: [{ field: 'payee', operation: 'is', value: 'pay_3' }],
    });
    expect(plan).not.toHaveProperty('preconditions');
    expect(plan).not.toHaveProperty('expectedOutcome');

    const simulation = ruleSimulationSchema.parse(
      JSON.parse(native.simulateCreateRulePlan(JSON.stringify({ plan, snapshot: baseSnapshot }))),
    );
    expect(simulation.transactionsMatched).toBeGreaterThan(0);
    expect(simulation.transactionsAffected).toContain('tx_002');
    expect(simulation.transactionsAffected).not.toContain('tx_000');
    expect(simulation.ruleId).toBe('');
    expect(simulation.conflicts).toEqual([]);
    expect(simulation.categoryDistribution.cat_2).toBeGreaterThan(0);

    const absent = verifyRuleMutation(plan, baseSnapshot);
    expect(absent.verified).toBe(false);

    const matchingRule = {
      id: 'rule_created_native',
      name: 'Whole Foods',
      order: 0,
      trigger: {
        stage: 'post',
        conditionsOp: 'and',
        conditions: [{ field: 'payee', op: 'is', value: 'pay_3', type: 'id' }],
      },
      actions: [{ op: 'set', field: 'category', value: 'cat_2' }],
      inactive: false,
    };
    const afterWrite: ProtocolSnapshot = {
      ...baseSnapshot,
      rules: [matchingRule],
    };

    expect(verifyRuleMutation(plan, afterWrite)).toEqual({
      verified: true, reasonCodes: ['rule_creation_verified'], message: null,
    });
    expect(
      verifyRuleMutation(plan, {
        ...afterWrite,
        rules: [
          {
            ...matchingRule,
            trigger: {
              ...matchingRule.trigger,
              conditionsOp: 'or',
            },
          },
        ],
      }).verified,
    ).toBe(false);
    for (const changed of [
      { ...matchingRule, inactive: true },
      { ...matchingRule, trigger: { ...matchingRule.trigger, stage: 'pre' } },
      { ...matchingRule, trigger: { ...matchingRule.trigger, conditions: [{ field: 'payee', op: 'is', value: 'PAY_3' }] } },
      { ...matchingRule, actions: [{ op: 'set', field: 'category', value: 'cat_1' }] },
    ]) {
      expect(verifyRuleMutation(plan, { ...afterWrite, rules: [changed] })).toEqual({
        verified: false,
        reasonCodes: ['rule_creation_not_verified'],
        message: 'Created rule is absent or differs from the approved plan.',
      });
    }
  });
});

describe('acquired native create-rule final mutation authority', () => {
  const now = '2098-01-01T12:00:00.000Z';
  const shortly = '2098-01-01T12:00:30.000Z';
  const expiresAt = '2099-01-01T00:00:00.000Z';
  let store: SqliteWorkflowStore | undefined;
  afterEach(() => {
    store?.close();
    store = undefined;
    vi.useRealTimers();
  });
  const human = (actorId: string): HumanControlContext => ({
    method: 'human-session', actorId, sessionId: `session:${actorId}`, reauthenticatedAt: now,
  });

  it.each([
    'unchanged', 'executor revoked', 'executor account-limited', 'executor category-limited',
    'executor count-limited', 'executor amount-limited', 'executor proposal-only',
    'superseded', 'requester revoked', 'approver revoked',
    'requester expired', 'approver expired', 'approval expired', 'proposal expired', 'lease expired',
    'executor credential revoked', 'executor credential expired', 'executor credential check failed', 'policy changed',
    'source omitted', 'source rules failed', 'source namespace missing', 'source closed history missing',
  ])('checks the exact acquired authority after asynchronous source work: %s', async (change) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    store = new SqliteWorkflowStore(':memory:');
    await store.claimBootstrap({ name: 'Owner', email: 'owner@example.test', claimId: 'final-native' });
    await store.finalizeBootstrap({ claimId: 'final-native', ownerUserId: 'owner' });
    const governance = store.governance;
    const unbound = governance.createSpace({
      actorId: 'owner', name: 'Final native authority', kind: 'shared', now, auth: human('owner'),
    });
    const budgetId = 'budget-native-final';
    const space = governance.bindBudget({ spaceId: unbound.id, budgetId, now, auth: human('owner') });
    const memberships: Record<string, string> = {};
    for (const actorId of ['requester', 'approver', 'executor']) {
      await store.upsertActorMembership(actorId, 'active', [], 'native-final');
      memberships[actorId] = governance.addMembership({
        spaceId: space.id, actorId, validFrom: now,
        ...((change === 'requester expired' && actorId === 'requester') ||
          (change === 'approver expired' && actorId === 'approver') ? { validUntil: shortly } : {}),
        now, auth: human('owner'),
      }).id;
    }
    const policy = governance.getPolicy({ spaceId: space.id })!;
    governance.setPolicy({
      spaceId: space.id, expectedVersion: policy.version,
      policy: { minimumApprovers: 1, approvalThresholds: [], operationApprovers: { create_rule: 1 } },
      now, auth: human('owner'),
    });
    const context = { ...reviewContext, scope: { spaceId: space.id, budgetId, connectionId: 'native-final' } };
    const snapshot = {
      ...baseSnapshot, snapshotDate: now, rules: [],
      accounts: [...baseSnapshot.accounts, { ...baseSnapshot.accounts[0]!, id: 'native-closed-account', isClosed: true }],
    };
    const rust = await createNativeRuleMutationProtocol();
    const input: RuleProposalInput = {
      name: 'Whole Foods categorization', budgetId, stage: 'post', conditionsOp: 'and',
      conditions: [{ field: 'payee' as const, op: 'is' as const, value: 'pay_3' }],
      actions: [{ field: 'category' as const, op: 'set' as const, value: 'cat_2' }],
      reviewContext: context,
    };
    const plan = rust.planCreateRule(input, snapshot);
    const simulation = rust.simulateCreateRulePlan(plan, snapshot);
    const nativePlanning = vi.spyOn(rust, 'planCreateRule');
    expect(simulation.transactionsMatched).toBeGreaterThan(0);
    const rule = { ...plan.trigger, actions: plan.actions };
    const payload = {
      kind: 'create_rule' as const, transactionId: null, categoryId: 'cat_2', rule,
      composite: {
        operations: [], reallocations: [], transferRecommendations: [], ledgerProjections: [],
        evidenceReferences: [], nativePayloadHash: plan.hash,
      },
    };
    const preconditions = {
      actualVersion: snapshot.actualVersion, nativeRule: rule, nativePlan: plan,
      ruleName: input.name, reviewContext: context, reviewedSimulation: simulation,
      sourceAccounts: snapshot.accounts.map((account) => ({ accountId: account.id })),
      sourceTransactions: snapshot.transactions.map((transaction) => ({
        transactionId: transaction.id, accountId: transaction.accountId, categoryId: transaction.categoryId,
      })),
    };
    const resources = [
      { resourceKind: 'budget' as const, resourceId: budgetId },
      ...deriveProposalAuthorizationFacts('create_rule', payload, preconditions).resources,
    ];
    const grant = (actorId: string, capability: string, granted = true, restrictions?: ResourceGrantRestrictions) => {
      for (const resource of resources) governance.setResourceGrant({
        spaceId: space.id, budgetId, actorId, membershipId: memberships[actorId]!,
        capability, ...resource, granted, ...(restrictions ? { restrictions } : {}),
        now: new Date().toISOString(), auth: human('owner'),
      });
    };
    for (const [actorId, capability] of [
      ['requester', 'rule:propose'], ['approver', 'rule:approve'], ['executor', 'rule:execute'],
    ]) grant(actorId!, capability!);
    // These independently stay allowed when only mutation grants change.
    for (const actorId of ['requester', 'approver', 'executor'])
      for (const capability of ['observe', 'merchant:analyze', 'rule:view', 'read:accounts', 'read:categories', 'read:transactions'])
        grant(actorId, capability);
    const proposal = await store.createProposal({
      spaceId: space.id, operation: 'create_rule', budgetId, payload,
      preconditions: JSON.stringify(preconditions), actorId: 'requester', auth: human('requester'),
      policyVersion: GENERIC_MUTATION_POLICY_VERSION,
      expiresAt: change === 'proposal expired' ? shortly : expiresAt, provenance: 'manual',
    });
    const approval = await store.createApproval({
      proposalId: proposal.id, payloadHash: proposal.payloadHash, actorId: 'approver',
      expiresAt: change === 'approval expired' || change === 'proposal expired' ? shortly : expiresAt,
      now, auth: human('approver'),
    });
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => { reached = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    let created = false;
    const createRule = vi.fn(async (_proposal: RuleProposal, precondition: RuleCreatePrecondition) => {
      precondition.assertExecutionCurrent();
      created = true;
      return { success: true as const, id: 'native-final-rule' };
    });
    const sourceAvailability = {
      accounts: 'complete', payees: 'complete', categories: 'complete', categoryGroups: 'complete', rules: 'complete',
      history: snapshot.accounts.map(({ id }) => ({
        accountId: id, state: 'complete', startDate: '0001-01-01', endDate: '9999-12-31',
      })),
    };
    if (change === 'source rules failed') sourceAvailability.rules = 'unavailable';
    if (change === 'source namespace missing') delete (sourceAvailability as Partial<typeof sourceAvailability>).categoryGroups;
    if (change === 'source closed history missing')
      sourceAvailability.history = sourceAvailability.history.filter(({ accountId }) => accountId !== 'native-closed-account');
    const synchronize = vi.fn(async (): Promise<LedgerSnapshotResult> => ({
      snapshot: created ? { ...snapshot, rules: [{
        id: 'native-final-rule', name: input.name, order: 0,
        trigger: plan.trigger, actions: plan.actions, inactive: false,
      }] } : snapshot,
      warnings: [],
      rulePlanningSourceAvailability: change === 'source omitted' ? undefined : sourceAvailability,
    } as LedgerSnapshotResult));
    let contextCalls = 0;
    const resolveContext = vi.fn(async () => {
      if (++contextCalls === 2) { reached(); await resume; }
      return structuredClone(context);
    });
    const service = new RuleMutationService(
      store, { synchronize, createRule } as unknown as BudgetLedger, rust, resolveContext,
    );
    let credentialCurrent = true;
    const executorAuth = {
      ...human('executor'),
      credentialExpiresAt: change === 'executor credential expired' ? shortly : expiresAt,
      isCredentialValid: () => {
        if (!credentialCurrent && change === 'executor credential check failed') throw new Error('Session lookup failed');
        return credentialCurrent;
      },
    };
    const execution = service.execute({
      actorId: 'executor', proposalId: proposal.id, approvalId: approval.id, auth: executorAuth,
      requestId: 'native-final', idempotencyKey: 'native-final',
    });
    if (change.startsWith('source ')) {
      const result = await Promise.race([execution, paused.then(() => undefined)]);
      if (!result) { release(); await execution; }
      expect(result?.success).toBe(false);
      expect(result?.message).toContain('Current rule planning source is incomplete');
      expect(createRule).not.toHaveBeenCalled();
      expect(nativePlanning).not.toHaveBeenCalled();
      expect(resolveContext).not.toHaveBeenCalled();
      expect((await store.getIdempotencyRecord('native-final'))?.status).toBe('terminal_failed');
      expect((await store.queryAuditRecordsByProposal(proposal.id))
        .some((audit) => audit.classification === 'execution_failed')).toBe(true);
      return;
    }
    await Promise.race([
      paused,
      execution.then((result) => { throw new Error(`Execution stopped before final context pause: ${JSON.stringify(result)}`); }),
    ]);
    expect((await store.getApproval(approval.id))?.status).toBe('consumed');
    const limits: Record<string, ResourceGrantRestrictions> = {
      'executor account-limited': { accountIds: snapshot.accounts.map((account) => account.id) },
      'executor category-limited': { categoryIds: ['cat_2'] },
      'executor count-limited': { maxOperationCount: 1000 },
      'executor amount-limited': { maxGrossOutgoing: [{ currency: 'USD', minorUnits: '999999999' }] },
      'executor proposal-only': { proposalOnly: true },
    };
    if (change === 'executor revoked') grant('executor', 'rule:execute', false);
    if (limits[change]) grant('executor', 'rule:execute', true, limits[change]);
    if (change === 'requester revoked') grant('requester', 'rule:propose', false);
    if (change === 'approver revoked') grant('approver', 'rule:approve', false);
    if (change === 'superseded') await store.supersedeProposal(proposal.id);
    if (change === 'executor credential revoked' || change === 'executor credential check failed')
      credentialCurrent = false;
    if (change === 'policy changed') governance.setPolicy({
      spaceId: space.id, expectedVersion: governance.getPolicy({ spaceId: space.id })!.version,
      policy: { minimumApprovers: 2, approvalThresholds: [], operationApprovers: { create_rule: 2 } },
      now, auth: human('owner'),
    });
    if (change.endsWith('expired'))
      vi.setSystemTime(new Date(change === 'lease expired' ? '2098-01-01T12:01:01.000Z' : shortly));
    release();
    const result = await execution;
    expect(result.success).toBe(change === 'unchanged');
    expect(createRule).toHaveBeenCalledTimes(change === 'unchanged' ? 1 : 0);
    expect(resolveContext).toHaveBeenCalledTimes(2);
    const record = await store.getIdempotencyRecord('native-final');
    expect(record?.status).toBe(change === 'unchanged' ? 'succeeded' : 'terminal_failed');
    expect((await store.queryAuditRecordsByProposal(proposal.id)).some((audit) =>
      audit.classification === (change === 'unchanged' ? 'execution_completed' : 'execution_failed'))).toBe(true);
  });
});

describe('Actual queued native creation retains acquired and merchant authority', () => {
  it.each([
    'unchanged merchant', 'unchanged ordinary native', 'queued executor revoked',
    'queued normalized-evidence revoked', 'queued merchant policy disabled',
    'dispatched executor revoked', 'dispatched normalized-evidence revoked',
    'synced normalized-evidence revoked', 'reread normalized-evidence revoked',
    'completed normalized-evidence revoked', 'audited normalized-evidence revoked',
    'completed merchant policy disabled', 'audited merchant policy disabled',
  ])('fences the exact same capture at the SDK sink: %s', async (change) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(merchantNow);
    const fixture = await merchantFixture();
    const writer = new ActualConnector({
      client: fixture.client, mode: 'reviewAndApply', currency: 'USD',
      cacheDir: `${fixture.databasePath}.writer`,
    });
    try {
      const policy = {
        mode: 'local-only' as const, allowedProviderIds: [], maxSearchesPerDay: 0,
        maxSpendMinorUnitsPerMonth: 0, billingCurrency: 'USD', cacheTtlHours: 720,
      };
      await fixture.service.setPolicy(fixture.actor, { expectedVersion: 0, value: policy });
      const executor = await fixture.addMember('executor');
      const approver = await fixture.addMember('approver');
      for (const actor of [fixture.actor, executor, approver]) {
        fixture.grantSources(actor);
        fixture.grant('budget', fixture.actor.budgetId, 'full-read', true, actor);
        for (const capability of ['existence', 'history', 'name', 'source'])
          fixture.grant('account', 'account-private', capability, true, actor);
      }
      await writer.connect({ serverUrl: 'https://actual.fixture.test/base', secretKey: 'synthetic-only' });
      await writer.selectBudget(fixture.actor.budgetId);
      const rust = await createNativeRuleMutationProtocol();
      await fixture.manager.withConnection(async (connected) => {
        const capture = await connected.connector.synchronize({ refresh: false });
        if (!('snapshot' in capture)) throw new Error('Missing canonical native snapshot');
        const snapshot = canonicalProtocolSnapshotSchema.parse(capture.snapshot);
        const key = change === 'unchanged ordinary native' ? null : evidenceKey(candidateId);
        const context = await fixture.service.getCurrentRuleReviewContext(executor, {
          evidenceKey: key, connected, snapshot,
          sourceAvailability: capture.rulePlanningSourceAvailability,
        });
        const input: RuleProposalInput = {
          name: 'Market categorization', budgetId: executor.budgetId, stage: 'post', conditionsOp: 'and',
          conditions: [{ field: 'payee', op: 'is', value: payeeId }],
          actions: [{ op: 'set', field: 'category', value: categoryId }], reviewContext: context,
        };
        const plan = rust.planCreateRule(input, snapshot);
        const simulation = rust.simulateCreateRulePlan(plan, snapshot);
        expect(simulation.transactionsMatched).toBeGreaterThan(0);
        const rule = { ...plan.trigger, actions: plan.actions };
        const payload = { kind: 'create_rule' as const, transactionId: null, categoryId, rule, composite: {
          operations: [], reallocations: [], transferRecommendations: [], ledgerProjections: [],
          evidenceReferences: [], nativePayloadHash: plan.hash,
        } };
        const preconditions = {
          actualVersion: snapshot.actualVersion, nativeRule: rule, nativePlan: plan,
          ruleName: input.name, reviewContext: context, reviewedSimulation: simulation,
          sourceAccounts: snapshot.accounts.map((account) => ({ accountId: account.id })),
          sourceTransactions: snapshot.transactions.map((tx) => ({
            transactionId: tx.id, accountId: tx.accountId, categoryId: tx.categoryId,
          })),
        };
        const resources = [
          { resourceKind: 'budget' as const, resourceId: executor.budgetId },
          ...deriveProposalAuthorizationFacts('create_rule', payload, preconditions).resources,
        ];
        for (const actor of [fixture.actor, executor, approver])
          for (const capability of ['rule:propose', 'rule:approve', 'rule:execute'])
            for (const resource of resources)
              fixture.grant(resource.resourceKind, resource.resourceId, capability, true, actor);
        const proposal = await fixture.store.createProposal({
          spaceId: executor.spaceId, budgetId: executor.budgetId, operation: 'create_rule',
          actorId: fixture.actor.actorId, auth: fixture.actor.auth!,
          policyVersion: GENERIC_MUTATION_POLICY_VERSION, provenance: 'test',
          expiresAt: '2026-10-05T12:00:00.000Z',
          payload, preconditions: JSON.stringify(preconditions),
        });
        const approval = await fixture.store.createApproval({
          proposalId: proposal.id, payloadHash: proposal.payloadHash,
          actorId: approver.actorId, auth: approver.auth!, now: merchantNow,
          expiresAt: proposal.expiresAt,
        });
        let reached!: () => void;
        let release!: () => void;
        const queued = new Promise<void>((resolve) => { reached = resolve; });
        const resume = new Promise<void>((resolve) => { release = resolve; });
        let blocker: Promise<void> | undefined;
        // Private queue access is the deterministic SDK-dispatch test seam.
        const queuedWriter = writer as unknown as {
          withCacheLock<T>(id: string, operation: () => Promise<T>): Promise<T>;
        };
        const withCacheLock = queuedWriter.withCacheLock.bind(writer);
        let contextCalls = 0;
        const resolveContext: ResolveCurrentRuleReviewContext = async (current) => {
          const result = await fixture.service.getCurrentRuleReviewContext(executor, {
            ...current, connected,
          });
          if (++contextCalls === 2)
            blocker = withCacheLock(executor.budgetId, async () => { await resume; });
          return result;
        };
        const revoke = async () => {
          if (change.includes('executor revoked'))
            fixture.grant('budget', executor.budgetId, 'rule:execute', false, executor);
          if (change.includes('normalized-evidence revoked'))
            fixture.grant('evidence', key!, 'normalized-evidence', false, executor);
          if (change.includes('policy disabled'))
            await fixture.service.setPolicy(fixture.actor, { expectedVersion: 1, value: { ...policy, mode: 'disabled' } });
        };
        if (change.startsWith('synced'))
          vi.mocked(fixture.client.sync).mockImplementation(async () => {
            if (vi.mocked(fixture.client.createRule).mock.calls.length > 0) await revoke();
          });
        const complete = fixture.store.completeIdempotencyRecord.bind(fixture.store);
        if (change.startsWith('completed'))
          vi.spyOn(fixture.store, 'completeIdempotencyRecord').mockImplementation(async (...args) => {
            const record = await complete(...args);
            if (record.status === 'succeeded') await revoke();
            return record;
          });
        const appendAudit = fixture.store.appendAuditRecord.bind(fixture.store);
        if (change.startsWith('audited'))
          vi.spyOn(fixture.store, 'appendAuditRecord').mockImplementation(async (audit) => {
            const record = await appendAudit(audit);
            if (record.classification === 'execution_completed') await revoke();
            return record;
          });
        vi.mocked(fixture.client.createRule).mockImplementation(async (record) => {
          const sdkRule = { ...record, id: 'queued-native-rule', tombstone: false } as RuleEntity;
          fixture.setRules([sdkRule]);
          if (change.startsWith('dispatched')) await revoke();
          return { id: sdkRule.id };
        });
        const resolveReplay: ResolveRuleReplayPublicationAuthority = async (current) => {
          expect(current.actorId).toBe(executor.actorId);
          expect(current.auth).toBe(executor.auth);
          expect(current.spaceId).toBe(executor.spaceId);
          expect(current.budgetId).toBe(executor.budgetId);
          return fixture.service.getRuleReplayPublicationAuthority(executor, current.context);
        };
        const service = new RuleMutationService(fixture.store, {
          synchronize: async () => {
            const result = await writer.synchronize();
            if (change.startsWith('reread') && vi.mocked(fixture.client.createRule).mock.calls.length > 0)
              await revoke();
            return result;
          },
          createRule: (write, precondition) => {
            reached();
            return writer.createRule(write, precondition);
          },
        } as BudgetLedger, rust, resolveContext, resolveReplay);
        const execution = service.execute({
          actorId: executor.actorId, auth: executor.auth!, proposalId: proposal.id, approvalId: approval.id,
          idempotencyKey: 'queued-native-execution', requestId: 'queued-native-execution',
        });
        await Promise.race([
          queued, execution.then((result) => { throw new Error(`Stopped before SDK queue: ${JSON.stringify(result)}`); }),
        ]);
        expect((await fixture.store.getApproval(approval.id))?.status).toBe('consumed');
        expect(fixture.client.createRule).not.toHaveBeenCalled();
        if (change.startsWith('queued')) await revoke();
        release();
        await blocker;
        const result = await execution;
        const succeeds = change.startsWith('unchanged');
        expect(result.success).toBe(succeeds);
        expect(result.verified).toBe(succeeds);
        expect(fixture.client.createRule).toHaveBeenCalledTimes(change.startsWith('queued') ? 0 : 1);
        if (!succeeds && !change.startsWith('queued')) {
          expect(result.message).toMatch(/dispatched.*not rolled back/i);
          expect(await fixture.client.getRules()).toHaveLength(1);
          expect(result.ruleId).toBeNull();
          expect(result.simulation).toBeNull();
          expect(result.auditRecordId).toBeNull();
          expect(result.approvalId).toBeNull();
        }
        expect((await fixture.store.getIdempotencyRecord('queued-native-execution'))?.status)
          .toBe(succeeds || change.startsWith('completed') || change.startsWith('audited')
            ? 'succeeded' : 'terminal_failed');
        if (change.startsWith('completed') || change.startsWith('audited')) {
          expect(result.reasonCodes).toContain('publication_withheld');
          expect(await fixture.store.queryAuditRecordsByProposal(proposal.id)).toEqual(expect.arrayContaining([
            expect.objectContaining({
              classification: 'execution_completed', expectedPriorState: proposal.preconditions,
            }),
          ]));
        }
        if (succeeds || change.startsWith('completed') || change.startsWith('audited')) {
          const durable = await fixture.store.getIdempotencyRecord('queued-native-execution');
          const audit = await fixture.store.queryAuditRecordsByProposal(proposal.id);
          const writes = vi.mocked(fixture.client.createRule).mock.calls.length;
          const reads = vi.mocked(fixture.client.getTransactions).mock.calls.length;
          const replay = await new RuleMutationService(fixture.store, null, null, async () => {
            throw new Error('Replay must not recapture SDK source');
          }, resolveReplay).execute({
            actorId: executor.actorId, auth: executor.auth!, proposalId: proposal.id,
            idempotencyKey: 'queued-native-execution', requestId: 'queued-native-replay',
          });
          expect(replay.success).toBe(succeeds);
          expect(replay.verified).toBe(succeeds);
          expect(replay.ruleId).toBe(succeeds ? 'queued-native-rule' : null);
          expect(replay.simulation).toBeNull();
          expect(replay.auditRecordId).toBeNull();
          expect(replay.approvalId).toBeNull();
          if (!succeeds) {
            expect(replay.reasonCodes).toContain('publication_withheld');
            expect(replay.message).toMatch(/dispatched.*not rolled back/i);
          }
          expect(await fixture.store.getIdempotencyRecord('queued-native-execution')).toEqual(durable);
          expect(await fixture.store.queryAuditRecordsByProposal(proposal.id)).toEqual(audit);
          expect(vi.mocked(fixture.client.createRule).mock.calls).toHaveLength(writes);
          expect(vi.mocked(fixture.client.getTransactions).mock.calls).toHaveLength(reads);
          expect(contextCalls).toBe(2);
        }
      }, { expectedBudgetId: fixture.actor.budgetId, synchronize: false });
    } finally {
      await writer.disconnect();
      await fixture.cleanup();
      vi.useRealTimers();
    }
  });
});
