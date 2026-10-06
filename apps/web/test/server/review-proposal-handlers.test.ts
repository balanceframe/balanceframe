import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as H3 from 'h3';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import {
  GENERIC_MUTATION_POLICY_VERSION,
  canonicalProposalHash,
} from '@balanceframe/workflow-store';
import type { EventWithContext } from '../../server/utils/workflow-store';
import type { GenericActionProposal, GenericProposalOperation } from '@balanceframe/workflow-store';
import { getWorkflowStore } from '../../server/utils/workflow-store';
import fixture from '../../../../protocol/fixtures/representative.json';
import { createNativeRuleMutationProtocol, MerchantIntelligenceService } from '@balanceframe/application';
import type { RuleMutationPlan, RuleReviewContext, RuleSimulationResult } from '@balanceframe/application';
import { createRuleProposal } from '../../server/utils/rule-create';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import { merchantConnectionId } from '../../../../packages/application/src/merchant-service';
import { nativeReviewFixture } from './native-review.fixture';

import { completeNativeRuleSourceAvailability, grantNativeRuleSources, nativeRuleSource } from './native-rule-source.fixture';
const canonicalSnapshot = canonicalProtocolSnapshotSchema.parse(fixture);

const { loadConfig, connect } = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  connect: vi.fn(),
}));
vi.mock('h3', async (original) => ({
  ...(await original<typeof H3>()),
  readBody: async (event: { body: unknown }) => {
    if (event.body instanceof Error) throw event.body;
    return event.body;
  },
}));
vi.mock('@balanceframe/application', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createDefaultConnectionManager: () => ({ loadConfig, withConnection: connect }),
}));
vi.mock('@balanceframe/workflow-store', async () =>
  import('../../../../packages/workflow-store/src/index'));
import propose from '../../server/api/review/propose-rule.post';
import detail from '../../server/api/proposal/[id].get';

const OWNER_ID = 'review-proposal-owner';
const actorId = 'proposal-reader';
const now = '2026-08-01T12:00:00.000Z';
const expiresAt = '2026-08-02T12:00:00.000Z';
const transaction = fixture.transactions[0]!;
const currentPayee = canonicalSnapshot.payees.find((payee) => payee.id === transaction.payeeId)!;
const currentCategoryId = transaction.categoryId!;
const categoryId = fixture.transactions[1]!.categoryId!;
const RULE_ID = 'current-fixture-rule';
const ruleSnapshot = {
  id: RULE_ID,
  name: 'Current Actual rule',
  order: 3,
  trigger: [{ field: 'account', op: 'is', value: transaction.accountId }],
  actions: [{ op: 'set', field: 'category', value: currentCategoryId }],
  inactive: false,
  stage: 'pre' as const,
  conditionsOp: 'and' as const,
};
const signedAmount = BigInt(transaction.amount.minorUnits);
const amount = {
  minorUnits: (BigInt(transaction.amount.minorUnits) < 0n
    ? -BigInt(transaction.amount.minorUnits)
    : BigInt(transaction.amount.minorUnits)).toString(),
  currency: transaction.amount.currency,
};
const sourceTransaction = {
  id: transaction.id,
  accountId: transaction.accountId,
  categoryId: transaction.categoryId ?? null,
  direction: signedAmount < 0n ? 'outgoing' as const : 'incoming' as const,
  amount,
};
const baseComposite = {
  operations: [],
  reallocations: [],
  transferRecommendations: [],
  ledgerProjections: [],
  evidenceReferences: [],
};
let store: SqliteWorkflowStore;
let bootstrapped = false;
let fixtureSequence = 0;
let spaceId = '';
let budgetId = '';
let actorMembershipId = '';

interface TestResponse {
  statusCode: number;
  statusMessage: string;
  headersSent: boolean;
  setHeader(name: string, value: string | string[]): TestResponse;
  getHeader(name: string): string | string[] | undefined;
  removeHeader(name: string): void;
}
type RequestEvent = H3.H3Event & EventWithContext & { body: unknown };

function event(body: unknown = {}, id = '', requestActor = actorId): RequestEvent {
  const responseHeaders = new Map<string, string | string[]>();
  const response: TestResponse = {
    statusCode: 200,
    statusMessage: '',
    headersSent: false,
    setHeader(name, value) {
      responseHeaders.set(name.toLowerCase(), value);
      return response;
    },
    getHeader(name) {
      return responseHeaders.get(name.toLowerCase());
    },
    removeHeader(name) {
      responseHeaders.delete(name.toLowerCase());
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
      params: { id },
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

function grantTo(
  granteeId: string,
  membershipId: string,
  capability: string,
  resourceKind: 'budget' | 'account' | 'category' | 'rule' | 'transaction',
  resourceId: string,
) {
  store.governance.provisionResourceGrant({
    spaceId,
    actorId: granteeId,
    membershipId,
    budgetId,
    capability,
    resourceKind,
    resourceId,
    granted: true,
    now,
  });
}

function grant() {
  for (const capability of [
    'rule:propose',
    'categorization:propose',
    'observe',
    'full-read',
    'rule:approve',
    'categorization:approve',
  ])
    grantTo(actorId, actorMembershipId, capability, 'budget', budgetId);
  for (const [capability, kind, id] of [
    ['rule:propose', 'rule', RULE_ID],
    ['rule:propose', 'account', transaction.accountId],
    ['rule:propose', 'category', currentCategoryId],
    ['rule:propose', 'category', categoryId],
    ['rule:propose', 'transaction', transaction.id],
    ['categorization:propose', 'transaction', transaction.id],
    ['categorization:propose', 'account', transaction.accountId],
    ['categorization:propose', 'category', currentCategoryId],
    ['categorization:propose', 'category', categoryId],
  ] as const)
    grantTo(actorId, actorMembershipId, capability, kind, id);
  for (const capability of ['existence', 'history', 'name'])
    grantTo(actorId, actorMembershipId, capability, 'account', transaction.accountId);
  for (const id of new Set([currentCategoryId, categoryId])) {
    grantTo(actorId, actorMembershipId, 'existence', 'category', id);
    grantTo(actorId, actorMembershipId, 'name', 'category', id);
  }
  grantNativeRuleSources(store,{ spaceId,budgetId,actorId,membershipId:actorMembershipId,now },canonicalSnapshot);
  for (const a of canonicalSnapshot.accounts) grantTo(actorId,actorMembershipId,'rule:propose','account',a.id);
  for (const c of canonicalSnapshot.categories) grantTo(actorId,actorMembershipId,'rule:propose','category',c.id);
  const visit = (rows: typeof canonicalSnapshot.transactions) => {
    for (const t of rows) { grantTo(actorId,actorMembershipId,'rule:propose','transaction',t.id); visit(t.subtransactions); }
  };
  visit(canonicalSnapshot.transactions);
  for (const r of canonicalSnapshot.rules) grantTo(actorId,actorMembershipId,'rule:propose','rule',r.id);
}

async function addMember(memberId: string): Promise<string> {
  await store.upsertActorMembership(memberId, 'active', [], '');
  return store.governance.addMembership({
    spaceId,
    actorId: memberId,
    validFrom: now,
    now,
    auth: {
      method: 'human-session',
      actorId: OWNER_ID,
      sessionId: `session:${OWNER_ID}`,
      reauthenticatedAt: now,
    },
  }).id;
}

function grantRuleResources(granteeId: string, membershipId: string, capability: string) {
  grantTo(granteeId, membershipId, capability, 'budget', budgetId);
  for (const [kind, id] of [
    ['transaction', transaction.id],
    ['account', transaction.accountId],
    ['category', currentCategoryId],
    ['category', categoryId],
  ] as const)
    grantTo(granteeId, membershipId, capability, kind, id);
  for (const a of canonicalSnapshot.accounts) grantTo(granteeId,membershipId,capability,'account',a.id);
  for (const c of canonicalSnapshot.categories) grantTo(granteeId,membershipId,capability,'category',c.id);
  for (const r of canonicalSnapshot.rules) grantTo(granteeId,membershipId,capability,'rule',r.id);
  const visit = (rows: typeof canonicalSnapshot.transactions) => {
    for (const t of rows) { grantTo(granteeId,membershipId,capability,'transaction',t.id); visit(t.subtransactions); }
  };
  visit(canonicalSnapshot.transactions);
}

async function review(evidence: Record<string, unknown> = {}) {
  const discovered = await store.createReviewItem({
    transactionId: transaction.id,
    budgetId,
    categoryId: currentCategoryId,
    classifier: 'fixture',
    provenance: 'test',
    sourceTransaction,
    evidence,
  });
  const suggestion = await store.transitionInternalReviewItem(discovered.id, {
    toStatus: 'suggestion_generated',
    actor: actorId,
    expectedVersion: discovered.version,
  });
  return store.transitionInternalReviewItem(suggestion.id, {
    toStatus: 'pending_review',
    actor: actorId,
    expectedVersion: suggestion.version,
  });
}

async function proposal(
  preconditions: string | Record<string, unknown> = {},
  expiresAtValue = expiresAt,
  selectedBudget = budgetId,
  operation: GenericProposalOperation = 'set_category',
  selectedSpace = spaceId,
) {
  let payload: GenericActionProposal['payload'];
  let facts: Record<string, unknown>;
  const supplied = typeof preconditions === 'string'
    ? JSON.parse(preconditions) as Record<string, unknown>
    : preconditions;
  switch (operation) {
    case 'set_category':
      payload = {
        kind: 'set_category',
        transactionId: transaction.id,
        categoryId,
        composite: baseComposite,
      };
      facts = {
        ...supplied,
        transaction: {
          id: transaction.id,
          accountId: transaction.accountId,
          categoryId: currentCategoryId,
          direction: 'outgoing',
          amount,
          actualVersion: fixture.actualVersion,
        },
      };
      break;
    case 'create_rule':
      payload = {
        kind: 'create_rule',
        transactionId: null,
        categoryId,
        composite: baseComposite,
        rule: {
          stage: 'post', conditionsOp: 'and',
          conditions: [{ field: 'payee', op: 'is', value: transaction.payeeId }],
          actions: [{ op: 'set', field: 'category', value: categoryId }],
        },
      };
      facts = { ...supplied, ruleName: 'Merchant rule', actualVersion: fixture.actualVersion };
      break;
    case 'update_rule':
      payload = { kind: 'update_rule', ruleId: RULE_ID, inactive: true, composite: baseComposite };
      facts = {
        ...supplied,
        rule: ruleSnapshot,
        override: null,
        actualVersion: fixture.actualVersion,
        categoryGroupMembers: {},
      };
      break;
    case 'delete_rule':
      payload = { kind: 'delete_rule', ruleId: RULE_ID, composite: baseComposite };
      facts = {
        ...supplied,
        rule: ruleSnapshot,
        override: null,
        actualVersion: fixture.actualVersion,
        categoryGroupMembers: {},
      };
      break;
  }
  const auth = { method: 'session' as const, actorId, sessionId: `session:${actorId}` };
  return store.createProposal({
    operation,
    spaceId: selectedSpace,
    budgetId: selectedBudget,
    payload,
    payloadHash: canonicalProposalHash({
      operation,
      budgetId: selectedBudget,
      payload,
      preconditions: facts,
      actorId,
      policyVersion: GENERIC_MUTATION_POLICY_VERSION,
      expiresAt: expiresAtValue,
    }),
    policyVersion: GENERIC_MUTATION_POLICY_VERSION,
    preconditions: JSON.stringify(facts),
    expiresAt: expiresAtValue,
    actorId,
    auth,
    provenance: 'test',
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  vi.clearAllMocks();
  vi.stubEnv('BALANCEFRAME_SEED_ALLOWED', 'false');
  vi.stubEnv('BETTER_AUTH_URL', 'https://balanceframe.example.test');
  spaceId = '';
  budgetId = `review-proposal-budget-${++fixtureSequence}`;
  const provider = getWorkflowStore(event() as EventWithContext);
  if ('error' in provider) throw new Error(provider.error);
  store = provider.store;
  if (!bootstrapped) {
    await store.claimBootstrap({
      name: 'Review proposal owner',
      email: 'review-proposal-owner@example.test',
      claimId: 'review-proposal-handler-fixture',
    });
    await store.finalizeBootstrap({
      claimId: 'review-proposal-handler-fixture',
      ownerUserId: OWNER_ID,
    });
    bootstrapped = true;
  }
  const ownerAuth = {
    method: 'human-session' as const,
    actorId: OWNER_ID,
    sessionId: `session:${OWNER_ID}`,
    reauthenticatedAt: now,
  };
  const space = store.governance.createSpace({
    actorId: OWNER_ID,
    name: `Review proposal space ${fixtureSequence}`,
    kind: 'shared',
    now,
    auth: ownerAuth,
  });
  spaceId = space.id;
  store.governance.bindBudget({ spaceId, budgetId, now, auth: ownerAuth });
  if (!store.governance.getPolicy({ spaceId })) {
    store.governance.setPolicy({
      spaceId,
      expectedVersion: null,
      policy: { minimumApprovers: 1, approvalThresholds: [] },
      now,
      auth: ownerAuth,
    });
  }
  await store.upsertActorMembership(actorId, 'active', [], '');
  actorMembershipId = store.governance.addMembership({
    spaceId,
    actorId,
    validFrom: now,
    now,
    auth: ownerAuth,
  }).id;
  connect.mockImplementation(async (operation) => operation({
    config: { budgetId, serverUrl: 'https://actual.invalid' },
    budget: { id: budgetId },
    connector: { ...nativeRuleSource(() => canonicalSnapshot), synchronize: vi.fn(async () => ({
      snapshot: canonicalSnapshot, financialSnapshot: { legacySnapshot: canonicalSnapshot },
      rulePlanningSourceAvailability:completeNativeRuleSourceAvailability(canonicalSnapshot),
    })) },
    synchronization: {
      snapshot: canonicalSnapshot,
      rulePlanningSourceAvailability:completeNativeRuleSourceAvailability(canonicalSnapshot),
      financialSnapshot: {
        legacySnapshot: {
          accounts: canonicalSnapshot.accounts,
          categories: canonicalSnapshot.categories,
          transactions: canonicalSnapshot.transactions,
        },
      },
      },
  }));
  loadConfig.mockResolvedValue({
    version: 1,
    budgetId,
    serverUrl: 'https://actual.invalid',
    budgetName: 'Fixture',
    groupId: 'fixture-group',
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
afterAll(() => store.close());

describe('review proposal creation and detail', () => {
  it('rechecks private Review rule proposal fields after the final configuration await revokes only full-read', async () => {
    grant();
    const item = await review();
    const createProposal = store.createProposal.bind(store);
    let published = false;
    vi.spyOn(store, 'createProposal').mockImplementation(async (input) => {
      const proposal = await createProposal(input);
      published = true;
      return proposal;
    });
    loadConfig.mockImplementation(async () => {
      if (published) store.governance.provisionResourceGrant({
        spaceId, budgetId, actorId, membershipId: actorMembershipId, capability: 'full-read',
        resourceKind: 'budget', resourceId: budgetId, granted: false, now,
      });
      return { version: 1, budgetId, serverUrl: 'https://actual.invalid', budgetName: 'Fixture', groupId: 'fixture-group' };
    });
    const response = await propose(event({ reviewId: item.id, categoryId }));
    for (const capability of ['rule:propose', 'source', 'observe'])
      expect(store.liquidity.isAuthorized({
        actorId, budgetId, spaceId, membershipId: actorMembershipId, now,
        governancePolicyVersion: store.governance.getPolicy({ spaceId })!.version,
        auth: { method: 'session', actorId, sessionId: `session:${actorId}` },
        resourceKind: 'budget', resourceId: budgetId, capability,
      })).toBe(true);
    expect((await store.getReviewItem(item.id))?.version).toBe(item.version);
    expect(store.liquidity.isAuthorized({
      actorId, budgetId, spaceId, membershipId: actorMembershipId, now,
      governancePolicyVersion: store.governance.getPolicy({ spaceId })!.version,
      auth: { method: 'session', actorId, sessionId: `session:${actorId}` },
      resourceKind: 'budget', resourceId: budgetId, capability: 'full-read',
    })).toBe(false);
    expect(response.result?.proposal.payload ?? null).toBeNull();
    expect(response.result?.proposal.preconditions ?? null).toBeNull();
  });

  it.each(['stale-version', 'missing-version', 'missing-revision', 'rebound-revision', 'foreign-connection'] as const)('direct Review rule factory refuses %s immutable capture rather than borrowing live facts', async (state) => {
    grant();
    const publication: { authorize?: () => boolean } = {};
    const resolve = MerchantIntelligenceService.prototype.getCurrentRuleReviewContext;
    vi.spyOn(MerchantIntelligenceService.prototype, 'getCurrentRuleReviewContext')
      .mockImplementation(function (this: MerchantIntelligenceService, actor, input) {
        return resolve.call(this, actor, { ...input, capturePublicationAuthority: (authorize) => {
          publication.authorize = authorize;
          input.capturePublicationAuthority?.(authorize);
        } });
      });
    const item = await nativeReviewFixture(store, {
      scope: { spaceId, budgetId, connectionId: merchantConnectionId({ budgetId, serverUrl: 'https://actual.invalid' }) },
      transaction: canonicalSnapshot.transactions.find((row) => row.id === transaction.id)!, categoryId: currentCategoryId,
    });
    const response = await propose(event({ reviewId: item.id, categoryId }));
    expect(response.status).toBe('ok');
    const stored = await store.getProposal(response.result!.proposal.id);
    if (!stored) throw new Error('Canonical native rule proposal unavailable');
    const facts = JSON.parse(stored.preconditions) as {
      nativePlan: RuleMutationPlan; reviewContext: RuleReviewContext; reviewedSimulation: RuleSimulationResult;
    };
    const captured = { ...item, evidence: { ...item.evidence } };
    if (state === 'stale-version') store['db'].prepare('UPDATE review_items SET version=version+1 WHERE id=?').run(item.id);
    if (state === 'missing-version') Reflect.deleteProperty(captured, 'version');
    if (state === 'missing-revision') delete captured.evidence.sourceRevision;
    if (state === 'rebound-revision') captured.evidence.sourceRevision = 'unreviewed-source-revision';
    if (state === 'foreign-connection') {
      const foreign = await nativeReviewFixture(store, {
        scope: { spaceId, budgetId, connectionId: merchantConnectionId({ budgetId, serverUrl: 'https://actual.other.test' }) },
        transaction: canonicalSnapshot.transactions.find((row) => row.id === transaction.id)!, categoryId: currentCategoryId,
      });
      Object.assign(captured, foreign);
    }
    const input = {
      store, spaceId, budgetId, actorId, auth: { method: 'session' as const, actorId, sessionId: 'factory-native-session' },
      correlationId: 'immutable-native-factory', expiresAt: facts.reviewContext.expiresAt,
      name: `Auto-rule for ${canonicalSnapshot.payees.find((row) => row.id === transaction.payeeId)!.name}`,
      payeeId: transaction.payeeId!, categoryId,
      transaction: canonicalSnapshot.transactions.find((row) => row.id === transaction.id)!,
      nativePlan: facts.nativePlan, currentContext: facts.reviewContext, reviewedSimulation: facts.reviewedSimulation,
      snapshot: canonicalSnapshot, origin: { kind: 'review' as const, review: captured },
      assertPublicationCurrent: () => {
        if (!publication.authorize?.()) throw new Error('Captured native source authority is unavailable');
      },
    };
    const proposals = (await store.listProposals()).map((proposal) => proposal.id);
    await expect(createRuleProposal(input)).rejects.toThrow();
    expect((await store.listProposals()).map((proposal) => proposal.id)).toEqual(proposals);
  });

  it.each(['wrong-connection', 'wrong-space', 'historical', 'missing', 'malformed'] as const)('rule proposal refuses %s native Review provenance before source capture', async (source) => {
    grant();
    const selectedConnection = merchantConnectionId({ budgetId, serverUrl: 'https://actual.invalid' });
    const nativeSource = nativeRuleSource(() => canonicalSnapshot);
    const synchronize = vi.fn(async () => ({
      snapshot: canonicalSnapshot, financialSnapshot: { legacySnapshot: canonicalSnapshot },
      rulePlanningSourceAvailability: completeNativeRuleSourceAvailability(canonicalSnapshot),
    }));
    connect.mockImplementation(async (operation) => operation({
      config: { budgetId, serverUrl: 'https://actual.invalid' }, budget: { id: budgetId }, connector: { ...nativeSource, synchronize },
      synchronization: {
        snapshot: canonicalSnapshot, financialSnapshot: { legacySnapshot: canonicalSnapshot },
        rulePlanningSourceAvailability: completeNativeRuleSourceAvailability(canonicalSnapshot),
      },
    }));
    const selectedSpace = source === 'wrong-space'
      ? store.governance.createSpace({ actorId: OWNER_ID, name: 'Other native proposal namespace', kind: 'shared', now,
        auth: { method: 'human-session', actorId: OWNER_ID, sessionId: `session:${OWNER_ID}`, reauthenticatedAt: now } }).id
      : spaceId;
    const item = await nativeReviewFixture(store, {
      scope: { spaceId: selectedSpace, budgetId, connectionId: source === 'wrong-connection'
        ? merchantConnectionId({ budgetId, serverUrl: 'https://actual.other.test' }) : selectedConnection },
      transaction: canonicalSnapshot.transactions.find((row) => row.id === transaction.id)!, categoryId: currentCategoryId,
      ...(source === 'historical' ? { historicalStatus: 'skipped' as const } : {}),
      ...(source === 'missing' || source === 'malformed' ? { invalidReference: source } : {}),
    });
    const proposals = (await store.listProposals()).map((proposal) => proposal.id);
    const response = await propose(event({ reviewId: item.id, categoryId }));
    expect(response.status).toBe('error');
    expect((await store.listProposals()).map((proposal) => proposal.id)).toEqual(proposals);
    expect(await store.getReviewItem(item.id)).toEqual(item);
    expect(synchronize).not.toHaveBeenCalled();
    expect(nativeSource.captureMerchantSource).not.toHaveBeenCalled();
    if (source !== 'wrong-connection') expect(connect).not.toHaveBeenCalled();
  });

  it('can propose a rule from native Review bound to the exact selected source namespace', async () => {
    grant();
    const item = await nativeReviewFixture(store, {
      scope: { spaceId, budgetId, connectionId: merchantConnectionId({ budgetId, serverUrl: 'https://actual.invalid' }) },
      transaction: canonicalSnapshot.transactions.find((row) => row.id === transaction.id)!, categoryId: currentCategoryId,
    });
    const response = await propose(event({ reviewId: item.id, categoryId }));
    expect(response.status).toBe('ok');
    expect((await store.getProposal(response.result!.proposal.id))?.preconditions).toContain(item.id);
    expect((await store.getReviewItem(item.id))?.status).toBe('pending_review');
  });

  it.each(['missing','failed-rules'] as const)('refuses Review proposal creation for %s trusted SDK availability', async (failure) => {
    grant();
    const item = await review();
    const availability = completeNativeRuleSourceAvailability(canonicalSnapshot);
    availability.rules = 'unavailable';
    const sdk = {
      snapshot:canonicalSnapshot,financialSnapshot:{legacySnapshot:canonicalSnapshot},
      ...(failure === 'missing' ? {} : {rulePlanningSourceAvailability:availability}),
    };
    connect.mockImplementationOnce(async (operation) => operation({
      config:{budgetId,serverUrl:'https://actual.invalid'},budget:{id:budgetId},
      connector:{...nativeRuleSource(() => canonicalSnapshot),synchronize:vi.fn(async () => sdk)},
      synchronization:sdk,
    }));
    const response = await propose(event({reviewId:item.id,categoryId}));
    expect(response.status).toBe('error');
    expect(await store.countProposals({budgetId,operations:['create_rule']})).toBe(0);
  });

  it('binds the exact stable-ID payload and complete reviewed simulation rather than a merchant label', async () => {
    grant();
    const item = await review({normalizedMerchant:'UNTRUSTED QUEUE DISPLAY',payeeName:'Untrusted stale payee label'});
    const response = await propose(event({ reviewId: item.id, categoryId }));
    expect(response.status).toBe('ok');
    const stored = await store.getProposal(response.result!.proposal.id);
    const preconditions = JSON.parse(stored!.preconditions) as Record<string, unknown>;
    expect(preconditions.nativeRule).toEqual({
      stage: 'post', conditionsOp: 'and',
      conditions: [{ field: 'payee', op: 'is', value: transaction.payeeId }],
      actions: [{ op: 'set', field: 'category', value: categoryId }],
    });
    expect(preconditions.ruleName).toBe(`Auto-rule for ${currentPayee.name}`);
    expect(preconditions.ruleName).not.toContain('UNTRUSTED QUEUE DISPLAY');
    expect(preconditions.ruleName).not.toContain(transaction.payeeName);
    expect(preconditions.reviewContext).toMatchObject({
      scope: { spaceId, budgetId }, evidenceKey: null,
    });
    const native = await createNativeRuleMutationProtocol();
    expect(preconditions.reviewedSimulation).toEqual(native.simulateCreateRulePlan(
      preconditions.nativePlan as Parameters<typeof native.simulateCreateRulePlan>[0], canonicalSnapshot,
    ));
    expect(preconditions.sourceTransactions).toEqual(canonicalSnapshot.transactions);
    expect(response.result!.simulationStatus).toBe('present');
  });

  it('does not replace a merchant-linked missing current evidence record with direct-settings null authority', async () => {
    grant();
    const key = `merchant:transaction:${transaction.id}`;
    for (const capability of ['evidence','normalized-evidence','source'])
      store.governance.provisionResourceGrant({spaceId,budgetId,actorId,membershipId:actorMembershipId,resourceKind:'evidence',resourceId:key,capability,granted:true,now});
    const item = await review({merchantEvidence:{evidenceKey:key}});
    const response = await propose(event({reviewId:item.id,categoryId}));
    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('PROPOSAL_UNAVAILABLE');
    expect(await store.countProposals({budgetId,operations:['create_rule']})).toBe(0);
  });

  it('creates a current native rule proposal from an authorized pending review', async () => {
    grant();
    const item = await review();
    const name = `Auto-rule for ${currentPayee.name}`;
    const native = await createNativeRuleMutationProtocol();
    const response = await propose(event({ reviewId: item.id, categoryId }));
    expect(response.error).toBeNull();
    expect(response.status).toBe('ok');
    expect(response.result!.simulationStatus).toBe('present');

    const id = response.result!.proposal.id;
    const stored = await store.getProposal(id);
    const preconditions = JSON.parse(stored!.preconditions) as Record<string, unknown>;
    const nativePlan = native.planCreateRule({
      name, budgetId, stage: 'post', conditionsOp: 'and',
      conditions: [{ field: 'payee', op: 'is', value: transaction.payeeId! }],
      actions: [{ op: 'set', field: 'category', value: categoryId }],
      reviewContext: preconditions.reviewContext as Parameters<typeof native.planCreateRule>[0]['reviewContext'],
    }, canonicalSnapshot);
    expect(stored).toMatchObject({
      operation: 'create_rule',
      actorId,
      budgetId,
      provenance: 'review-action',
      policyVersion: GENERIC_MUTATION_POLICY_VERSION,
      payload: {
        kind: 'create_rule',
        transactionId: transaction.id,
        categoryId,
        composite: { ...baseComposite, nativePayloadHash: nativePlan.hash },
        rule: {
          stage: 'post', conditionsOp: 'and',
          conditions: [{ field: 'payee', op: 'is', value: transaction.payeeId }],
          actions: [{ op: 'set', field: 'category', value: categoryId }],
        },
      },
    });
    expect(preconditions).toMatchObject({
      source: 'review',
      reviewId: item.id,
      actualVersion: canonicalSnapshot.actualVersion,
      transaction: {
        id: transaction.id,
        accountId: transaction.accountId,
        categoryId: currentCategoryId,
        payeeName: transaction.payeeName,
        amount: transaction.amount,
      },
      nativeRule: {
        stage: 'post',
        conditionsOp: 'and',
        conditions: [{ field: 'payee', op: 'is', value: transaction.payeeId }],
        actions: [{ op: 'set', field: 'category', value: categoryId }],
      },
      nativePlan,
    });
    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith(expect.any(Function), {
      expectedBudgetId: budgetId,
      dispose: true,
      synchronize: false,
    });

    const shown = await detail(event({}, id));
    expect(shown.status).toBe('ok');
    expect(shown.result!.proposal).toMatchObject({
      id,
      operation: 'create_rule',
      payload: stored!.payload,
      preconditions,
    });
  });

  it('denies a zero-count rule proposal before config or SDK access', async () => {
    const item = await review();
    store.governance.provisionResourceGrant({
      spaceId,
      actorId,
      membershipId: actorMembershipId,
      budgetId,
      capability: 'rule:propose',
      resourceKind: 'budget',
      resourceId: budgetId,
      granted: true,
      restrictions: { maxOperationCount: 0 },
      now,
    });
    for (const [kind, id] of [
      ['transaction', transaction.id],
      ['account', transaction.accountId],
      ['category', currentCategoryId],
      ['category', categoryId],
    ] as const)
      grantTo(actorId, actorMembershipId, 'rule:propose', kind, id);
    grantTo(actorId, actorMembershipId, 'existence', 'account', transaction.accountId);
    grantTo(actorId, actorMembershipId, 'history', 'account', transaction.accountId);
    for (const id of new Set([currentCategoryId, categoryId])) {
      grantTo(actorId, actorMembershipId, 'existence', 'category', id);
      grantTo(actorId, actorMembershipId, 'name', 'category', id);
    }
    const before = (await store.listProposals()).map(({ id }) => id).sort();
    const request = event({ reviewId: item.id, categoryId });
    const response = await propose(request);

    expect(request.node.res.statusCode).toBe(404);
    expect(response.error?.code).toBe('REVIEW_NOT_FOUND');
    expect(loadConfig).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect((await store.listProposals()).map(({ id }) => id).sort()).toEqual(before);
  });

  it('conceals private source rule proposals like unknown IDs before config or SDK access', async () => {
    const item = await review();
    grantTo(actorId, actorMembershipId, 'rule:propose', 'budget', budgetId);
    grantTo(actorId, actorMembershipId, 'rule:propose', 'category', categoryId);
    grantTo(actorId, actorMembershipId, 'existence', 'account', transaction.accountId);
    grantTo(actorId, actorMembershipId, 'history', 'account', transaction.accountId);
    for (const id of new Set([currentCategoryId, categoryId])) {
      grantTo(actorId, actorMembershipId, 'existence', 'category', id);
      grantTo(actorId, actorMembershipId, 'name', 'category', id);
    }
    const before = (await store.listProposals()).map(({ id }) => id).sort();
    const inaccessibleEvent = event({ reviewId: item.id, categoryId });
    const inaccessible = await propose(inaccessibleEvent);
    const unknownEvent = event({ reviewId: 'review-item-that-does-not-exist', categoryId });
    const unknown = await propose(unknownEvent);

    expect({
      status: inaccessibleEvent.node.res.statusCode,
      code: inaccessible.error?.code,
      message: inaccessible.error?.message,
      authorization: inaccessible.authorization,
    }).toEqual({
      status: unknownEvent.node.res.statusCode,
      code: unknown.error?.code,
      message: unknown.error?.message,
      authorization: unknown.authorization,
    });
    expect(inaccessibleEvent.node.res.statusCode).toBe(404);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect((await store.listProposals()).map(({ id }) => id).sort()).toEqual(before);
  });

  it('rechecks review rule source rights for private reads, approvals, and execution acquisition', async () => {
    grant();
    const item = await review();
    const response = await propose(event({ reviewId: item.id, categoryId }));
    expect(response.status).toBe('ok');
    const proposal = await store.getProposal(response.result!.proposal.id);
    if (!proposal || proposal.operation !== 'create_rule' || !proposal.governancePolicyVersion)
      throw new Error('Expected a governed native rule proposal');

    const readerId = 'category-only-rule-reader';
    const readerMembershipId = await addMember(readerId);
    grantRuleResources(readerId, readerMembershipId, 'rule:approve');
    grantTo(readerId, readerMembershipId, 'full-read', 'category', categoryId);
    const readerView = await detail(event({}, proposal.id, readerId));
    expect(readerView.status).toBe('ok');
    expect(readerView.result!.proposal).toMatchObject({
      privateEnvelopeVisible: false,
      payload: null,
      preconditions: null,
    });
    expect(JSON.stringify(readerView.result!.proposal)).not.toContain(transaction.payeeName);

    const approvalAuth = {
      method: 'human-session' as const,
      actorId: readerId,
      sessionId: `session:${readerId}`,
      reauthenticatedAt: now,
    };
    await store.createApproval({
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      actorId: readerId,
      expiresAt: proposal.expiresAt,
      auth: approvalAuth,
      now,
    });

    const revokedAt = new Date(Date.parse(now) + 1000).toISOString();
    vi.setSystemTime(new Date(revokedAt));
    store.governance.setResourceGrant({
      spaceId,
      actorId: readerId,
      membershipId: readerMembershipId,
      budgetId,
      capability: 'rule:approve',
      resourceKind: 'transaction',
      resourceId: transaction.id,
      granted: false,
      now: revokedAt,
      auth: {
        method: 'human-session',
        actorId: OWNER_ID,
        sessionId: `session:${OWNER_ID}`,
        reauthenticatedAt: revokedAt,
      },
    });
    await expect(store.createApproval({
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      actorId: readerId,
      expiresAt: proposal.expiresAt,
      auth: { ...approvalAuth, reauthenticatedAt: revokedAt },
      now: revokedAt,
    })).rejects.toThrow();
    expect((await detail(event({}, proposal.id, readerId))).status).toBe('error');

    const approverId = 'current-rule-approver';
    const approverMembershipId = await addMember(approverId);
    grantRuleResources(approverId, approverMembershipId, 'rule:approve');
    await store.createApproval({
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      actorId: approverId,
      expiresAt: proposal.expiresAt,
      auth: {
        method: 'human-session',
        actorId: approverId,
        sessionId: `session:${approverId}`,
        reauthenticatedAt: revokedAt,
      },
      now: revokedAt,
    });

    const executorId = 'source-right-rule-executor';
    const executorMembershipId = await addMember(executorId);
    grantRuleResources(executorId, executorMembershipId, 'rule:execute');
    const executionRevokedAt = new Date(Date.parse(revokedAt) + 1000).toISOString();
    vi.setSystemTime(new Date(executionRevokedAt));
    store.governance.setResourceGrant({
      spaceId,
      actorId: executorId,
      membershipId: executorMembershipId,
      budgetId,
      capability: 'rule:execute',
      resourceKind: 'transaction',
      resourceId: transaction.id,
      granted: false,
      now: executionRevokedAt,
      auth: {
        method: 'human-session',
        actorId: OWNER_ID,
        sessionId: `session:${OWNER_ID}`,
        reauthenticatedAt: executionRevokedAt,
      },
    });
    await expect(store.acquireProposalExecution({
      actorId: executorId,
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      governancePolicyVersion: proposal.governancePolicyVersion,
      idempotencyKey: `review-rule-execution-${fixtureSequence}`,
      serialisedEffect: JSON.stringify({
        operation: proposal.operation,
        payload: proposal.payload,
        preconditions: JSON.parse(proposal.preconditions),
      }),
      auth: {
        method: 'human-session',
        actorId: executorId,
        sessionId: `session:${executorId}`,
        reauthenticatedAt: executionRevokedAt,
      },
      now: executionRevokedAt,
    })).rejects.toThrow();
  });

  it.each([
    'set_category',
    'create_rule',
    'update_rule',
    'delete_rule',
  ] as const)('returns the exact %s proposal in its authorized detail view', async (operation) => {
    grant();
    const created = await proposal({}, expiresAt, budgetId, operation);
    const response = await detail(event({}, created.id));

    expect(response.status).toBe('ok');
    expect(response.result!.proposal).toMatchObject({
      id: created.id,
      operation,
      payload: created.payload,
      payloadHash: created.payloadHash,
      preconditions: JSON.parse(created.preconditions),
      requesterActorId: actorId,
      requesterMembershipCurrent: true,
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects a stale selected-space membership before reading proposal data', async () => {
    grant();
    const created = await proposal();
    const read = vi.spyOn(store, 'getProposal');
    const revokedAt = new Date(Date.parse(now) + 1000).toISOString();
    store.governance.revokeMembership({
      spaceId,
      membershipId: actorMembershipId,
      now: revokedAt,
      auth: {
        method: 'human-session',
        actorId: OWNER_ID,
        sessionId: `session:${OWNER_ID}`,
        reauthenticatedAt: revokedAt,
      },
    });
    vi.setSystemTime(new Date(revokedAt));

    const denied = await detail(event({}, created.id));
    expect(denied.status).not.toBe('ok');
    expect(denied.result).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects malformed and unknown review submissions without creating proposals', async () => {
    grant();
    const before = (await store.listProposals()).map(({ id }) => id).sort();
    const malformed = event({ reviewId: '  ', categoryId });
    expect((await propose(malformed)).error?.code).toBe('INVALID_RULE_PROPOSAL');
    expect(malformed.node.res.statusCode).toBe(400);

    const missing = event({ reviewId: 'not-a-review', categoryId });
    expect((await propose(missing)).error?.code).toBe('REVIEW_NOT_FOUND');
    expect(missing.node.res.statusCode).toBe(404);
    expect((await store.listProposals()).map(({ id }) => id).sort()).toEqual(before);
  });
});
