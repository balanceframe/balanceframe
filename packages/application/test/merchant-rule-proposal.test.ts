import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ProtocolSnapshot, Transaction } from '@balanceframe/protocol-generated';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import {
  GENERIC_MUTATION_POLICY_VERSION,
  SqliteWorkflowStore,
  type GovernanceResourceRef,
  type HumanControlContext,
} from '@balanceframe/workflow-store';
import type { BudgetLedger, LedgerSnapshotResult, RuleProposal, RuleCreatePrecondition } from '@balanceframe/actual-adapter';
import {
  createNativeRuleMutationProtocol,
  RuleMutationService,
  type RuleProposalInput,
  type RuleSimulationResult,
  type ResolveCurrentRuleReviewContext,
  type RuleReviewContext,
} from '../src/rule-mutation.js';

const now = '2026-10-04T12:00:00.000Z';
const expiresAt = '2026-10-04T12:30:00.000Z';
const budgetId = 'budget-fixture';
const human = (actorId: string): HumanControlContext => ({
  method: 'human-session', actorId, sessionId: `session:${actorId}`, reauthenticatedAt: now,
});

// This projection feeds the CURRENT public rule API, not a competing merchant
// normalizer. The new merchant source fixture remains the single source of IDs.
function sourceSnapshot(): ProtocolSnapshot {
  const fixture = z.object({ request: z.object({
    transactions: z.array(z.record(z.unknown())),
    payees: z.unknown(), categories: z.unknown(),
  }) }).parse(JSON.parse(readFileSync(
    new URL('../../../protocol/fixtures/merchant-intelligence.json', import.meta.url), 'utf8',
  )) as unknown);
  const representative = canonicalProtocolSnapshotSchema.parse(JSON.parse(readFileSync(
    new URL('../../../protocol/fixtures/representative.json', import.meta.url), 'utf8',
  )) as unknown) as ProtocolSnapshot;
  return canonicalProtocolSnapshotSchema.parse({
    schemaVersion: '1', actualVersion: '26.10.0', snapshotDate: now,
    accounts: [{ ...representative.accounts[0], id: 'account-checking' }],
    payees: fixture.request.payees, categories: fixture.request.categories,
    rules: [], schedules: [], budgets: [], tags: [],
    transactions: fixture.request.transactions.map((transaction) => ({
      ...transaction,
      importedPayee: z.object({ value: z.string().nullable() }).parse(transaction.importedPayee).value,
      notes: z.object({ value: z.string().nullable() }).parse(transaction.notes).value,
      categoryName: null, tags: [], subtransactions: [],
    })),
  }) as ProtocolSnapshot;
}

type ReviewedRuleInput = RuleProposalInput;

// Independent server current-state fixture, not a replay of stored proposal context.
function currentContext(spaceId: string): RuleReviewContext {
  return {
    scope: { spaceId, budgetId, connectionId: 'connection-fixture' },
    sourceFactsHash: 'facts-1', evidenceKey: null, evidenceRevision: 'evidence-1',
    merchantPolicyVersion: 'merchant-policy-1', visibilityHash: 'visibility-1', expiresAt,
  };
}

function resolverFor(spaceId: string): ResolveCurrentRuleReviewContext {
  return async (request) => {
    expect(request.spaceId).toBe(spaceId);
    expect(request.budgetId).toBe(budgetId);
    expect(request.actorId).toBe('executor');
    return currentContext(spaceId);
  };
}

function terms(spaceId = 'space-fixture'): ReviewedRuleInput {
  return {
    name: 'Corner Market category', budgetId, stage: 'post', conditionsOp: 'and',
    conditions: [{ field: 'payee', op: 'is', value: 'payee-market' }],
    actions: [{ op: 'set', field: 'category', value: 'category-food' }],
    reviewContext: {
      scope: { spaceId, budgetId, connectionId: 'connection-fixture' },
      sourceFactsHash: 'facts-1', evidenceKey: null, evidenceRevision: 'evidence-1',
      merchantPolicyVersion: 'merchant-policy-1', visibilityHash: 'visibility-1', expiresAt,
    },
  };
}

let store: SqliteWorkflowStore;

async function governedFixture() {
  store = new SqliteWorkflowStore(':memory:');
  await store.claimBootstrap({ name: 'Owner', email: 'owner@example.test', claimId: 'merchant-rule' });
  await store.finalizeBootstrap({ claimId: 'merchant-rule', ownerUserId: 'owner' });
  const governance = store.governance;
  const created = governance.createSpace({
    actorId: 'owner', name: 'Merchant rules', kind: 'shared', now, auth: human('owner'),
  });
  const space = governance.bindBudget({ spaceId: created.id, budgetId, now, auth: human('owner') });
  const memberships: Record<string, string> = {};
  const resources: GovernanceResourceRef[] = [
    { resourceKind: 'budget', resourceId: budgetId },
    { resourceKind: 'account', resourceId: 'account-checking' },
    { resourceKind: 'transaction', resourceId: 'tx-source' },
    { resourceKind: 'evidence', resourceId: 'merchant-evidence:tx-source' },
    ...['category-food', 'category-bills', 'category-other'].map((resourceId) => ({
      resourceKind: 'category' as const, resourceId,
    })),
  ];
  const source = sourceSnapshot();
  const sourceRights = [
    ...['observe', 'source', 'rule:view'].map((capability) => ({ resourceKind: 'budget' as const, resourceId: budgetId, capability })),
    ...source.accounts.flatMap((account) => ['existence', 'history', 'name', 'source'].map((capability) => ({ resourceKind: 'account' as const, resourceId: account.id, capability }))),
    ...source.categories.flatMap((category) => ['existence', 'name'].map((capability) => ({ resourceKind: 'category' as const, resourceId: category.id, capability }))),
    ...source.transactions.flatMap((transaction) => ['transaction.view', 'source'].map((capability) => ({ resourceKind: 'transaction' as const, resourceId: transaction.id, capability }))),
  ];
  for (const [actorId, capability] of [
    ['proposer', 'rule:propose'], ['approver', 'rule:approve'], ['executor', 'rule:execute'],
  ] as const) {
    await store.upsertActorMembership(actorId, 'active', [], 'merchant-rule');
    memberships[actorId] = governance.addMembership({
      spaceId: space.id, actorId, validFrom: now, now, auth: human('owner'),
    }).id;
    for (const resource of resources) governance.setResourceGrant({
      spaceId: space.id, budgetId, actorId, membershipId: memberships[actorId],
      capability, ...resource, granted: true, now, auth: human('owner'),
    });
    for (const right of sourceRights) governance.setResourceGrant({
      spaceId: space.id, budgetId, actorId, membershipId: memberships[actorId],
      ...right, granted: true, now, auth: human('owner'),
    });
  }
  return { space, memberships };
}

async function reviewedProposal(
  snapshot: ProtocolSnapshot,
  spaceId: string,
  changeReviewedSimulation?: (simulation: RuleSimulationResult) => void,
  evidenceKey: string | null = null,
  evidenceExpiresAt = expiresAt,
) {
  const rust = await createNativeRuleMutationProtocol();
  const input = terms(spaceId);
  input.reviewContext.evidenceKey = evidenceKey;
  input.reviewContext.expiresAt = evidenceExpiresAt;
  const nativePlan = rust.planCreateRule(input, snapshot);
  const reviewedSimulation = rust.simulateCreateRulePlan(nativePlan, snapshot);
  changeReviewedSimulation?.(reviewedSimulation);
  const nativeRule: RuleProposal = {
    stage: 'post', conditionsOp: 'and',
    conditions: input.conditions, actions: input.actions,
  };
  const proposal = await store.createProposal({
    spaceId, budgetId, operation: 'create_rule', actorId: 'proposer', auth: human('proposer'),
    provenance: 'manual', policyVersion: GENERIC_MUTATION_POLICY_VERSION, expiresAt,
    payload: {
      kind: 'create_rule', transactionId: null, categoryId: 'category-food', rule: nativeRule,
      composite: {
        operations: [], reallocations: [], transferRecommendations: [], ledgerProjections: [],
        evidenceReferences: [], nativePayloadHash: nativePlan.hash,
      },
    },
    preconditions: JSON.stringify({
      actualVersion: snapshot.actualVersion, nativePlan, nativeRule, reviewedSimulation,
      ruleName: input.name,
      reviewContext: input.reviewContext,
      sourceAccounts: snapshot.accounts,
      sourceTransactions: snapshot.transactions,
      nativeImpact: { payees: snapshot.payees, categories: snapshot.categories, rules: snapshot.rules },
    }),
  });
  const approval = await store.createApproval({
    proposalId: proposal.id, payloadHash: proposal.payloadHash, actorId: 'approver',
    auth: human('approver'), expiresAt, now,
  });
  return { rust, proposal, approval, reviewedSimulation, nativeRule };
}

// Actual I/O is the test double; the planner, simulation, verifier, SQLite
// proposal envelope and governed approval acquisition are real production code.
function ledgerFor(snapshot: ProtocolSnapshot) {
  let current = structuredClone(snapshot);
  const synchronize = vi.fn(async () => ({
    snapshot: current,
    rulePlanningSourceAvailability: {
      accounts: 'complete', payees: 'complete', categories: 'complete', categoryGroups: 'complete', rules: 'complete',
      history: current.accounts.map((account) => ({
        accountId: account.id, state: 'complete', startDate: '0001-01-01', endDate: '9999-12-31',
      })),
    },
  }) as LedgerSnapshotResult);
  const createRule = vi.fn(async (proposal: RuleProposal, precondition: RuleCreatePrecondition) => {
    precondition.assertExecutionCurrent();
    current = { ...current, rules: [{
      id: 'created-native-rule', name: 'created-native-rule', order: 1, inactive: false,
      trigger: {
        stage: proposal.stage, conditionsOp: proposal.conditionsOp, conditions: proposal.conditions,
      },
      actions: proposal.actions,
    }] };
    return { success: true as const, id: 'created-native-rule', observedState: {} };
  });
  const ledger = { synchronize, createRule } as unknown as BudgetLedger;
  return { ledger, synchronize, createRule };
}

function execution(proposalId: string, approvalId: string, idempotencyKey = 'merchant-rule-execute') {
  return {
    proposalId, approvalId, idempotencyKey, requestId: idempotencyKey,
    actorId: 'executor', auth: human('executor'),
  };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(now)); });
afterEach(() => { store?.close(); vi.useRealTimers(); });

describe('stable-ID merchant rules through native planning and governed approvals', () => {
  it('writes an exact standalone Actual ID payload and verifies it after unchanged recapture', async () => {
    const { space } = await governedFixture();
    const original = sourceSnapshot();
    const reviewed = await reviewedProposal(original, space.id);
    expect(reviewed.reviewedSimulation.transactionsAffected).toEqual(['tx-source']);
    const recaptured = { ...original, snapshotDate: '2026-10-04T12:01:00.000Z' };
    const io = ledgerFor(recaptured);
    const result = await new RuleMutationService(store, io.ledger, reviewed.rust, resolverFor(space.id)).execute(
      execution(reviewed.proposal.id, reviewed.approval.id),
    );
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.verified).toBe(true);
    expect(io.createRule).toHaveBeenCalledExactlyOnceWith({
      stage: 'post', conditionsOp: 'and',
      conditions: [{ field: 'payee', op: 'is', value: 'payee-market' }],
      actions: [{ op: 'set', field: 'category', value: 'category-food' }],
    }, { assertExecutionCurrent: expect.any(Function) });
  });

  it('does not collide duplicate payee names and simulates recursive child category differences', async () => {
    const rust = await createNativeRuleMutationProtocol();
    const source = sourceSnapshot();
    source.payees[1].name = source.payees[0].name;
    const leaf: Transaction = { ...source.transactions[0], id: 'tx-leaf',
      payeeName: 'Edited display text', amount: { minorUnits: '-9223372036854775808', currency: 'JPY' } };
    const unchanged: Transaction = { ...leaf, id: 'tx-unchanged', categoryId: 'category-food',
      categoryName: 'Food', amount: { minorUnits: '9223372036854775807', currency: 'KWD' } };
    source.transactions = [
      { ...leaf, id: 'tx-parent', subtransactions: [{ ...leaf, id: 'tx-inner', subtransactions: [leaf, unchanged] }] },
      { ...leaf, id: 'tx-other', payeeId: 'payee-other', payeeName: 'Corner Market' },
    ];
    const planned = rust.planCreateRule(terms(), source);
    const simulation = rust.simulateCreateRulePlan(planned, source);
    expect(simulation.transactionsAffected).toEqual(['tx-leaf', 'tx-unchanged']);
    expect(simulation.transactionsMatched).toBe(2);
    expect(simulation.examples).toEqual(expect.arrayContaining([
      expect.objectContaining({ txId: 'tx-leaf', amount: leaf.amount, wouldChange: true }),
      expect.objectContaining({ txId: 'tx-unchanged', amount: unchanged.amount, wouldChange: false }),
    ]));
  });

  it.each([
    ['transaction amount', (source: ProtocolSnapshot) => { source.transactions[0].amount.minorUnits = '-101'; }],
    ['transaction category', (source: ProtocolSnapshot) => { source.transactions[0].categoryId = 'category-bills'; }],
    ['transaction identity', (source: ProtocolSnapshot) => { source.transactions[0].payeeId = 'payee-other'; }],
    ['payee rename', (source: ProtocolSnapshot) => { source.payees[0].name = 'Renamed'; }],
    ['payee deletion/merge', (source: ProtocolSnapshot) => { source.payees = source.payees.slice(1); }],
    ['category deletion', (source: ProtocolSnapshot) => { source.categories[0].deleted = true; }],
    ['category rename', (source: ProtocolSnapshot) => { source.categories[0].name = 'Renamed category'; }],
    ['affected population', (source: ProtocolSnapshot) => { source.transactions.push({ ...source.transactions[0], id: 'tx-new-impact' }); }],
    ['rule content', (source: ProtocolSnapshot) => { source.rules[0].inactive = false; }],
    ['rule ordering', (source: ProtocolSnapshot) => { source.rules[0].order += 1; }],
  ] as const)('requires a new reviewed proposal and approval after %s changes', async (_name, change) => {
    const { space } = await governedFixture();
    const original = sourceSnapshot();
    original.rules = [{ id: 'rule-existing', name: 'Existing unrelated rule', order: 1, inactive: true,
      trigger: { stage: 'post', conditionsOp: 'and', conditions: [{ field: 'payee', op: 'is', value: 'payee-other' }] },
      actions: [{ op: 'set', field: 'category', value: 'category-bills' }],
    }];
    const reviewed = await reviewedProposal(original, space.id);
    const changed = structuredClone(original);
    change(changed);
    const io = ledgerFor(changed);
    const service = new RuleMutationService(store, io.ledger, reviewed.rust, resolverFor(space.id));
    const result = await service.execute(execution(reviewed.proposal.id, reviewed.approval.id));
    expect(result.success).toBe(false);
    expect(io.createRule).not.toHaveBeenCalled();
    expect(result.reasonCodes.some((code) => ['plan_mismatch', 'precondition_mismatch', 'plan_failed'].includes(code))).toBe(true);
    const retry = await service.execute(execution(reviewed.proposal.id, reviewed.approval.id, 'retry-old-approval'));
    expect(retry.success).toBe(false);
    expect(io.createRule).not.toHaveBeenCalled();
    expect(await store.getProposalApprovalSummary({
      proposalId: reviewed.proposal.id, spaceId: space.id, actorId: 'executor', auth: human('executor'), now,
    })).toMatchObject({ canExecute: false });
  });

  it.each(['evidenceRevision', 'merchantPolicyVersion', 'sourceFactsHash', 'visibilityHash'] as const)(
    'binds reviewed %s into the native intent hash', async (field) => {
      const rust = await createNativeRuleMutationProtocol();
      const source = sourceSnapshot();
      const original = terms();
      const changed = structuredClone(original);
      changed.reviewContext[field] += '-changed';
      expect(rust.planCreateRule(changed, source).hash).not.toBe(rust.planCreateRule(original, source).hash);
    },
  );

  it('invalidates an existing approval when the governed policy changes', async () => {
    const { space } = await governedFixture();
    const source = sourceSnapshot();
    const reviewed = await reviewedProposal(source, space.id);
    const policy = store.governance.getPolicy({ spaceId: space.id });
    if (!policy) throw new Error('Missing fixture governance policy');
    store.governance.setPolicy({ spaceId: space.id, expectedVersion: policy.version,
      policy: { minimumApprovers: 2, approvalThresholds: [], operationApprovers: { create_rule: 2 } },
      now, auth: human('owner'),
    });
    const io = ledgerFor(source);
    const result = await new RuleMutationService(store, io.ledger, reviewed.rust, resolverFor(space.id)).execute(
      execution(reviewed.proposal.id, reviewed.approval.id),
    );
    expect(result.success).toBe(false);
    expect(io.createRule).not.toHaveBeenCalled();
  });

  it('refuses a global future rule for a scoped actor without reading or disclosing hidden impact', async () => {
    const { space, memberships } = await governedFixture();
    const source = sourceSnapshot();
    const reviewed = await reviewedProposal(source, space.id);
    store.governance.setResourceGrant({
      spaceId: space.id, budgetId, actorId: 'executor', membershipId: memberships.executor,
      capability: 'rule:execute', resourceKind: 'budget', resourceId: budgetId,
      granted: true, restrictions: { accountIds: ['account-checking'] }, now, auth: human('owner'),
    });
    const hiddenSource = structuredClone(source);
    hiddenSource.transactions.push({ ...hiddenSource.transactions[0],
      id: 'HIDDEN-TRANSACTION-SENTINEL', accountId: 'HIDDEN-ACCOUNT-SENTINEL',
      payeeName: 'HIDDEN-MERCHANT-SENTINEL',
    });
    const io = ledgerFor(hiddenSource);
    const result = await new RuleMutationService(store, io.ledger, reviewed.rust, resolverFor(space.id)).execute(
      execution(reviewed.proposal.id, reviewed.approval.id),
    );
    expect(result.success).toBe(false);
    expect(result.simulation).toBeNull();
    expect(io.synchronize).not.toHaveBeenCalled();
    expect(io.createRule).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('HIDDEN-');
    expect(JSON.stringify(result)).not.toMatch(/transactionsMatched|transactionsAffected|categoryDistribution/);
  });
  it.each([
    ['affected IDs', (simulation: RuleSimulationResult) => { simulation.transactionsAffected = ['tx-wrong-review']; }],
    ['matched count', (simulation: RuleSimulationResult) => { simulation.transactionsMatched += 1; }],
    ['category diff', (simulation: RuleSimulationResult) => { simulation.examples[0].wouldChange = false; }],
    ['contradictions', (simulation: RuleSimulationResult) => { simulation.conflicts = ['reviewed contradiction']; }],
  ] as const)('rejects changed reviewed simulation %s even when the native payload is identical', async (_name, change) => {
    const { space } = await governedFixture();
    const source = sourceSnapshot();
    const reviewed = await reviewedProposal(source, space.id, change);
    const io = ledgerFor(source);
    const result = await new RuleMutationService(store, io.ledger, reviewed.rust, resolverFor(space.id)).execute(
      execution(reviewed.proposal.id, reviewed.approval.id),
    );
    expect(result.success).toBe(false);
    expect(io.createRule).not.toHaveBeenCalled();
  });

  it.each(['missing-payee', 'missing-category', 'deleted-category', 'display-name'] as const)(
    'rejects an invalid rule target before a native proposal can be approved: %s', async (invalid) => {
      const rust = await createNativeRuleMutationProtocol();
      const source = sourceSnapshot();
      const input = terms();
      if (invalid === 'missing-payee') source.payees = source.payees.slice(1);
      if (invalid === 'missing-category') source.categories = source.categories.slice(1);
      if (invalid === 'deleted-category') source.categories[0].deleted = true;
      if (invalid === 'display-name')
        input.conditions = [{ field: 'payee', op: 'is', value: 'Corner Market' }];
      expect(() => rust.planCreateRule(input, source)).toThrow();
    },
  );

  it.each(['evidenceRevision', 'merchantPolicyVersion', 'sourceFactsHash', 'visibilityHash'] as const)(
    'resolves trusted CURRENT %s before any write instead of replaying reviewed metadata', async (field) => {
      const { space } = await governedFixture();
      const source = sourceSnapshot();
      const reviewed = await reviewedProposal(source, space.id);
      const io = ledgerFor(source);
      const resolve = vi.fn<ResolveCurrentRuleReviewContext>(async () => {
        const current = currentContext(space.id);
        current[field] += '-current';
        return current;
      });
      const result = await new RuleMutationService(store, io.ledger, reviewed.rust, resolve).execute(
        execution(reviewed.proposal.id, reviewed.approval.id),
      );
      expect(resolve).toHaveBeenCalledOnce();
      expect(resolve.mock.calls[0][0]).not.toHaveProperty('reviewContext');
      expect(result.success).toBe(false);
      expect(io.createRule).not.toHaveBeenCalled();
    },
  );

  it('rechecks current authority immediately before writing and consumes stale approval', async () => {
    const { space } = await governedFixture();
    const source = sourceSnapshot();
    const reviewed = await reviewedProposal(source, space.id);
    const io = ledgerFor(source);
    const resolve = vi.fn<ResolveCurrentRuleReviewContext>()
      .mockResolvedValueOnce(currentContext(space.id))
      .mockRejectedValueOnce(new Error('Current authority revoked'));
    const service = new RuleMutationService(store, io.ledger, reviewed.rust, resolve);
    expect((await service.execute(execution(reviewed.proposal.id, reviewed.approval.id))).success).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(io.createRule).not.toHaveBeenCalled();
    expect((await service.execute(execution(reviewed.proposal.id, reviewed.approval.id, 'retry-revoked'))).success).toBe(false);
    expect(io.createRule).not.toHaveBeenCalled();
  });

  it.each(['reviewed', 'current'] as const)('rejects expired %s evidence while the governed proposal remains live', async (expired) => {
    const { space } = await governedFixture();
    const source = sourceSnapshot();
    const reviewed = await reviewedProposal(source, space.id, undefined, null, expired === 'reviewed' ? now : expiresAt);
    const io = ledgerFor(source);
    const resolve: ResolveCurrentRuleReviewContext = async () => ({
      ...currentContext(space.id), expiresAt: expired === 'current' ? now : expiresAt,
    });
    const result = await new RuleMutationService(store, io.ledger, reviewed.rust, resolve).execute(
      execution(reviewed.proposal.id, reviewed.approval.id),
    );
    expect(result.success).toBe(false);
    expect(io.createRule).not.toHaveBeenCalled();
  });

  it('fails closed when a scoped evidence resolver omits its live same-capture publication fence', async () => {
    const { space } = await governedFixture();
    const source = sourceSnapshot();
    const evidenceKey = 'merchant-evidence:tx-source';
    const reviewed = await reviewedProposal(source, space.id, undefined, evidenceKey);
    const io = ledgerFor(source);
    const resolve = vi.fn<ResolveCurrentRuleReviewContext>(async (request) => {
      expect(request.evidenceKey).toBe(evidenceKey);
      return { ...currentContext(space.id), evidenceKey };
    });
    const result = await new RuleMutationService(store, io.ledger, reviewed.rust, resolve).execute(
      execution(reviewed.proposal.id, reviewed.approval.id),
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain('Current merchant publication authority is unavailable');
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(io.createRule).not.toHaveBeenCalled();
  });

  it('rejects policy or evidence drift at the final current-context check', async () => {
    const { space } = await governedFixture();
    const source = sourceSnapshot();
    const reviewed = await reviewedProposal(source, space.id);
    const io = ledgerFor(source);
    const resolve = vi.fn<ResolveCurrentRuleReviewContext>()
      .mockResolvedValueOnce(currentContext(space.id))
      .mockResolvedValueOnce({ ...currentContext(space.id), evidenceRevision: 'evidence-raced' });
    const result = await new RuleMutationService(store, io.ledger, reviewed.rust, resolve).execute(
      execution(reviewed.proposal.id, reviewed.approval.id),
    );
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(io.createRule).not.toHaveBeenCalled();
  });

});
