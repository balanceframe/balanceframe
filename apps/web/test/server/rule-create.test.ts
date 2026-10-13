import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as H3 from 'h3';
import {
  GENERIC_MUTATION_POLICY_VERSION,
  SqliteWorkflowStore,
  canonicalProposalHash,
} from '@balanceframe/workflow-store';
import type {
  GenericActionProposal,
  ResourceCapability,
  ResourceGrantRestrictions,
} from '@balanceframe/workflow-store';
import { createNativeRuleMutationProtocol } from '@balanceframe/application';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import type { ProtocolSnapshot } from '@balanceframe/protocol-generated';
import type { LedgerSnapshotResult } from '@balanceframe/actual-adapter';
import fixture from '../../../../protocol/fixtures/representative.json';
import type { EventWithContext } from '../../server/utils/workflow-store';
import { getWorkflowStore } from '../../server/utils/workflow-store';
import { completeNativeRuleSourceAvailability, grantNativeRuleSources, nativeRuleSource } from './native-rule-source.fixture';
import { deriveProposalAuthorizationFacts } from '../../../../packages/workflow-store/src/proposal';
import { buildProposalApprovalView } from '../../server/utils/proposal-approval-view';
import listProposalsHandler from '../../server/api/proposal/index.get';
import proposalDetailHandler from '../../server/api/proposal/[id].get';

const { loadConfig, withConnection, actualCreateRule } = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  withConnection: vi.fn(),
  actualCreateRule: vi.fn(),
}));

vi.mock('h3', async (original) => ({
  ...(await original<typeof H3>()),
  readBody: async (event: { body: unknown }) => {
    if (event.body instanceof Error) throw event.body;
    return event.body;
  },
}));
vi.mock('../../server/utils/mutation-executor', () => ({
  createMutationConnectionManager: () => ({ loadConfig, withConnection }),
}));
vi.mock('@balanceframe/workflow-store', async () =>
  await import('../../../../packages/workflow-store/src/index'));
import createRuleHandler from '../../server/api/rule/index.post';

const ACTOR_ID = 'rule-proposer';
const OWNER_ID = 'rule-create-owner';
const READER_ID = 'rule-source-reader';
const NOW = '2026-08-01T12:00:00.000Z';
const auth = {
  method: 'human-session' as const,
  actorId: OWNER_ID,
  sessionId: `session:${OWNER_ID}`,
  reauthenticatedAt: NOW,
};
const canonicalFixture = canonicalProtocolSnapshotSchema.parse(fixture);
const transaction = canonicalFixture.transactions.find((item) => item.payeeName !== null)!;
const targetCategory = canonicalFixture.categories.find((item) => item.id !== transaction.categoryId)!;
const ruleName = 'User-named Whole Foods rule';

interface TestResponse {
  statusCode: number;
  statusMessage: string;
  headersSent: boolean;
  setHeader(name: string, value: string | string[]): TestResponse;
  getHeader(name: string): string | string[] | undefined;
  removeHeader(name: string): void;
}
interface RequestEvent extends EventWithContext {
  body: unknown;
  node: { req: { headers: Record<string, string> }; res: TestResponse };
  context: EventWithContext['context'] & {
    auth: NonNullable<EventWithContext['context']['auth']>;
    runtimeConfig: { workflowDbPath: string; devBypassAuth: false };
    params?: { id: string };
  };
}
interface ProposalResult {
  status: 'ok' | 'error';
  result: {
    proposal: {
      id: string;
      operation: string;
      payloadHash: string;
      privateEnvelopeVisible: boolean;
      payload: Record<string, unknown> | null;
      preconditions: Record<string, unknown> | null;
      approvers: readonly unknown[];
    };
  } | null;
  error: { code: string; message: string } | null;
}
type Handler = (event: RequestEvent) => Promise<ProposalResult>;
const createProposal = createRuleHandler as unknown as Handler;

let store: SqliteWorkflowStore;
let spaceId = '';
let budgetId = '';
let membershipId = '';
let fixtureSequence = 0;
let bootstrapped = false;
let currentSnapshot: ProtocolSnapshot;
const connector = { createRule: actualCreateRule, ...nativeRuleSource(() => currentSnapshot), synchronize: vi.fn(async (): Promise<{
  snapshot:ProtocolSnapshot;rulePlanningSourceAvailability?:LedgerSnapshotResult['rulePlanningSourceAvailability'];
}> => ({
  snapshot:currentSnapshot,rulePlanningSourceAvailability:completeNativeRuleSourceAvailability(currentSnapshot),
})) };

function event(body: unknown = {}, actorId = ACTOR_ID): RequestEvent {
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
    body,
    node: {
      req: {
        headers: {
          origin: 'https://balanceframe.example.test',
          'x-balanceframe-space': spaceId,
        },
      },
      res: response,
    },
    context: {
      auth: {
        authenticated: true,
        actorId,
        principalType: 'human',
        method: 'session',
        sessionId: `session:${actorId}`,
        user: { id: actorId },
      },
      runtimeConfig: { workflowDbPath: ':memory:', devBypassAuth: false },
    },
  } as unknown as RequestEvent;
}

function grant(
  capability: ResourceCapability,
  resourceKind: 'budget' | 'account' | 'category' | 'transaction',
  resourceId: string,
  restrictions?: ResourceGrantRestrictions,
) {
  return store.governance.provisionResourceGrant({
    spaceId,
    actorId: ACTOR_ID,
    membershipId,
    budgetId,
    capability,
    resourceKind,
    resourceId,
    granted: true,
    now: NOW,
    ...(restrictions ? { restrictions } : {}),
  });
}

function grantStandaloneProposal(restrictions?: ResourceGrantRestrictions) {
  grant('rule:propose', 'budget', budgetId, restrictions);
  grant('rule:propose', 'category', targetCategory.id);
  grant('existence', 'category', targetCategory.id);
  grantNativeRuleSources(store, { spaceId, budgetId, actorId: ACTOR_ID, membershipId, now: NOW }, currentSnapshot);
  for (const a of currentSnapshot.accounts) grant('rule:propose','account',a.id);
  for (const c of currentSnapshot.categories) grant('rule:propose','category',c.id);
  const grantTransactions = (rows: ProtocolSnapshot['transactions']) => {
    for (const t of rows) { grant('rule:propose','transaction',t.id); grantTransactions(t.subtransactions); }
  };
  grantTransactions(currentSnapshot.transactions);
  for (const r of currentSnapshot.rules) store.governance.provisionResourceGrant({
    spaceId,budgetId,actorId:ACTOR_ID,membershipId,now:NOW,resourceKind:'rule',resourceId:r.id,capability:'rule:propose',granted:true,
  });
}

async function createSplitSourceProposal(linked = false): Promise<GenericActionProposal> {
  const child = (id: string, minorUnits: string) => ({
    ...structuredClone(transaction), id, amount: { minorUnits, currency: 'USD' }, subtransactions: [],
  });
  const middle = { ...child('source-middle', '-3000'), subtransactions: [
    child('source-child-one', '-1200'), child('source-child-two', '-1800'),
  ] };
  currentSnapshot.transactions = [
    { ...child('source-parent', '-3000'), subtransactions: [middle] },
    child('source-outgoing', '-2000'),
    child('source-incoming', '5000'),
  ];
  grantStandaloneProposal();
  if (linked) {
    grant('full-read', 'transaction', 'source-child-one');
    grant('full-read', 'account', transaction.accountId);
  }
  const response = await createProposal(event({
    name: ruleName, payeeId: transaction.payeeId, categoryId: targetCategory.id,
    ...(linked ? { transactionId: 'source-child-one' } : {}),
  }));
  expect(response.status).toBe('ok');
  const proposal = await store.getProposal(response.result!.proposal.id);
  if (!proposal || proposal.operation !== 'create_rule') throw new Error('Expected a native source proposal');
  expect(JSON.parse(proposal.preconditions).sourceTransactions).toEqual(currentSnapshot.transactions);
  return proposal;
}

async function grantSourceReader(
  proposal: GenericActionProposal,
  branch: 'budget' | 'exact',
  restrictions: ResourceGrantRestrictions = {},
) {
  await store.upsertActorMembership(READER_ID, 'active', [], '');
  const readerMembershipId = store.governance.addMembership({
    spaceId, actorId: READER_ID, validFrom: NOW, now: NOW, auth,
  }).id;
  const reader = { spaceId, budgetId, actorId: READER_ID, membershipId: readerMembershipId, now: NOW };
  grantNativeRuleSources(store, reader, currentSnapshot);
  const resources = deriveProposalAuthorizationFacts('create_rule', proposal.payload, JSON.parse(proposal.preconditions)).resources;
  for (const resource of [{ resourceKind: 'budget' as const, resourceId: budgetId }, ...resources]) {
    store.governance.provisionResourceGrant({
      ...reader, ...resource, capability: 'rule:approve', granted: true,
    });
  }
  store.governance.provisionResourceGrant({
    ...reader, resourceKind: 'budget', resourceId: budgetId, capability: 'full-read',
    granted: branch === 'budget', restrictions,
  });
  for (const resource of resources) {
    if (branch === 'exact' || !['account', 'category', 'transaction', 'rule'].includes(resource.resourceKind)) {
      store.governance.provisionResourceGrant({
        ...reader, ...resource, capability: 'full-read', granted: true, restrictions,
      });
    }
  }
  return reader;
}

async function expectSourceWireVisibility(proposal: GenericActionProposal, visible: boolean) {
  const readerAuth = { method: 'session' as const, actorId: READER_ID, sessionId: `session:${READER_ID}` };
  const summary = await store.getProposalApprovalSummary({
    proposalId: proposal.id, spaceId, actorId: READER_ID, auth: readerAuth, now: NOW,
  });
  expect(summary.privateEnvelopeVisible).toBe(visible);
  const view = await buildProposalApprovalView({ store, proposal, actorId: READER_ID, auth: readerAuth, now: NOW });
  expect(view).toMatchObject({
    privateEnvelopeVisible: visible,
    preconditions: visible ? JSON.parse(proposal.preconditions) : null,
    payload: visible ? proposal.payload : null,
  });
  const detailEvent = event({}, READER_ID);
  detailEvent.context.params = { id: proposal.id };
  const detail = await (proposalDetailHandler as unknown as Handler)(detailEvent);
  expect(detail.status).toBe('ok');
  expect(detail.result!.proposal).toMatchObject({
    privateEnvelopeVisible: visible,
    preconditions: visible ? JSON.parse(proposal.preconditions) : null,
  });
  const list = await (listProposalsHandler as unknown as (input: RequestEvent) => Promise<{
    status: string; result: { proposals: { id: string; preconditions: string }[] } | null;
  }>)(event({}, READER_ID));
  expect(list.status).toBe('ok');
  expect(list.result!.proposals.find((item) => item.id === proposal.id)?.preconditions)
    .toBe(visible ? JSON.stringify(JSON.parse(proposal.preconditions)) : 'null');
  if (!visible) {
    for (const wire of [view, detail, list]) {
      expect(JSON.stringify(wire)).not.toContain('source-child-one');
      expect(JSON.stringify(wire)).not.toContain('sourceTransactions');
    }
  }
}

function grantTransactionProposal() {
  grantStandaloneProposal();
  grant('rule:propose', 'transaction', transaction.id);
  grant('rule:propose', 'account', transaction.accountId);
  grant('full-read', 'transaction', transaction.id);
  grant('full-read', 'account', transaction.accountId);
  if (transaction.categoryId && transaction.categoryId !== targetCategory.id) {
    grant('rule:propose', 'category', transaction.categoryId);
    grant('existence', 'category', transaction.categoryId);
  }
}

function proposalCount() {
  return store.countProposals({ budgetId, operations: ['create_rule'] });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.clearAllMocks();
  vi.stubEnv('BETTER_AUTH_URL', 'https://balanceframe.example.test');
  connector.captureMerchantSource.mockReset().mockImplementation(nativeRuleSource(() => currentSnapshot).captureMerchantSource);
  spaceId = '';
  budgetId = `rule-create-budget-${++fixtureSequence}`;
  currentSnapshot = structuredClone(canonicalFixture);
  currentSnapshot.snapshotDate = NOW;
  currentSnapshot.actualDownloadedAt = NOW;

  const provider = getWorkflowStore(event() as EventWithContext);
  if ('error' in provider) throw new Error(provider.error);
  store = provider.store;
  if (!bootstrapped) {
    await store.claimBootstrap({
      name: 'Rule create owner',
      email: 'rule-create-owner@example.test',
      claimId: 'rule-create-handler-fixture',
    });
    await store.finalizeBootstrap({
      claimId: 'rule-create-handler-fixture',
      ownerUserId: OWNER_ID,
    });
    bootstrapped = true;
  }
  const space = store.governance.createSpace({
    actorId: OWNER_ID,
    name: `Rule create space ${fixtureSequence}`,
    kind: 'shared',
    now: NOW,
    auth,
  });
  spaceId = space.id;
  store.governance.bindBudget({ spaceId, budgetId, now: NOW, auth });
  if (!store.governance.getPolicy({ spaceId })) {
    store.governance.setPolicy({
      spaceId,
      expectedVersion: null,
      policy: { minimumApprovers: 1, approvalThresholds: [] },
      now: NOW,
      auth,
    });
  }
  await store.upsertActorMembership(ACTOR_ID, 'active', [], '');
  membershipId = store.governance.addMembership({
    spaceId,
    actorId: ACTOR_ID,
    validFrom: NOW,
    now: NOW,
    auth,
  }).id;

  loadConfig.mockResolvedValue({ budgetId, serverUrl: 'https://actual.invalid' });
  withConnection.mockImplementation(async (operation) => operation({
    config: { budgetId, serverUrl: 'https://actual.invalid' },
    budget: { id: budgetId },
    connector,
    synchronization: {snapshot:currentSnapshot,rulePlanningSourceAvailability:completeNativeRuleSourceAvailability(currentSnapshot)},
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
afterAll(() => store.close());

describe('POST /api/rule', () => {
  it.each(['missing','accounts','payees','categories','categoryGroups','rules','open-history','closed-history','bounded-history'] as const)(
    'refuses SDK native planning with %s source availability without creating a proposal',
    async (missing) => {
      if (missing === 'closed-history') currentSnapshot.accounts.push({
        ...structuredClone(currentSnapshot.accounts[0]!),id:'sdk-closed-account',isClosed:true,
      });
      grantStandaloneProposal();
      const availability = completeNativeRuleSourceAvailability(currentSnapshot);
      if (missing === 'open-history' || missing === 'closed-history') {
        const account = currentSnapshot.accounts.find((row) => row.isClosed === (missing === 'closed-history'))!;
        availability.history.find((row) => row.accountId === account.id)!.state = 'unavailable';
      } else if (missing === 'bounded-history') availability.history[0]!.startDate = '1970-01-01';
      else if (missing !== 'missing') availability[missing] = 'unavailable';
      connector.synchronize.mockResolvedValueOnce({
        snapshot:currentSnapshot,...(missing === 'missing' ? {} : {rulePlanningSourceAvailability:availability}),
      });
      const response = await createProposal(event({name:ruleName,payeeId:transaction.payeeId,categoryId:targetCategory.id}));
      expect(response.status).toBe('error');
      expect(await proposalCount()).toBe(0);
      expect(actualCreateRule).not.toHaveBeenCalled();
    },
  );

  it('denies account-limited raw-source authority before broad SDK synchronization', async () => {
    grantStandaloneProposal();
    grant('source','budget',budgetId,{ accountIds:[transaction.accountId] });
    const response = await createProposal(event({ name:ruleName,payeeId:transaction.payeeId,categoryId:targetCategory.id }));
    expect(response.status).toBe('error');
    expect(withConnection).not.toHaveBeenCalled();
    expect(connector.synchronize).not.toHaveBeenCalled();
    expect(actualCreateRule).not.toHaveBeenCalled();
  });

  it('denies global future rule authority before reading SDK facts for an account-limited actor', async () => {
    grantStandaloneProposal({ accountIds: [transaction.accountId] });
    grant('observe', 'budget', budgetId);
    grant('full-read', 'budget', budgetId);
    const response = await createProposal(event({
      name: ruleName, payeeId: transaction.payeeId, categoryId: targetCategory.id,
    }));
    expect(response.status).toBe('error');
    expect(withConnection).not.toHaveBeenCalled();
    expect(actualCreateRule).not.toHaveBeenCalled();
    expect(await proposalCount()).toBe(0);
  });

  it('refuses duplicate display-name identity substitution for an exact stable payee ID', async () => {
    grantTransactionProposal();
    const other = currentSnapshot.payees.find((payee) => payee.id !== transaction.payeeId)!;
    currentSnapshot.payees = currentSnapshot.payees.map((payee) => payee.id === other.id
      ? { ...payee, name: transaction.payeeName! } : payee);
    const response = await createProposal(event({
      name: ruleName, payeeId: other.id, categoryId: targetCategory.id,
      transactionId: transaction.id,
    }));
    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('MERCHANT_MISMATCH');
    expect(await proposalCount()).toBe(0);
    expect(actualCreateRule).not.toHaveBeenCalled();
  });

  it('simulates only the exact stable payee when duplicate display names exist', async () => {
    const other = currentSnapshot.payees.find((payee) => payee.id !== transaction.payeeId)!;
    currentSnapshot.payees = currentSnapshot.payees.map((payee) => payee.id === other.id
      ? { ...payee,name:transaction.payeeName! } : payee);
    const exact = { ...structuredClone(transaction),id:'exact-payee-transaction' };
    const collision = { ...structuredClone(transaction),id:'same-name-other-payee',payeeId:other.id };
    currentSnapshot.transactions = [exact,collision];
    grantStandaloneProposal();
    const response = await createProposal(event({ name:ruleName,payeeId:exact.payeeId,categoryId:targetCategory.id }));
    expect(response.status).toBe('ok');
    const stored = await store.getProposal(response.result!.proposal.id);
    expect(JSON.parse(stored!.preconditions)).toMatchObject({
      reviewedSimulation: { transactionsMatched:1,transactionsAffected:[exact.id] },
      reviewContext: { evidenceKey:null },
    });
    expect(actualCreateRule).not.toHaveBeenCalled();
  });

  it.each(['amount','category group','category deletion'] as const)('rejects independently captured %s source facts that disagree with the SDK snapshot', async (field) => {
    grantTransactionProposal();
    const source = structuredClone(currentSnapshot);
    if (field === 'amount') source.transactions[0]!.amount.minorUnits = '-99999';
    else if (field === 'category group') source.categories[0]!.groupName = 'Independently changed source group';
    else source.categories[0]!.deleted = !source.categories[0]!.deleted;
    connector.captureMerchantSource.mockImplementationOnce(nativeRuleSource(() => source).captureMerchantSource);
    const response = await createProposal(event({
      name: ruleName,payeeId:transaction.payeeId,categoryId:targetCategory.id,transactionId:transaction.id,
    }));
    expect(response.status).toBe('error');
    expect(await proposalCount()).toBe(0);
    expect(actualCreateRule).not.toHaveBeenCalled();
  });

  it('creates a source-authorized standalone native proposal with a separate human label', async () => {
    grantStandaloneProposal({
      proposalOnly: true,
      operations: ['create_rule'],
    });

    const body = {
      name: ruleName,
      payeeId: transaction.payeeId,
      categoryId: targetCategory.id,
    };
    const response = await createProposal(event(body));

    expect(response.status).toBe('ok');
    expect(withConnection).toHaveBeenCalledWith(expect.any(Function), {
      expectedBudgetId: budgetId,
      dispose: true,
      synchronize: false,
    });
    const proposalView = response.result!.proposal;
    expect(proposalView.privateEnvelopeVisible).toBe(true);
    const stored = await store.getProposal(proposalView.id);
    if (!stored || stored.operation !== 'create_rule') throw new Error('Expected a native rule proposal');
    const ruleProposal: GenericActionProposal & { operation: 'create_rule' } = stored;
    const preconditions = JSON.parse(ruleProposal.preconditions) as Record<string, unknown>;
    const native = await createNativeRuleMutationProtocol();
    const expectedRule = {
      stage: 'post' as const,
      conditionsOp: 'and',
      conditions: [{ field: 'payee', op: 'is', value: transaction.payeeId }],
      actions: [{ op: 'set', field: 'category', value: targetCategory.id }],
    };
    const nativePlan = native.planCreateRule({
      name: ruleName,
      conditions: [{ field: 'payee', op: 'is', value: transaction.payeeId! }],
      actions: [{ op: 'set', field: 'category', value: targetCategory.id }],
      budgetId, stage: 'post', conditionsOp: 'and',
      reviewContext: preconditions.reviewContext as Parameters<typeof native.planCreateRule>[0]['reviewContext'],
    }, currentSnapshot);

    expect(ruleProposal).toMatchObject({
      operation: 'create_rule',
      actorId: ACTOR_ID,
      budgetId,
      payload: {
        kind: 'create_rule',
        transactionId: null,
        categoryId: targetCategory.id,
        rule: expectedRule,
        composite: {
          operations: [],
          reallocations: [],
          transferRecommendations: [],
          ledgerProjections: [],
          evidenceReferences: [],
          nativePayloadHash: nativePlan.hash,
        },
      },
    });
    expect(preconditions).toMatchObject({
      actualVersion: currentSnapshot.actualVersion,
      nativeRule: expectedRule,
      nativePlan,
    });
    expect(ruleProposal.payloadHash).toBe(canonicalProposalHash({
      operation: 'create_rule',
      budgetId,
      payload: ruleProposal.payload,
      preconditions,
      actorId: ACTOR_ID,
      policyVersion: GENERIC_MUTATION_POLICY_VERSION,
      expiresAt: ruleProposal.expiresAt,
    }));
    expect(proposalView.payloadHash).toBe(ruleProposal.payloadHash);
    expect(proposalView.approvers).toEqual([]);
    expect(actualCreateRule).not.toHaveBeenCalled();
  });
  it('reveals the current private rule envelope only with selected-budget full-read', async () => {
    grantStandaloneProposal({
      proposalOnly: true,
      operations: ['create_rule'],
    });
    grant('full-read', 'budget', budgetId);

    const response = await createProposal(event({
      name: ruleName,
      payeeId: transaction.payeeId,
      categoryId: targetCategory.id,
    }));

    expect(response.status).toBe('ok');
    const proposalView = response.result!.proposal;
    expect(proposalView).toMatchObject({
      privateEnvelopeVisible: true,
      payload: { kind: 'create_rule', categoryId: targetCategory.id, rule: { stage: 'post' } },
      preconditions: {
        actualVersion: currentSnapshot.actualVersion,
        ruleName,
      },
    });
    const stored = await store.getProposal(proposalView.id);
    if (!stored || stored.operation !== 'create_rule') throw new Error('Expected a native rule proposal');
    expect(proposalView.payload).toEqual(stored.payload);
    expect(proposalView.preconditions).toEqual(JSON.parse(stored.preconditions));
  });

  describe.each(['budget', 'exact'] as const)('native source envelope through %s full-read', (branch) => {
    it.each([
      ['zero outgoing', { maxGrossOutgoing: [{ currency: 'USD', minorUnits: '0' }] }, false],
      ['collection count', { maxOperationCount: 3 }, false],
      ['collection gross', { maxGrossOutgoing: [{ currency: 'USD', minorUnits: '4999' }] }, false],
      ['source-only split-aware bounds', { maxOperationCount: 4, maxGrossOutgoing: [{ currency: 'USD', minorUnits: '5000' }] }, false],
      // Six source Money nodes, fourteen account balances and two four-row simulations.
      ['complete split-aware wire bounds', { maxOperationCount: 28, maxGrossOutgoing: [{ currency: 'USD', minorUnits: '15000' }] }, true],
      ['unlimited', {}, true],
      ['source-only operation', { operations: ['merchant:analyze'] }, false],
      ['source-account-only scope', { accountIds: canonicalFixture.accounts.map((account) => account.id) }, false],
    ] satisfies readonly (readonly [string, ResourceGrantRestrictions, boolean])[])(
      'applies the current reader %s cap to the whole canonical source', async (_label, restrictions, visible) => {
        const proposal = await createSplitSourceProposal();
        await grantSourceReader(proposal, branch, restrictions);
        await expectSourceWireVisibility(proposal, visible);
        const originView = await buildProposalApprovalView({
          store, proposal, actorId: ACTOR_ID,
          auth: { method: 'session', actorId: ACTOR_ID, sessionId: `session:${ACTOR_ID}` }, now: NOW,
        });
        expect(originView).toMatchObject({ privateEnvelopeVisible: true });
      },
    );

    it.each([
      ['count', { maxOperationCount: 27 }],
      ['gross', { maxGrossOutgoing: [{ currency: 'USD', minorUnits: '14999' }] }],
    ] satisfies readonly (readonly [string, ResourceGrantRestrictions])[])(
      'admits one simulation but refuses the repeated detail at the exact %s boundary', async (_label, restrictions) => {
        const proposal = await createSplitSourceProposal();
        await grantSourceReader(proposal, branch, restrictions);
        const readerAuth = { method: 'session' as const, actorId: READER_ID, sessionId: `session:${READER_ID}` };
        const envelope = await buildProposalApprovalView({
          store, proposal, actorId: READER_ID, auth: readerAuth, now: NOW,
        });
        expect(envelope).toMatchObject({ privateEnvelopeVisible: true });
        expect(envelope?.preconditions?.reviewedSimulation).toMatchObject({
          transactionsAffected: ['source-child-one', 'source-child-two', 'source-incoming', 'source-outgoing'],
        });
        const detailEvent = event({}, READER_ID);
        detailEvent.context.params = { id: proposal.id };
        const detail = await (proposalDetailHandler as unknown as Handler)(detailEvent);
        expect(detail.status).toBe('ok');
        expect(detail.result!.proposal).toMatchObject({
          privateEnvelopeVisible: false, payload: null, preconditions: null,
        });
        expect(JSON.stringify(detail)).not.toContain('source-child-one');
      },
    );

    it('withholds a transaction-linked source envelope from a different zero-cap reader', async () => {
      const proposal = await createSplitSourceProposal(true);
      await grantSourceReader(proposal, branch, { maxGrossOutgoing: [{ currency: 'USD', minorUnits: '0' }] });
      await expectSourceWireVisibility(proposal, false);
    });

    it('retains the actual read contract of legacy proposals without a financial source snapshot', async () => {
      const native = await createSplitSourceProposal();
      const proposal = await store.createProposal({
        operation: 'create_rule', budgetId, spaceId, payload: native.payload,
        policyVersion: GENERIC_MUTATION_POLICY_VERSION,
        preconditions: JSON.stringify({ ruleName, actualVersion: currentSnapshot.actualVersion }),
        expiresAt: native.expiresAt, actorId: ACTOR_ID,
        auth: { method: 'session', actorId: ACTOR_ID, sessionId: `session:${ACTOR_ID}` },
        provenance: 'legacy-rule-source-regression',
      });
      await grantSourceReader(proposal, branch, { maxGrossOutgoing: [{ currency: 'USD', minorUnits: '0' }] });
      await expectSourceWireVisibility(proposal, true);
    });

    it.each([
      ['transaction source', 'transaction', 'source-child-one', 'source'],
      ['account source', 'account', transaction.accountId, 'source'],
      ['account name', 'account', transaction.accountId, 'name'],
      ['account history', 'account', transaction.accountId, 'history'],
      ['category name', 'category', targetCategory.id, 'name'],
      ['payee namespace', 'budget', '', 'source'],
      ['rule namespace', 'budget', '', 'rule:view'],
    ] as const)('withholds the envelope after reader %s revocation while the origin remains authorized', async (_label, resourceKind, resourceId, capability) => {
      const proposal = await createSplitSourceProposal();
      const reader = await grantSourceReader(proposal, branch);
      await expectSourceWireVisibility(proposal, true);
      store.governance.provisionResourceGrant({
        ...reader, resourceKind, resourceId: resourceId || budgetId, capability, granted: false,
      });
      await expectSourceWireVisibility(proposal, false);
      const originView = await buildProposalApprovalView({
        store, proposal, actorId: ACTOR_ID,
        auth: { method: 'session', actorId: ACTOR_ID, sessionId: `session:${ACTOR_ID}` }, now: NOW,
      });
      expect(originView).toMatchObject({ privateEnvelopeVisible: true });
    });
  });

  it.each([
    'noncanonical-money', 'out-of-range-money', 'missing-source', 'duplicate-identity',
    'split-total', 'split-currency', 'account-balance',
  ] as const)('refuses a malformed persisted native %s source instead of treating it as empty', async (malformation) => {
    const original = await createSplitSourceProposal();
    await grantSourceReader(original, 'budget');
    const preconditions = JSON.parse(original.preconditions) as Record<string, unknown>;
    const sources = preconditions.sourceTransactions as ProtocolSnapshot['transactions'];
    if (malformation === 'noncanonical-money') sources[0]!.amount.minorUnits = '-03000';
    if (malformation === 'out-of-range-money') sources[0]!.amount.minorUnits = '-9223372036854775809';
    if (malformation === 'missing-source') delete preconditions.sourceTransactions;
    if (malformation === 'duplicate-identity') sources[1]!.id = sources[2]!.id;
    if (malformation === 'split-total') sources[0]!.amount.minorUnits = '-3001';
    if (malformation === 'split-currency') sources[0]!.subtransactions[0]!.amount.currency = 'EUR';
    if (malformation === 'account-balance')
      (preconditions.sourceAccounts as ProtocolSnapshot['accounts'])[0]!.clearedBalance.minorUnits = '01';
    const proposal = await store.createProposal({
      operation: 'create_rule', budgetId, spaceId, payload: original.payload,
      policyVersion: GENERIC_MUTATION_POLICY_VERSION, preconditions: JSON.stringify(preconditions),
      expiresAt: original.expiresAt, actorId: ACTOR_ID,
      auth: { method: 'session', actorId: ACTOR_ID, sessionId: `session:${ACTOR_ID}` },
      provenance: 'malformed-source-regression',
    });
    await expect(store.getProposalApprovalSummary({
      proposalId: proposal.id, spaceId, actorId: READER_ID,
      auth: { method: 'session', actorId: READER_ID, sessionId: `session:${READER_ID}` }, now: NOW,
    })).rejects.toMatchObject({ reasonCode: 'payload_hash_mismatch' });
    const detailEvent = event({}, READER_ID);
    detailEvent.context.params = { id: proposal.id };
    const detail = await (proposalDetailHandler as unknown as Handler)(detailEvent);
    expect(detail.status).toBe('error');
    expect(detailEvent.node.res.statusCode).toBe(404);
    const list = await (listProposalsHandler as unknown as (input: RequestEvent) => Promise<{
      status: string; result: { proposals: { id: string }[] } | null;
    }>)(event({}, READER_ID));
    expect(list.status).toBe('ok');
    expect(list.result!.proposals.some((item) => item.id === proposal.id)).toBe(false);
  });

  it('binds a recursively nested leaf transaction without using its display merchant as identity', async () => {
    const child = structuredClone(transaction);
    child.id = 'nested-current-leaf';
    const middle = { ...structuredClone(transaction), id:'middle-aggregate',subtransactions:[child] };
    currentSnapshot.transactions = [{ ...structuredClone(transaction),id:'parent-aggregate',subtransactions:[middle] }];
    grantStandaloneProposal();
    grant('full-read','transaction',child.id);
    grant('full-read','account',child.accountId);
    const response = await createProposal(event({
      name:ruleName,payeeId:child.payeeId,categoryId:targetCategory.id,transactionId:child.id,
    }));
    expect(response.status).toBe('ok');
    const stored = await store.getProposal(response.result!.proposal.id);
    const preconditions = JSON.parse(stored!.preconditions) as Record<string, unknown>;
    expect(preconditions.transaction).toMatchObject({ id:child.id,payeeId:child.payeeId });
    expect(preconditions.reviewedSimulation).toMatchObject({ transactionsAffected:[child.id],transactionsMatched:1 });
  });

  it('binds an optional transaction to the current canonical transaction and matching merchant', async () => {
    grantTransactionProposal();
    const response = await createProposal(event({
      operation: 'create_rule',
      name: ruleName,
      payeeId: transaction.payeeId,
      categoryId: targetCategory.id,
      transactionId: transaction.id,
    }));

    expect(response.status).toBe('ok');
    const proposalView = response.result!.proposal;
    const stored = await store.getProposal(proposalView.id);
    if (!stored || stored.operation !== 'create_rule') throw new Error('Expected a native rule proposal');
    const preconditions = JSON.parse(stored.preconditions) as Record<string, unknown>;
    expect(stored.payload.transactionId).toBe(transaction.id);
    expect(stored.payload.rule.conditions).toEqual([
      { field: 'payee', op: 'is', value: transaction.payeeId },
    ]);
    expect(preconditions).toMatchObject({
      actualVersion: currentSnapshot.actualVersion,
      transaction: {
        id: transaction.id,
        accountId: transaction.accountId,
        categoryId: transaction.categoryId,
        payeeName: transaction.payeeName,
        amount: transaction.amount,
      },
    });
    expect(actualCreateRule).not.toHaveBeenCalled();
  });

  it.each([
    ['missing name', { payeeId: transaction.payeeId, categoryId: targetCategory.id }],
    ['missing payee ID', { name: ruleName, categoryId: targetCategory.id }],
    ['blank payee ID', { name: ruleName, payeeId: '   ', categoryId: targetCategory.id }],
    ['missing category', { name: ruleName, payeeId: transaction.payeeId }],
    ['unsupported operation', { name: ruleName, payeeId: transaction.payeeId, categoryId: targetCategory.id, operation: 'delete_rule' }],
    ['untrusted actor override', { name: ruleName, payeeId: transaction.payeeId, categoryId: targetCategory.id, actorId: 'forged-actor' }],
    ['legacy display-name rule', {name:ruleName,payee:transaction.payeeName,categoryId:targetCategory.id}],
    ['body source authority', {name:ruleName,payeeId:transaction.payeeId,categoryId:targetCategory.id,reviewContext:{sourceFactsHash:'forged'}}],
  ])('rejects %s before creating a proposal', async (_case, body) => {
    grantStandaloneProposal();
    const before = await proposalCount();
    const request = event(body);
    const response = await createProposal(request);

    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('INVALID_RULE_PROPOSAL');
    expect(request.node.res.statusCode).toBe(400);
    expect(await proposalCount()).toBe(before);
    expect(actualCreateRule).not.toHaveBeenCalled();
  });

  it('defaults the operation to create_rule and rejects ambiguous or mismatched transaction merchants', async () => {
    grantTransactionProposal();
    const before = await proposalCount();
    const mismatch = await createProposal(event({
      name: ruleName,
      payeeId: 'other-exact-payee-id',
      categoryId: targetCategory.id,
      transactionId: transaction.id,
    }));
    expect(mismatch.status).toBe('error');
    expect(await proposalCount()).toBe(before);

    currentSnapshot.transactions.push(structuredClone(transaction));
    const ambiguous = await createProposal(event({
      name: ruleName,
      payeeId: transaction.payeeId,
      categoryId: targetCategory.id,
      transactionId: transaction.id,
    }));
    expect(ambiguous.status).toBe('error');
    expect(await proposalCount()).toBe(before);
    expect(actualCreateRule).not.toHaveBeenCalled();
  });

  it('denies an exact target without its current proposal grant before opening the private SDK connection', async () => {
    grant('rule:propose', 'budget', budgetId);
    grant('existence', 'category', targetCategory.id);

    const response = await createProposal(event({
      name: ruleName,
      payeeId: transaction.payeeId,
      categoryId: targetCategory.id,
    }));

    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('FORBIDDEN');
    expect(withConnection).not.toHaveBeenCalled();
    expect(actualCreateRule).not.toHaveBeenCalled();
    expect(await proposalCount()).toBe(0);
  });

  it('rejects a foreign configured budget before restoring private SDK data', async () => {
    grantStandaloneProposal();
    loadConfig.mockResolvedValueOnce({ budgetId: 'foreign-budget' });

    const response = await createProposal(event({
      name: ruleName,
      payeeId: transaction.payeeId,
      categoryId: targetCategory.id,
    }));

    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('SPACE_CONNECTION_MISMATCH');
    expect(withConnection).not.toHaveBeenCalled();
    expect(actualCreateRule).not.toHaveBeenCalled();
    expect(await proposalCount()).toBe(0);
  });
});
