import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from 'better-sqlite3';
import { SqliteWorkflowStore, GENERIC_MUTATION_POLICY_VERSION } from '@balanceframe/workflow-store';
import type { ActionProposal, HumanControlContext } from '@balanceframe/workflow-store';
import type { FinancialSnapshot } from '@balanceframe/protocol-generated';
import foundation from '../../../protocol/fixtures/financial-decision-foundation.json';
import representative from '../../../protocol/fixtures/representative.json';
import { ConnectionManager, type ConnectionConfig } from '../src/connection-manager.js';
import {
  CategorizationPreviewService,
  CategorizationPreviewError,
} from '../src/categorization-preview.js';
import type { MutationPlan, RustMutationProtocol } from '../src/mutation.js';

const now = '2098-01-01T12:00:00.000Z';
const budgetId = 'preview-budget';
const auth = (actorId: string): HumanControlContext => ({
  method: 'human-session',
  actorId,
  sessionId: `session:${actorId}`,
  reauthenticatedAt: now,
});

describe('synchronized categorization preview', () => {
  let store: SqliteWorkflowStore;
  let spaceId: string;
  let proposal: Extract<ActionProposal, { operation: 'set_category' }>;
  let source: FinancialSnapshot;
  let plan: MutationPlan;
  let config: ConnectionConfig;
  let manager: ConnectionManager;
  let service: CategorizationPreviewService;
  let synchronize: ReturnType<typeof vi.fn>;
  let connect: ReturnType<typeof vi.fn>;
  let factory: ReturnType<typeof vi.fn>;
  let native: RustMutationProtocol;
  const actorId = 'executor';
  const input = () => ({
    actorId,
    proposalId: proposal.id,
    budgetId,
    spaceId,
    auth: auth(actorId),
    requestId: 'preview-request',
  });
  const membership = (actor: string) =>
    store.governance.getCurrentMembership({ actorId: actor, spaceId, now })!;
  function grant(
    actor: string,
    capability: string,
    resourceKind: 'budget' | 'account' | 'category' | 'transaction',
    resourceId: string,
    granted = true,
    restrictions?: unknown,
  ) {
    store.governance.setResourceGrant({
      actorId: actor,
      membershipId: membership(actor).id,
      spaceId,
      budgetId,
      capability,
      resourceKind,
      resourceId,
      granted,
      restrictions,
      now,
      auth: auth('owner'),
    });
  }
  async function approve(actor: string) {
    return store.createApproval({
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      actorId: actor,
      expiresAt: proposal.expiresAt,
      auth: auth(actor),
      now,
    });
  }
  function logicalState() {
    // Inspect durable authority tables so a mock cannot hide a consumed approval or claim.
    const db = (store as unknown as { db: Database }).db;
    return Object.fromEntries(
      [
        'proposal_approvals',
        'idempotency_records',
        'proposal_execution_acquisitions',
        'categorization_dispatch_admissions',
      ].map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]),
    );
  }
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    store = new SqliteWorkflowStore(':memory:');
    await store.claimBootstrap({ name: 'Owner', email: 'owner@example.com', claimId: 'preview' });
    await store.finalizeBootstrap({ claimId: 'preview', ownerUserId: 'owner' });
    for (const actor of ['owner', 'proposer', actorId, 'approver-a', 'approver-b'])
      await store.upsertActorMembership(actor, 'active', [], 'unscoped');
    spaceId = store.governance.createSpace({
      actorId: 'owner',
      name: 'Preview fixture',
      kind: 'shared',
      auth: auth('owner'),
      now,
    }).id;
    store.governance.bindBudget({ spaceId, budgetId, now, auth: auth('owner') });
    for (const actor of ['proposer', actorId, 'approver-a', 'approver-b'])
      store.governance.addMembership({
        spaceId,
        actorId: actor,
        validFrom: now,
        now,
        auth: auth('owner'),
      });
    store.governance.setPolicy({
      spaceId,
      expectedVersion: store.governance.getPolicy({ spaceId })!.version,
      policy: { minimumApprovers: 2, approvalThresholds: [] },
      now,
      auth: auth('owner'),
    });
    source = structuredClone(foundation.full) as FinancialSnapshot;
    source.source = { ...source.source, budgetId, ledgerId: budgetId, spaceId };
    source.capturedAt = now;
    source.legacySnapshot.snapshotDate = now;
    source.legacySnapshot.categories = [
      { ...representative.categories[0]!, id: 'fd-category-groceries' },
      { ...representative.categories[1]!, id: 'new-category' },
    ];
    source.coverage.categories = 'complete';
    const tx = source.legacySnapshot.transactions[0]!;
    plan = {
      planId: 'preview-plan',
      transactionId: tx.id,
      currentCategoryId: tx.categoryId,
      proposedCategoryId: 'new-category',
      hash: 'native-plan-hash',
      postconditions: [{ type: 'CategoryExists', categoryId: 'new-category' }],
    };
    for (const [actor, capability] of [
      ['proposer', 'categorization:propose'],
      [actorId, 'categorization:execute'],
      ['approver-a', 'categorization:approve'],
      ['approver-b', 'categorization:approve'],
    ]) {
      for (const [kind, id] of [
        ['budget', budgetId],
        ['transaction', tx.id],
        ['account', tx.accountId],
        ['category', tx.categoryId!],
        ['category', 'new-category'],
      ] as const)
        grant(actor!, capability!, kind, id);
    }
    grant(actorId, 'full-read', 'budget', budgetId);
    const created = await store.createProposal({
      operation: 'set_category',
      budgetId,
      spaceId,
      actorId: 'proposer',
      auth: auth('proposer'),
      provenance: 'manual',
      policyVersion: GENERIC_MUTATION_POLICY_VERSION,
      expiresAt: '2098-01-02T00:00:00.000Z',
      payload: {
        kind: 'set_category',
        transactionId: tx.id,
        categoryId: 'new-category',
        composite: {
          operations: [],
          reallocations: [],
          transferRecommendations: [],
          ledgerProjections: [],
          evidenceReferences: [],
          nativePayloadHash: plan.hash,
        },
      },
      preconditions: JSON.stringify({
        transactionId: tx.id,
        accountId: tx.accountId,
        currentCategoryId: tx.categoryId,
        transaction: {
          id: tx.id,
          accountId: tx.accountId,
          categoryId: tx.categoryId,
          direction: 'outgoing',
          amount: { ...tx.amount, minorUnits: '1250' },
        },
        actualVersion: source.legacySnapshot.actualVersion,
        snapshotSchemaVersion: source.legacySnapshot.schemaVersion,
        nativePlan: plan,
      }),
    });
    if (created.operation !== 'set_category') throw new Error('Fixture proposal operation');
    proposal = created;
    config = {
      version: 1,
      budgetId,
      budgetName: 'Fixture',
      groupId: 'preview-group',
      serverUrl: 'http://fixture.invalid',
    };
    synchronize = vi.fn(async () => ({
      financialSnapshot: structuredClone(source),
      snapshot: structuredClone(source.legacySnapshot),
    }));
    connect = vi.fn(async () => [
      { id: budgetId, groupId: config.groupId, name: config.budgetName, encrypted: false },
    ]);
    factory = vi.fn(async () => ({
      connect,
      selectBudget: vi.fn(async () => ({
        id: budgetId,
        groupId: config.groupId,
        name: config.budgetName,
        encrypted: false,
      })),
      synchronize,
      disconnect: vi.fn(async () => {}),
    }));
    manager = new ConnectionManager({
      configPath: '/unused/preview-config',
      readFile: async () => JSON.stringify(config),
      credentialStore: {
        load: async () => ({ serverUrl: config.serverUrl, secretKey: 'disposable' }),
        store: async () => {},
      },
      connectorFactory: factory,
    });
    native = {
      planSetCategory: vi.fn(() => structuredClone(plan)),
      verifyMutation: vi.fn(() => {
        throw new Error('Preview must never verify a write');
      }),
    };
    service = new CategorizationPreviewService({
      store,
      connectionManager: manager,
      protocol: native,
      clock: () => new Date(now),
    });
  });
  afterEach(async () => {
    await manager?.disconnect();
    store.close();
    vi.useRealTimers();
  });

  it('reports pending independent human quorum with no claims or consumed approvals', async () => {
    await approve('approver-a');
    const before = logicalState();
    const result = await service.preview(input());
    expect(result).toMatchObject({
      simulationOnly: true,
      status: 'approval_required',
      requiredApprovers: 2,
      reasonCodes: ['approval_required'],
      plan: { transactionId: plan.transactionId, proposedCategoryId: 'new-category' },
      source: {
        kind: 'locally_observed',
        atomic: false,
        serverConfirmed: false,
        maySynchronize: true,
        startedAt: now,
        completedAt: now,
      },
    });
    expect(logicalState()).toEqual(before);
    expect(synchronize.mock.calls).toEqual([[], [{ refresh: false }]]);
    expect(native.verifyMutation).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(
      /contextHash|approvalIds|native-plan-hash|fd-account-checking|minorUnits/,
    );
  });
  it('reports eligibility on captured inputs after two independent humans approve', async () => {
    await approve('approver-a');
    await approve('approver-b');
    const before = logicalState();
    expect(await service.preview(input())).toMatchObject({
      status: 'eligible_on_captured_inputs',
      reasonCodes: [],
      requiredApprovers: 2,
    });
    expect(logicalState()).toEqual(before);
  });
  it('denies agents before connection/config I/O, without impersonating a human', async () => {
    const load = vi.spyOn(manager, 'loadConfig');
    await expect(
      service.preview({
        ...input(),
        auth: {
          method: 'api-key',
          actorId,
          principalType: 'agent',
          credentialId: 'agent-key',
          credentialOwnerId: 'owner',
          delegationId: 'delegation',
          delegationVersion: '1',
        },
      }),
    ).rejects.toMatchObject({ statusCode: 403, reasonCode: 'authorization_denied' });
    expect(load).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });
  it('denies exact private disclosure when broad snapshot read is not authorized', async () => {
    grant(actorId, 'full-read', 'budget', budgetId, false);
    const tx = source.legacySnapshot.transactions[0]!;
    for (const [kind, id] of [
      ['transaction', tx.id],
      ['account', tx.accountId],
      ['category', tx.categoryId!],
      ['category', 'new-category'],
    ] as const)
      grant(actorId, 'full-read', kind, id);
    await expect(service.preview(input())).rejects.toMatchObject({ statusCode: 403 });
    expect(factory).not.toHaveBeenCalled();
  });
  it.each([
    { accountIds: ['fd-account-checking'] },
    { maxOperationCount: 1 },
    { maxGrossOutgoing: [{ currency: 'USD', minorUnits: '2000' }] },
  ])('denies a restricted broad snapshot grant before source I/O: %j', async (restrictions) => {
    grant(actorId, 'full-read', 'budget', budgetId, true, restrictions);
    await expect(service.preview(input())).rejects.toMatchObject({ statusCode: 403 });
    expect(factory).not.toHaveBeenCalled();
  });
  it('denies missing private authority before source I/O', async () => {
    grant(actorId, 'full-read', 'budget', budgetId, false);
    await expect(service.preview(input())).rejects.toBeInstanceOf(CategorizationPreviewError);
    expect(factory).not.toHaveBeenCalled();
  });
  it('keeps missing and wrong-space proposals unavailable', async () => {
    await expect(service.preview({ ...input(), proposalId: 'missing' })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(service.preview({ ...input(), spaceId: 'other-space' })).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(factory).not.toHaveBeenCalled();
  });
  it('rejects actor substitution and expired/revoked credentials before I/O', async () => {
    await expect(service.preview({ ...input(), actorId: 'approver-a' })).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(
      service.preview({ ...input(), auth: { ...auth(actorId), isCredentialValid: () => false } }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(factory).not.toHaveBeenCalled();
  });
  it('denies execution scope even while human approvals are pending', async () => {
    grant(actorId, 'categorization:execute', 'budget', budgetId, false);
    await expect(service.preview(input())).rejects.toMatchObject({ statusCode: 403 });
    expect(factory).not.toHaveBeenCalled();
  });
  it('rejects a selected-budget mismatch before lifecycle I/O', async () => {
    config = { ...config, budgetId: 'other-budget' };
    await expect(service.preview(input())).rejects.toMatchObject({
      reasonCode: 'selected_budget_mismatch',
    });
    expect(factory).not.toHaveBeenCalled();
  });
  it.each(['revocation', 'policy', 'budget'] as const)(
    'withholds output after asynchronous %s changes',
    async (change) => {
      synchronize.mockImplementationOnce(async () => {
        if (change === 'revocation')
          store.governance.revokeMembership({
            spaceId,
            membershipId: membership(actorId).id,
            now,
            auth: auth('owner'),
          });
        if (change === 'policy')
          store.governance.setPolicy({
            spaceId,
            expectedVersion: store.governance.getPolicy({ spaceId })!.version,
            policy: { minimumApprovers: 3, approvalThresholds: [] },
            now,
            auth: auth('owner'),
          });
        if (change === 'budget') config = { ...config, budgetId: 'other-budget' };
        return { financialSnapshot: structuredClone(source) };
      });
      await expect(service.preview(input())).rejects.toBeInstanceOf(CategorizationPreviewError);
    },
  );
  it('withholds a plan if independent approval context changes during acquisition', async () => {
    await approve('approver-a');
    synchronize.mockImplementationOnce(async () => {
      await approve('approver-b');
      return { financialSnapshot: structuredClone(source) };
    });
    expect(await service.preview(input())).toMatchObject({
      status: 'blocked',
      reasonCodes: ['preview_context_changed'],
      plan: null,
    });
  });
  it('rechecks private authority after native planning and before publication', async () => {
    vi.mocked(native.planSetCategory).mockImplementationOnce(() => {
      grant(actorId, 'full-read', 'budget', budgetId, false);
      return structuredClone(plan);
    });
    await expect(service.preview(input())).rejects.toMatchObject({ statusCode: 403 });
  });
  it('rechecks current policy before publishing a failed source report', async () => {
    synchronize.mockImplementationOnce(async () => {
      store.governance.setPolicy({
        spaceId,
        expectedVersion: store.governance.getPolicy({ spaceId })!.version,
        policy: { minimumApprovers: 3, approvalThresholds: [] },
        now,
        auth: auth('owner'),
      });
      throw new Error('Source failure');
    });
    await expect(service.preview(input())).rejects.toMatchObject({ statusCode: 403 });
  });
  it('blocks an already acquired uncertain proposal without source I/O', async () => {
    await approve('approver-a');
    await approve('approver-b');
    await store.acquireProposalExecution({
      actorId,
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      governancePolicyVersion: proposal.governancePolicyVersion!,
      idempotencyKey: 'actual-execute',
      serialisedEffect: JSON.stringify({
        operation: proposal.operation,
        payload: proposal.payload,
        preconditions: JSON.parse(proposal.preconditions) as unknown,
      }),
      auth: auth(actorId),
      now,
      requestId: 'execute',
    });
    const before = logicalState();
    expect(await service.preview(input())).toMatchObject({
      status: 'blocked',
      requiredApprovers: null,
      reasonCodes: ['idempotency_in_progress'],
      plan: null,
    });
    expect(logicalState()).toEqual(before);
    expect(factory).not.toHaveBeenCalled();
  });
  it.each(['accounts', 'transactions', 'categories'] as const)(
    'fails closed on incomplete %s coverage',
    async (collection) => {
      source.coverage[collection] = 'partial';
      expect(await service.preview(input())).toMatchObject({
        status: 'blocked',
        reasonCodes: ['source_incomplete'],
        plan: null,
      });
    },
  );
  it('admits partial account facts with one complete account collection receipt, preserving unknown type facts', async () => {
    source.coverage.accounts = 'partial';
    source.observations.push({
      kind: 'account_collection_coverage',
      scope: { kind: 'global' },
      state: 'complete',
      observedAt: now,
      evidence: [],
    });
    source.observations.push({
      kind: 'account_type',
      scope: { kind: 'account', id: source.legacySnapshot.transactions[0]!.accountId },
      state: 'unknown',
      observedAt: null,
      evidence: [],
    });
    const before = structuredClone(source);
    expect(await service.preview(input())).toMatchObject({ status: 'approval_required' });
    expect(source).toEqual(before);
  });
  it.each(['missing', 'duplicate', 'unknown', 'scoped'] as const)(
    'rejects partial account coverage with a %s collection receipt',
    async (kind) => {
      source.coverage.accounts = 'partial';
      if (kind !== 'missing')
        source.observations.push({
          kind: 'account_collection_coverage',
          scope:
            kind === 'scoped' ? { kind: 'account', id: 'fd-account-checking' } : { kind: 'global' },
          state: kind === 'unknown' ? 'unknown' : 'complete',
          observedAt: now,
          evidence: [],
        });
      if (kind === 'duplicate')
        source.observations.push(structuredClone(source.observations.at(-1)!));
      expect(await service.preview(input())).toMatchObject({
        status: 'blocked',
        reasonCodes: ['source_incomplete'],
        plan: null,
      });
    },
  );
  it('allows unrelated incomplete collections without inventing completeness', async () => {
    for (const key of ['payees', 'rules', 'schedules', 'budgets', 'tags'] as const)
      source.coverage[key] = 'unknown';
    expect(await service.preview(input())).toMatchObject({ status: 'approval_required' });
    expect(source.coverage.schedules).toBe('unknown');
  });
  it.each(['missing', 'closed', 'currency', 'imported_currency'] as const)(
    'rejects %s target account facts',
    async (kind) => {
      const accountId = source.legacySnapshot.transactions[0]!.accountId;
      const account = source.legacySnapshot.accounts.find((row) => row.id === accountId)!;
      if (kind === 'missing')
        source.legacySnapshot.accounts = source.legacySnapshot.accounts.filter(
          (row) => row.id !== accountId,
        );
      if (kind === 'closed') account.isClosed = true;
      if (kind === 'currency') account.clearedBalance.currency = 'EUR';
      if (kind === 'imported_currency') account.importedBalance.currency = 'EUR';
      expect(await service.preview(input())).toMatchObject({
        status: 'blocked',
        reasonCodes: ['precondition_mismatch'],
        plan: null,
      });
    },
  );
  it('rejects malformed source and contradictory empty coverage', async () => {
    source.coverage.transactions = 'empty';
    expect(await service.preview(input())).toMatchObject({
      status: 'blocked',
      reasonCodes: ['source_incomplete'],
      plan: null,
    });
    synchronize.mockResolvedValue({ financialSnapshot: {} });
    expect(await service.preview(input())).toMatchObject({
      status: 'blocked',
      reasonCodes: ['source_invalid'],
      plan: null,
    });
  });
  it('rejects contradictory legacy and financial snapshot envelopes', async () => {
    const conflicting = structuredClone(source.legacySnapshot);
    conflicting.transactions[0]!.amount.minorUnits = '-9999';
    synchronize.mockResolvedValue({
      financialSnapshot: structuredClone(source),
      snapshot: conflicting,
    });
    expect(await service.preview(input())).toMatchObject({
      status: 'blocked',
      reasonCodes: ['source_invalid'],
      plan: null,
    });
  });
  it('rejects duplicate canonical transaction identities including nested children', async () => {
    source.legacySnapshot.transactions[1]!.subtransactions.push(
      structuredClone(source.legacySnapshot.transactions[0]!),
    );
    expect(await service.preview(input())).toMatchObject({
      status: 'blocked',
      reasonCodes: ['transaction_identity_conflict'],
      plan: null,
    });
  });
  it.each(['amount', 'account', 'category', 'version'] as const)(
    'rejects changed approved %s facts',
    async (fact) => {
      const tx = source.legacySnapshot.transactions[0]!;
      if (fact === 'amount') tx.amount.minorUnits = '-1251';
      if (fact === 'account') tx.accountId = 'fd-account-card';
      if (fact === 'category') tx.categoryId = null;
      if (fact === 'version') source.legacySnapshot.actualVersion = 'different-version';
      expect(await service.preview(input())).toMatchObject({
        status: 'blocked',
        reasonCodes: ['precondition_mismatch'],
        plan: null,
      });
    },
  );
  it('rejects material source change between the two bounded local observations', async () => {
    const changed = structuredClone(source);
    changed.legacySnapshot.accounts[1]!.clearedBalance.minorUnits = '-25001';
    synchronize
      .mockResolvedValueOnce({ financialSnapshot: structuredClone(source) })
      .mockResolvedValueOnce({ financialSnapshot: changed });
    expect(await service.preview(input())).toMatchObject({
      status: 'blocked',
      reasonCodes: ['source_changed'],
      plan: null,
    });
    expect(synchronize).toHaveBeenCalledTimes(2);
  });
  it('ignores generated capture clocks and hashes in material source comparison', async () => {
    const next = structuredClone(source);
    next.snapshotId = 'next-capture';
    next.contentHash = 'new-capture-hash';
    next.capturedAt = '2098-01-01T11:59:59.000Z';
    next.legacySnapshot.snapshotDate = next.capturedAt;
    synchronize
      .mockResolvedValueOnce({ financialSnapshot: structuredClone(source) })
      .mockResolvedValueOnce({ financialSnapshot: next });
    expect(await service.preview(input())).toMatchObject({ status: 'approval_required' });
  });
  it.each(['stale', 'future', 'invalid'] as const)('rejects a %s source date', async (kind) => {
    source.legacySnapshot.snapshotDate =
      kind === 'stale'
        ? '2097-01-01T12:00:00.000Z'
        : kind === 'future'
          ? '2099-01-01T12:00:00.000Z'
          : 'garbage';
    expect(await service.preview(input())).toMatchObject({
      status: 'blocked',
      reasonCodes: ['stale_snapshot'],
      plan: null,
    });
  });
  it('withholds unknown quorum when an expired proposal is rejected before source I/O', async () => {
    service = new CategorizationPreviewService({
      store,
      connectionManager: manager,
      protocol: native,
      clock: () => new Date(Date.now()),
    });
    vi.setSystemTime(new Date('2098-01-03T12:00:00.000Z'));
    expect(await service.preview(input())).toMatchObject({
      status: 'blocked',
      reasonCodes: ['proposal_expired'],
      requiredApprovers: null,
    });
    expect(synchronize).not.toHaveBeenCalled();
  });
  it.each(['serverUrl', 'groupId'] as const)(
    'withholds a same-budget %s rotation during capture',
    async (field) => {
      synchronize.mockImplementationOnce(async () => {
        config = {
          ...config,
          [field]: field === 'serverUrl' ? 'http://other-fixture.invalid' : 'other-fixture-group',
        };
        return {
          financialSnapshot: structuredClone(source),
          snapshot: structuredClone(source.legacySnapshot),
        };
      });
      await expect(service.preview(input())).rejects.toMatchObject({ statusCode: 403 });
      expect(synchronize).toHaveBeenCalledTimes(1);
      expect(native.planSetCategory).not.toHaveBeenCalled();
    },
  );
  it('blocks expiry during source I/O', async () => {
    const late = new Date('2098-01-03T12:00:00.000Z');
    service = new CategorizationPreviewService({
      store,
      connectionManager: manager,
      protocol: native,
      clock: () => new Date(Date.now()),
    });
    synchronize.mockImplementationOnce(async () => {
      vi.setSystemTime(late);
      return { financialSnapshot: structuredClone(source) };
    });
    expect(await service.preview(input())).toMatchObject({
      status: 'blocked',
      reasonCodes: ['proposal_expired'],
      plan: null,
    });
  });
  it('returns safe failure codes for SDK and native failure, never arbitrary exception text', async () => {
    synchronize.mockRejectedValueOnce(new Error('secret source detail'));
    expect(await service.preview(input())).toMatchObject({
      status: 'blocked',
      reasonCodes: ['source_unavailable'],
      plan: null,
    });
    vi.mocked(native.planSetCategory).mockImplementationOnce(() => {
      throw new Error('secret native detail');
    });
    const result = await service.preview(input());
    expect(result).toMatchObject({ status: 'blocked', reasonCodes: ['plan_failed'], plan: null });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('passes only frozen detached transaction/category data into native planning', async () => {
    vi.mocked(native.planSetCategory).mockImplementationOnce((tx, category) => {
      expect(Object.isFrozen(tx)).toBe(true);
      expect(Object.isFrozen(tx.amount)).toBe(true);
      expect(Object.isFrozen(category)).toBe(true);
      expect(tx).not.toHaveProperty('store');
      expect(category).not.toHaveProperty('connector');
      return structuredClone(plan);
    });
    expect(await service.preview(input())).toMatchObject({ status: 'approval_required' });
    expect(source.legacySnapshot.transactions[0]!.amount.minorUnits).toBe('-1250');
  });
  it('rejects invalid or inconsistent native plans', async () => {
    vi.mocked(native.planSetCategory).mockReturnValueOnce({ ...plan, transactionId: 'wrong-id' });
    expect(await service.preview(input())).toMatchObject({
      status: 'blocked',
      reasonCodes: ['precondition_mismatch'],
      plan: null,
    });
  });
});
