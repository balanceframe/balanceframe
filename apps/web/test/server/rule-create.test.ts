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
import fixture from '../../../../protocol/fixtures/representative.json';
import type { EventWithContext } from '../../server/utils/workflow-store';
import { getWorkflowStore } from '../../server/utils/workflow-store';

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
const connector = { createRule: actualCreateRule };

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

  loadConfig.mockResolvedValue({ budgetId });
  withConnection.mockImplementation(async (operation) => operation({
    config: { budgetId },
    budget: { id: budgetId },
    connector,
    synchronization: { snapshot: currentSnapshot },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
afterAll(() => store.close());

describe('POST /api/rule', () => {
  it('creates an action-only redacted native proposal for a caller-named rule without a review item', async () => {
    grantStandaloneProposal({
      proposalOnly: true,
      operations: ['create_rule'],
      categoryIds: [targetCategory.id],
    });

    const body = {
      name: ruleName,
      payee: transaction.payeeName,
      categoryId: targetCategory.id,
    };
    const response = await createProposal(event(body));

    expect(response.status).toBe('ok');
    expect(withConnection).toHaveBeenCalledWith(expect.any(Function), {
      expectedBudgetId: budgetId,
      dispose: true,
    });
    const proposalView = response.result!.proposal;
    expect(proposalView).toMatchObject({
      privateEnvelopeVisible: false,
      payload: null,
      preconditions: null,
    });
    const stored = await store.getProposal(proposalView.id);
    if (!stored || stored.operation !== 'create_rule') throw new Error('Expected a native rule proposal');
    const ruleProposal: GenericActionProposal & { operation: 'create_rule' } = stored;
    const preconditions = JSON.parse(ruleProposal.preconditions) as Record<string, unknown>;
    const native = await createNativeRuleMutationProtocol();
    const expectedRule = {
      name: ruleName,
      conditionsOp: 'and',
      conditions: [{ field: 'payee_name', op: 'is', value: transaction.payeeName }],
      actions: [{ type: 'set-category', field: 'category', value: targetCategory.id }],
    };
    const nativePlan = native.planCreateRule({
      name: ruleName,
      conditions: expectedRule.conditions,
      actions: expectedRule.actions,
      budgetId,
      conditionsOp: 'and',
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
      categoryIds: [targetCategory.id],
    });
    grant('full-read', 'budget', budgetId);

    const response = await createProposal(event({
      name: ruleName,
      payee: transaction.payeeName,
      categoryId: targetCategory.id,
    }));

    expect(response.status).toBe('ok');
    const proposalView = response.result!.proposal;
    expect(proposalView).toMatchObject({
      privateEnvelopeVisible: true,
      payload: { kind: 'create_rule', categoryId: targetCategory.id, rule: { name: ruleName } },
      preconditions: {
        actualVersion: currentSnapshot.actualVersion,
        nativeRule: { name: ruleName },
      },
    });
    const stored = await store.getProposal(proposalView.id);
    if (!stored || stored.operation !== 'create_rule') throw new Error('Expected a native rule proposal');
    expect(proposalView.payload).toEqual(stored.payload);
    expect(proposalView.preconditions).toEqual(JSON.parse(stored.preconditions));
  });

  it('binds an optional transaction to the current canonical transaction and matching merchant', async () => {
    grantTransactionProposal();
    const response = await createProposal(event({
      operation: 'create_rule',
      name: ruleName,
      payee: transaction.payeeName,
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
      { field: 'payee_name', op: 'is', value: transaction.payeeName },
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
    ['missing name', { payee: 'Whole Foods', categoryId: targetCategory.id }],
    ['missing merchant', { name: ruleName, categoryId: targetCategory.id }],
    ['blank merchant', { name: ruleName, payee: '   ', categoryId: targetCategory.id }],
    ['missing category', { name: ruleName, payee: 'Whole Foods' }],
    ['unsupported operation', { name: ruleName, payee: 'Whole Foods', categoryId: targetCategory.id, operation: 'delete_rule' }],
    ['untrusted actor override', { name: ruleName, payee: 'Whole Foods', categoryId: targetCategory.id, actorId: 'forged-actor' }],
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
      payee: 'Shell Gas Station',
      categoryId: targetCategory.id,
      transactionId: transaction.id,
    }));
    expect(mismatch.status).toBe('error');
    expect(await proposalCount()).toBe(before);

    currentSnapshot.transactions.push(structuredClone(transaction));
    const ambiguous = await createProposal(event({
      name: ruleName,
      payee: transaction.payeeName,
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
      payee: transaction.payeeName,
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
      payee: transaction.payeeName,
      categoryId: targetCategory.id,
    }));

    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('SPACE_CONNECTION_MISMATCH');
    expect(withConnection).not.toHaveBeenCalled();
    expect(actualCreateRule).not.toHaveBeenCalled();
    expect(await proposalCount()).toBe(0);
  });
});
