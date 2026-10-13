import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as H3 from 'h3';
import {
  GENERIC_MUTATION_POLICY_VERSION,
  SqliteWorkflowStore,
  canonicalProposalHash,
} from '@balanceframe/workflow-store';
import type { GenericActionProposal, GenericProposalOperation } from '@balanceframe/workflow-store';
import type { EventWithContext } from '../../server/utils/workflow-store';
import { getWorkflowStore } from '../../server/utils/workflow-store';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import fixture from '../../../../protocol/fixtures/representative.json';
import listProposals from '../../server/api/proposal/index.get';
import proposalDetail from '../../server/api/proposal/[id].get';

vi.mock('@balanceframe/application', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createDefaultConnectionManager: () => ({ loadConfig: async () => ({ budgetId }) }),
}));

const OWNER_ID = 'proposal-list-owner';
const ACTOR_ID = 'proposal-list-human';
const NOW = '2026-08-01T12:00:00.000Z';
const EXPIRES_AT = '2026-08-02T12:00:00.000Z';
const RULE_ID = 'proposal-list-actual-rule';
const transaction = fixture.transactions[0]!;
const canonicalFixture = canonicalProtocolSnapshotSchema.parse(fixture);
const targetCategoryId = fixture.transactions[1]!.categoryId!;
const signedMinorUnits = BigInt(transaction.amount.minorUnits);
const amount = {
  minorUnits: (signedMinorUnits < 0n ? -signedMinorUnits : signedMinorUnits).toString(),
  currency: transaction.amount.currency,
};
const composite = {
  operations: [],
  reallocations: [],
  transferRecommendations: [],
  ledgerProjections: [],
  evidenceReferences: [],
};
const ruleSnapshot = {
  id: RULE_ID,
  name: 'Current Actual rule',
  order: 3,
  trigger: [{ field: 'account', op: 'is', value: transaction.accountId }],
  actions: [{ op: 'set', field: 'category', value: transaction.categoryId }],
  inactive: false,
  stage: 'pre' as const,
  conditionsOp: 'and' as const,
};

interface TestResponse {
  statusCode: number;
  statusMessage: string;
  headersSent: boolean;
  setHeader(name: string, value: string | string[]): TestResponse;
  getHeader(name: string): string | string[] | undefined;
  removeHeader(name: string): void;
}
type RequestEvent = H3.H3Event & EventWithContext;

let store: SqliteWorkflowStore;
let bootstrapped = false;
let sequence = 0;
let spaceId = '';
let budgetId = '';
let membershipId = '';

function event(requestSpace = spaceId, requestActor = ACTOR_ID): RequestEvent {
  const headers = new Map<string, string | string[]>();
  const response: TestResponse = {
    statusCode: 200,
    statusMessage: '',
    headersSent: false,
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
      return response;
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    removeHeader(name) {
      headers.delete(name.toLowerCase());
    },
  };
  return {
    node: {
      req: {
        headers: { 'x-balanceframe-space': requestSpace },
      },
      res: response,
    },
    context: {
      auth: {
        authenticated: true,
        user: { id: requestActor },
        actorId: 'forged-legacy',
        method: 'session',
        principalType: 'human',
        sessionId: `session:${requestActor}`,
      },
      runtimeConfig: { workflowDbPath: ':memory:', devBypassAuth: false },
    },
  } as unknown as RequestEvent;
}

function grant(
  capability: string,
  resourceKind: 'budget' | 'account' | 'category' | 'rule' | 'transaction',
  resourceId: string,
) {
  store.governance.provisionResourceGrant({
    spaceId,
    actorId: ACTOR_ID,
    membershipId,
    budgetId,
    capability,
    resourceKind,
    resourceId,
    granted: true,
    now: NOW,
  });
}

function grantProposal(operation: GenericProposalOperation) {
  if (operation === 'set_category') {
    grant('categorization:propose', 'budget', budgetId);
    grant('categorization:propose', 'transaction', transaction.id);
    grant('categorization:propose', 'account', transaction.accountId);
    grant('categorization:propose', 'category', transaction.categoryId!);
    grant('categorization:propose', 'category', targetCategoryId);
    return;
  }
  grant('rule:propose', 'budget', budgetId);
  grant('rule:propose', 'account', transaction.accountId);
  grant('rule:propose', 'category', targetCategoryId);
  if (operation === 'update_rule' || operation === 'delete_rule') {
    grant('rule:propose', 'rule', RULE_ID);
    grant('rule:propose', 'category', transaction.categoryId!);
  }

}
function proposalInput(operation: GenericProposalOperation): {
  payload: GenericActionProposal['payload'];
  preconditions: Record<string, unknown>;
} {
  switch (operation) {
    case 'set_category':
      return {
        payload: {
          kind: 'set_category',
          transactionId: transaction.id,
          categoryId: targetCategoryId,
          composite,
        },
        preconditions: {
          transaction: {
            id: transaction.id,
            accountId: transaction.accountId,
            categoryId: transaction.categoryId,
            direction: signedMinorUnits < 0n ? 'outgoing' : 'incoming',
            amount,
            actualVersion: fixture.actualVersion,
          },
        },
      };
    case 'create_rule':
      return {
        payload: {
          kind: 'create_rule',
          transactionId: null,
          categoryId: targetCategoryId,
          composite,
          rule: {
            stage: 'post',
            conditionsOp: 'and',
            conditions: [{ field: 'payee', op: 'is', value: transaction.payeeId! }],
            actions: [{ op: 'set', field: 'category', value: targetCategoryId }],
          },
        },
        preconditions: { actualVersion: fixture.actualVersion },
      };
    case 'update_rule':
      return {
        payload: { kind: 'update_rule', ruleId: RULE_ID, inactive: true, composite },
        preconditions: {
          rule: ruleSnapshot,
          override: null,
          actualVersion: fixture.actualVersion,
          categoryGroupMembers: {},
        },
      };
    case 'delete_rule':
      return {
        payload: { kind: 'delete_rule', ruleId: RULE_ID, composite },
        preconditions: {
          rule: ruleSnapshot,
          override: null,
          actualVersion: fixture.actualVersion,
          categoryGroupMembers: {},
        },
      };
  }
}

async function seed(operation: GenericProposalOperation, options: {
  readonly preconditions?: Readonly<Record<string, unknown>>;
  readonly payload?: GenericActionProposal['payload'];
  readonly expiresAt?: string;
} = {}) {
  grantProposal(operation);
  const input = proposalInput(operation);
  const payload = options.payload ?? input.payload;
  const preconditions = { ...input.preconditions, ...options.preconditions };
  const auth = { method: 'session' as const, actorId: ACTOR_ID, sessionId: `session:${ACTOR_ID}` };
  const expiresAt = options.expiresAt ?? EXPIRES_AT;
  return store.createProposal({
    operation,
    spaceId,
    budgetId,
    payload,
    payloadHash: canonicalProposalHash({
      operation,
      budgetId,
      payload,
      preconditions,
      actorId: ACTOR_ID,
      policyVersion: GENERIC_MUTATION_POLICY_VERSION,
      expiresAt,
    }),
    policyVersion: GENERIC_MUTATION_POLICY_VERSION,
    preconditions: JSON.stringify(preconditions),
    expiresAt,
    actorId: ACTOR_ID,
    auth,
    provenance: 'proposal-list-test',
  });
}

function nativeSourceEnvelope() {
  for (const capability of ['source', 'rule:view']) grant(capability, 'budget', budgetId);
  for (const account of canonicalFixture.accounts)
    for (const capability of ['existence', 'history', 'name', 'source', 'rule:propose'])
      grant(capability, 'account', account.id);
  for (const category of canonicalFixture.categories)
    for (const capability of ['existence', 'name', 'rule:propose']) grant(capability, 'category', category.id);
  for (const rule of canonicalFixture.rules) grant('rule:view', 'rule', rule.id);
  for (const capability of ['transaction.view', 'source'])
    grant(capability, 'transaction', transaction.id);
  return {
    sourceTransactions: [canonicalFixture.transactions[0]!],
    sourceAccounts: canonicalFixture.accounts,
    nativeImpact: {
      payees: canonicalFixture.payees,
      categories: canonicalFixture.categories,
      rules: canonicalFixture.rules,
    },
  };
}

function privateReadLimit(restrictions: {
  readonly maxOperationCount?: number;
  readonly maxGrossOutgoing?: readonly { minorUnits: string; currency: string }[];
}) {
  store.governance.provisionResourceGrant({
    spaceId, actorId: ACTOR_ID, membershipId, budgetId,
    capability: 'full-read', resourceKind: 'budget', resourceId: budgetId,
    granted: true, restrictions, now: NOW,
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  spaceId = '';
  budgetId = `proposal-list-budget-${++sequence}`;
  const provider = getWorkflowStore(event() as EventWithContext);
  if ('error' in provider) throw new Error(provider.error);
  store = provider.store;
  if (!bootstrapped) {
    await store.claimBootstrap({
      name: 'Proposal list owner',
      email: 'proposal-list-owner@example.test',
      claimId: 'proposal-list-fixture',
    });
    await store.finalizeBootstrap({ claimId: 'proposal-list-fixture', ownerUserId: OWNER_ID });
    bootstrapped = true;
  }
  const ownerAuth = {
    method: 'human-session' as const,
    actorId: OWNER_ID,
    sessionId: `session:${OWNER_ID}`,
    reauthenticatedAt: NOW,
  };
  const space = store.governance.createSpace({
    actorId: OWNER_ID,
    name: `Proposal list space ${sequence}`,
    kind: 'shared',
    now: NOW,
    auth: ownerAuth,
  });
  spaceId = space.id;
  store.governance.bindBudget({ spaceId, budgetId, now: NOW, auth: ownerAuth });
  if (!store.governance.getPolicy({ spaceId })) {
    store.governance.setPolicy({
      spaceId,
      expectedVersion: null,
      policy: { minimumApprovers: 1, approvalThresholds: [] },
      now: NOW,
      auth: ownerAuth,
    });
  }
  await store.upsertActorMembership(ACTOR_ID, 'active', [], '');
  membershipId = store.governance.addMembership({
    spaceId,
    actorId: ACTOR_ID,
    validFrom: NOW,
    now: NOW,
    auth: ownerAuth,
  }).id;
  grant('observe', 'budget', budgetId);
  grant('full-read', 'budget', budgetId);
});

afterEach(() => vi.useRealTimers());
afterAll(() => store.close());

describe('proposal list route', () => {
  it.each(['current', 'expired', 'withheld'] as const)(
    'returns the complete reviewed native rule simulation with %s publication authority', async (state) => {
      const reviewedSimulation = {
        ruleId: '', name: canonicalFixture.payees[0]!.name,
        transactionsMatched: 1, transactionsAffected: [transaction.id],
        categoryDistribution: { [targetCategoryId]: 1 }, conflicts: [],
        examples: [{ txId: transaction.id, payee: transaction.payeeName, amount: transaction.amount,
          currentCategory: transaction.categoryId, wouldChange: true }],
      };
      grant('rule:propose', 'transaction', transaction.id);
      const proposal = await seed('create_rule', { preconditions: { ...nativeSourceEnvelope(), reviewedSimulation } });
      if (state === 'expired') vi.setSystemTime(new Date(Date.parse(EXPIRES_AT) + 1));
      if (state === 'withheld') privateReadLimit({ maxOperationCount: 0 });
      const listed = await listProposals(event());
      expect(listed.status).toBe('ok');
      const expectedStatus = state === 'withheld' ? 'missing' : state === 'expired' ? 'stale' : 'present';
      expect(listed.result!.proposals.find(({ id }) => id === proposal.id)?.simulationStatus).toBe(expectedStatus);
      const request = event();
      request.context.params = { id: proposal.id };
      const detail = await proposalDetail(request);
      expect(detail.status).toBe('ok');
      expect(detail.result!.simulationStatus).toBe(expectedStatus);
      expect(detail.result!.simulation).toEqual(state === 'withheld' ? null : reviewedSimulation);
      if (state === 'withheld') expect(detail.result!.proposal.preconditions).toBeNull();
    },
  );
  it.each(['count', 'outgoing'] as const)(
    'accounts for the repeated native simulation against the independent %s disclosure limit', async (limit) => {
      const source = nativeSourceEnvelope();
      const reviewedSimulation = {
        ruleId: '', name: canonicalFixture.payees[0]!.name,
        transactionsMatched: 1, transactionsAffected: [transaction.id],
        categoryDistribution: { [targetCategoryId]: 1 }, conflicts: [],
        examples: [{ txId: transaction.id, payee: transaction.payeeName, amount: transaction.amount,
          currentCategory: transaction.categoryId, wouldChange: true }],
      };
      grant('rule:propose', 'transaction', transaction.id);
      const proposal = await seed('create_rule', { preconditions: { ...source, reviewedSimulation } });
      privateReadLimit(limit === 'count'
        ? { maxOperationCount: source.sourceAccounts.length * 2 + 2 }
        : { maxGrossOutgoing: [{ ...amount, minorUnits: (BigInt(amount.minorUnits) * 2n).toString() }] });
      const listed = await listProposals(event());
      expect(JSON.parse(listed.result!.proposals[0]!.preconditions).reviewedSimulation).toEqual(reviewedSimulation);
      const request = event();
      request.context.params = { id: proposal.id };
      const detail = await proposalDetail(request);
      expect(detail.status).toBe('ok');
      expect(detail.result!.proposal).toMatchObject({ privateEnvelopeVisible: false, payload: null, preconditions: null });
      expect(detail.result!.simulation).toBeNull();
    },
  );
  it.each([false, true])('preserves persisted proposal payloads when operation-filtered listing is %s', async (filtered) => {
    const first = await seed('set_category');
    const second = await seed('create_rule');
    const listed = await store.listProposals({
      budgetId,
      ...(filtered ? { operations: ['set_category', 'create_rule'] as GenericProposalOperation[] } : {}),
    });
    expect(listed.map(({ id, payload }) => ({ id, payload })).sort((left, right) => left.id.localeCompare(right.id)))
      .toEqual([first, second].map(({ id, payload }) => ({ id, payload })).sort((left, right) => left.id.localeCompare(right.id)));
  });
  it('withholds every private envelope when a heterogeneous source-authorized collection contains a individually over-cap row', async () => {
    const first = await seed('set_category');
    const second = await seed('set_category', {
      preconditions: { simulation: { projectedBalance: canonicalFixture.accounts[2]!.clearedBalance } },
      expiresAt: '2026-08-02T12:01:00.000Z',
    });
    privateReadLimit({ maxOperationCount: 1 });
    const combined = await listProposals(event());
    expect(combined.status).toBe('ok');
    expect(combined.result!.proposals.map(({ id }) => id).sort()).toEqual([first.id, second.id].sort());
    expect(combined.result!.proposals.map(({ preconditions }) => preconditions)).toEqual(['null', 'null']);
    expect(combined.result!.proposals.every(({ categoryId }) => categoryId === null)).toBe(true);
  });
  it('lists each current-scope generic operation for the authenticated human', async () => {
    const operations: GenericProposalOperation[] = [
      'set_category',
      'create_rule',
      'update_rule',
      'delete_rule',
    ];
    const created = await Promise.all(operations.map((operation) => seed(operation)));

    const response = await listProposals(event());

    expect(response.status).toBe('ok');
    expect(response.result!.total).toBe(operations.length);
    expect(response.result!.proposals.map(({ operation }) => operation).sort()).toEqual(
      [...operations].sort(),
    );
    expect(response.result!.proposals.map(({ id }) => id).sort()).toEqual(
      created.map(({ id }) => id).sort(),
    );
  });
  it('caps repeated complete native source snapshots as one private outgoing disclosure collection', async () => {
    const preconditions = nativeSourceEnvelope();
    const first = await seed('create_rule', { preconditions });
    privateReadLimit({ maxGrossOutgoing: [amount] });
    const admitted = await listProposals(event());
    expect(admitted.status).toBe('ok');
    expect(admitted.result!.proposals.map(({ id }) => id)).toEqual([first.id]);
    expect(JSON.parse(admitted.result!.proposals[0]!.preconditions).sourceTransactions)
      .toEqual(preconditions.sourceTransactions);

    const second = await seed('create_rule', {
      preconditions, expiresAt: '2026-08-02T12:01:00.000Z',
    });
    const combined = await listProposals(event());
    expect(combined.status).toBe('ok');
    expect(combined.result!.proposals.map(({ id }) => id).sort())
      .toEqual([first.id, second.id].sort());
    expect(combined.result!.proposals.map(({ preconditions }) => preconditions))
      .toEqual(['null', 'null']);
    expect(combined.result!.proposals.every(({ categoryId }) => categoryId === null)).toBe(true);
  });

  it('counts source balances and derived Money slots without treating negative balances as ledger outgoing', async () => {
    const source = nativeSourceEnvelope();
    const preconditions = {
      ...source,
      simulation: { projectedBalance: canonicalFixture.accounts[2]!.clearedBalance },
    };
    const first = await seed('create_rule', { preconditions });
    const perEnvelope = source.sourceAccounts.length * 2 + 2;
    privateReadLimit({
      maxOperationCount: perEnvelope,
      maxGrossOutgoing: [{ ...amount, minorUnits: (BigInt(amount.minorUnits) * 2n).toString() }],
    });
    const admitted = await listProposals(event());
    expect(admitted.status).toBe('ok');
    expect(admitted.result!.proposals.map(({ id }) => id)).toEqual([first.id]);
    expect(JSON.parse(admitted.result!.proposals[0]!.preconditions).simulation)
      .toEqual(preconditions.simulation);

    const second = await seed('create_rule', {
      preconditions, expiresAt: '2026-08-02T12:01:00.000Z',
    });
    const combined = await listProposals(event());
    expect(combined.status).toBe('ok');
    expect(combined.result!.proposals.map(({ id }) => id).sort())
      .toEqual([first.id, second.id].sort());
    expect(combined.result!.proposals.map(({ preconditions }) => preconditions))
      .toEqual(['null', 'null']);
  });

  it('charges the full private envelope separately from the preconditions-only list', async () => {
    const input = proposalInput('set_category');
    const proposal = await seed('set_category', {
      payload: {
        ...input.payload,
        composite: {
          ...composite,
          operations: [{
            operation: 'set_category', transactionId: transaction.id,
            accountId: transaction.accountId, categoryId: targetCategoryId,
            direction: signedMinorUnits < 0n ? 'outgoing' : 'incoming', amount,
          }],
        },
      },
    });
    privateReadLimit({ maxGrossOutgoing: [amount] });
    const listed = await listProposals(event());
    expect(listed.result!.proposals.map(({ id }) => id)).toEqual([proposal.id]);
    expect(JSON.parse(listed.result!.proposals[0]!.preconditions).transaction.amount).toEqual(amount);
    const request = event();
    request.context.params = { id: proposal.id };
    const detail = await proposalDetail(request);
    expect(detail.status).toBe('ok');
    expect(detail.result!.proposal).toMatchObject({
      id: proposal.id, privateEnvelopeVisible: false,
      payload: null, preconditions: null, canApprove: false,
    });
  });

  it('caps the repeated simulation in the exact detail response rather than only its proposal envelope', async () => {
    const proposal = await seed('set_category', {
      preconditions: { simulation: { projectedBalance: canonicalFixture.accounts[2]!.clearedBalance } },
    });
    privateReadLimit({ maxOperationCount: 2 });
    const listed = await listProposals(event());
    expect(listed.result!.proposals.map(({ id }) => id)).toEqual([proposal.id]);
    expect(JSON.parse(listed.result!.proposals[0]!.preconditions).simulation.projectedBalance)
      .toEqual(canonicalFixture.accounts[2]!.clearedBalance);
    const request = event();
    request.context.params = { id: proposal.id };
    const detail = await proposalDetail(request);
    expect(detail.status).toBe('ok');
    expect(detail.result!.proposal).toMatchObject({
      id: proposal.id, privateEnvelopeVisible: false, payload: null, preconditions: null,
    });
    expect(detail.result!.simulation).toBeNull();
  });
  it('withholds a private evidence-bearing proposal from a budget-only reader until its exact evidence grant exists', async () => {
    grantProposal('set_category');
    const evidenceId = 'private-receipt-reference';
    store.governance.provisionResourceGrant({
      spaceId, actorId: ACTOR_ID, membershipId, budgetId,
      resourceKind: 'evidence', resourceId: evidenceId, capability: 'categorization:propose', granted: true, now: NOW,
    });
    const { payload, preconditions } = proposalInput('set_category');
    const proposal = await store.createProposal({
      operation: 'set_category', spaceId, budgetId,
      payload: { ...payload, composite: { ...composite, evidenceReferences: [{
        evidenceId, amount: { minorUnits: '0', currency: amount.currency }, authorized: true, redaction: 'visible',
      }] } },
      policyVersion: GENERIC_MUTATION_POLICY_VERSION, preconditions: JSON.stringify(preconditions),
      expiresAt: EXPIRES_AT, actorId: ACTOR_ID,
      auth: { method: 'session', actorId: ACTOR_ID, sessionId: `session:${ACTOR_ID}` },
      provenance: 'exact-private-evidence',
    });
    const readerId = 'budget-only-proposal-reader';
    await store.upsertActorMembership(readerId, 'active', [], '');
    const ownerAuth = { method: 'human-session' as const, actorId: OWNER_ID, sessionId: `session:${OWNER_ID}`, reauthenticatedAt: NOW };
    const readerMembership = store.governance.addMembership({ spaceId, actorId: readerId, validFrom: NOW, now: NOW, auth: ownerAuth });
    for (const capability of ['observe', 'full-read']) store.governance.provisionResourceGrant({
      spaceId, actorId: readerId, membershipId: readerMembership.id, budgetId,
      resourceKind: 'budget', resourceId: budgetId, capability, granted: true, now: NOW,
    });
    const hidden = await listProposals(event(spaceId, readerId));
    expect(hidden.status).toBe('ok');
    expect(hidden.result!.proposals).toEqual([]);
    expect(hidden.result!.total).toBe(0);
    store.governance.provisionResourceGrant({
      spaceId, actorId: readerId, membershipId: readerMembership.id, budgetId,
      resourceKind: 'evidence', resourceId: evidenceId, capability: 'full-read', granted: true, now: NOW,
    });
    const visible = await listProposals(event(spaceId, readerId));
    expect(visible.result!.proposals.map(({ id }) => id)).toEqual([proposal.id]);
  });
  it('lists exact proposal metadata without restoring a private envelope for an operation-only reader', async () => {
    const proposal = await seed('set_category');
    store.governance.provisionResourceGrant({
      spaceId,
      actorId: ACTOR_ID,
      membershipId,
      budgetId,
      capability: 'full-read',
      resourceKind: 'budget',
      resourceId: budgetId,
      granted: false,
      now: NOW,
    });

    const response = await listProposals(event());

    expect(response.status).toBe('ok');
    expect(response.result!.proposals.map(({ id }) => id)).toEqual([proposal.id]);
    expect(response.result!.total).toBe(1);
    expect(response.result!.proposals[0]).toMatchObject({
      id: proposal.id,
      operation: 'set_category',
      budgetId,
      transactionId: null,
      categoryId: null,
      ruleId: null,
      preconditions: 'null',
    });
    expect(response.result!.proposals[0]).not.toHaveProperty('payload');
    const visible = JSON.stringify(response.result);
    expect(visible).not.toContain(transaction.id);
    expect(visible).not.toContain(transaction.accountId);
    expect(visible).not.toContain(targetCategoryId);
    expect(visible).not.toContain(amount.minorUnits);
  });

});
