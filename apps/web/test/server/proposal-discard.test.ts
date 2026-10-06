import type * as H3 from 'h3';
import type { EventWithContext } from '../../server/utils/workflow-store';
import type { GenericActionProposal, GenericProposalOperation, GovernanceResourceKind } from '@balanceframe/workflow-store';
import type { ReauthenticationEvent } from '../../server/utils/reauthentication';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteWorkflowStore, GENERIC_MUTATION_POLICY_VERSION, canonicalProposalHash, deriveProposalAuthorizationFacts } from '@balanceframe/workflow-store';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import fixture from '../../../../protocol/fixtures/representative.json';
import { getWorkflowStore } from '../../server/utils/workflow-store';
import { getHumanControlAuth, issueReauthentication, REAUTH_COOKIE_NAME } from '../../server/utils/reauthentication';
import handler from '../../server/api/proposal/[id]/discard.post';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  verifyPassword: vi.fn(),
}));

vi.mock('better-auth/node', () => ({
  fromNodeHeaders: (headers: ConstructorParameters<typeof Headers>[0]) => new Headers(headers),
}));
vi.mock('../../lib/auth', () => ({
  auth: { api: { getSession: mocks.getSession, verifyPassword: mocks.verifyPassword } },
}));
vi.mock('@balanceframe/workflow-store', async () =>
  import('../../../../packages/workflow-store/src/index'));


const OWNER_ID = 'proposal-discard-owner';
const PROPOSER_ID = 'discard-proposer';
const ACTOR_ID = 'discard-actor';
const SESSION_ID = `session:${ACTOR_ID}`;
const ORIGIN = 'https://balanceframe.example.test';
const NOW = '2098-01-01T12:00:00.000Z';
const EXPIRES_AT = '2099-01-01T00:00:00.000Z';
const snapshot = canonicalProtocolSnapshotSchema.parse(fixture);
const ACCOUNT_ID = snapshot.transactions[0]!.accountId;
const TRANSACTION_ID = snapshot.transactions[0]!.id;
const CATEGORY_ID = snapshot.transactions[0]!.categoryId!;
const RULE_ID = 'discard-rule';
const GROUP_ID = 'discard-group';
const GROUP_CATEGORY_ID = 'discard-group-category';
const COMPOSITE = {
  operations: [],
  reallocations: [],
  transferRecommendations: [],
  ledgerProjections: [],
  evidenceReferences: [],
};
const RULE_SNAPSHOT = {
  id: RULE_ID,
  name: 'Current Actual rule',
  order: 3,
  trigger: [
    { field: 'account', op: 'is', value: ACCOUNT_ID },
    { field: 'category', op: 'is', value: CATEGORY_ID },
    { field: 'category_group', op: 'is', value: GROUP_ID },
  ],
  actions: [{ op: 'set', field: 'category', value: GROUP_CATEGORY_ID }],
  inactive: false,
  stage: 'pre' as const,
  conditionsOp: 'or' as const,
};
const NATIVE_RULE = {
  stage: 'post',
  conditionsOp: 'and',
  conditions: [{ field: 'payee', op: 'is', type: 'id', value: snapshot.transactions[0]!.payeeId! }],
  actions: [{ op: 'set', field: 'category', value: CATEGORY_ID }],
};

interface TestResponse {
  statusCode: number;
  statusMessage: string;
  headersSent: boolean;
  setHeader(name: string, value: string | string[]): TestResponse;
  getHeader(name: string): string | string[] | undefined;
  removeHeader(name: string): void;
}
type RequestEvent = H3.H3Event & EventWithContext & { body: unknown };

let store: SqliteWorkflowStore;
let bootstrapped = false;
let sequence = 0;
let spaceId = '';
let budgetId = '';
let proposerMembershipId = '';
let actorMembershipId = '';
let proofCookie: string | null = null;

function makeEvent(
  id = '',
  options: { proof?: boolean; authenticated?: boolean; includeSpace?: boolean } = {},
): RequestEvent {
  const responseHeaders = new Map<string, string | string[]>();
  const cookie = [
    'better-auth.session_token=authoritative-session-cookie',
    ...(options.proof === false || !proofCookie ? [] : [`${REAUTH_COOKIE_NAME}=${proofCookie}`]),
  ].join('; ');
  const headers = {
    cookie,
    origin: ORIGIN,
    ...(options.includeSpace === false ? {} : { 'x-balanceframe-space': spaceId }),
  };
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
    node: { req: { headers }, res: response },
    context: {
      params: { id },
      auth: {
        authenticated: options.authenticated ?? true,
        actorId: ACTOR_ID,
        method: 'session',
        principalType: 'human',
        sessionId: SESSION_ID,
        user: { id: ACTOR_ID },
      },
      runtimeConfig: { workflowDbPath: ':memory:', devBypassAuth: false },
    },
  } as unknown as RequestEvent;
}

function grant(
  actorId: string,
  membershipId: string,
  capability: string,
  resourceKind: GovernanceResourceKind,
  resourceId: string,
  grantSpace = spaceId,
  grantBudget = budgetId,
  restrictions: { operations?: readonly string[] } = {},
) {
  store.governance.provisionResourceGrant({
    spaceId: grantSpace,
    actorId,
    membershipId,
    budgetId: grantBudget,
    capability,
    resourceKind,
    resourceId,
    restrictions,
    granted: true,
    now: NOW,
  });
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
          transactionId: TRANSACTION_ID,
          categoryId: CATEGORY_ID,
          composite: COMPOSITE,
        },
        preconditions: {
          transaction: {
            id: TRANSACTION_ID,
            accountId: ACCOUNT_ID,
            categoryId: null,
            direction: 'outgoing',
            amount: { minorUnits: '4250', currency: 'USD' },
            actualVersion: 'actual-discard-v1',
          },
        },
      };
    case 'create_rule':
      return {
        payload: {
          kind: 'create_rule',
          transactionId: null,
          categoryId: CATEGORY_ID,
          composite: COMPOSITE,
          rule: NATIVE_RULE,
        },
        preconditions: {
          actualVersion: snapshot.actualVersion,
          nativeRule: NATIVE_RULE,
          sourceAccounts: snapshot.accounts,
          sourceTransactions: snapshot.transactions,
          nativeImpact: { payees: snapshot.payees, categories: snapshot.categories, rules: snapshot.rules },
        },
      };
    case 'update_rule':
      return {
        payload: { kind: 'update_rule', ruleId: RULE_ID, inactive: true, composite: COMPOSITE },
        preconditions: {
          rule: RULE_SNAPSHOT,
          override: null,
          actualVersion: 'actual-discard-v1',
          categoryGroupMembers: { [GROUP_ID]: [GROUP_CATEGORY_ID] },
        },
      };
    case 'delete_rule':
      return {
        payload: { kind: 'delete_rule', ruleId: RULE_ID, composite: COMPOSITE },
        preconditions: {
          rule: RULE_SNAPSHOT,
          override: null,
          actualVersion: 'actual-discard-v1',
          categoryGroupMembers: { [GROUP_ID]: [GROUP_CATEGORY_ID] },
        },
      };
  }
}

async function seed(
  operation: GenericProposalOperation = 'create_rule',
  selectedSpace = spaceId,
  selectedBudget = budgetId,
) {
  const { payload, preconditions } = proposalInput(operation);
  const expiresAt = EXPIRES_AT;
  return store.createProposal({
    operation,
    budgetId: selectedBudget,
    spaceId: selectedSpace,
    payload,
    policyVersion: GENERIC_MUTATION_POLICY_VERSION,
    preconditions: JSON.stringify(preconditions),
    payloadHash: canonicalProposalHash({
      operation,
      budgetId: selectedBudget,
      payload,
      preconditions,
      actorId: PROPOSER_ID,
      policyVersion: GENERIC_MUTATION_POLICY_VERSION,
      expiresAt,
    }),
    expiresAt,
    actorId: PROPOSER_ID,
    auth: { method: 'session', actorId: PROPOSER_ID, sessionId: `session:${PROPOSER_ID}` },
    provenance: 'proposal-discard-test',
  });
}

function proposalResources(operation: GenericProposalOperation) {
  if (operation === 'set_category')
    return [
      ['transaction', TRANSACTION_ID],
      ['account', ACCOUNT_ID],
      ['category', CATEGORY_ID],
    ] as const;
  if (operation === 'create_rule') {
    const { payload, preconditions } = proposalInput(operation);
    return deriveProposalAuthorizationFacts(operation, payload, preconditions).resources
      .map(({ resourceKind, resourceId }) => [resourceKind, resourceId] as const);
  }
  return [
    ['rule', RULE_ID],
    ['account', ACCOUNT_ID],
    ['category', CATEGORY_ID],
    ['category', GROUP_CATEGORY_ID],
  ] as const;
}

function grantCapabilityFor(
  granteeId: string,
  membershipId: string,
  operation: GenericProposalOperation,
  capability: string,
  targetSpace = spaceId,
  targetBudget = budgetId,
  restrictions: { operations?: readonly string[] } = {},
) {
  grant(granteeId, membershipId, capability, 'budget', targetBudget, targetSpace, targetBudget, restrictions);
  for (const [kind, id] of proposalResources(operation))
    grant(granteeId, membershipId, capability, kind, id, targetSpace, targetBudget, restrictions);
}

function grantProposerFor(
  operation: GenericProposalOperation,
  targetSpace = spaceId,
  targetBudget = budgetId,
  targetMembership = proposerMembershipId,
) {
  grantCapabilityFor(
    PROPOSER_ID,
    targetMembership,
    operation,
    operation === 'set_category' ? 'categorization:propose' : 'rule:propose',
    targetSpace,
    targetBudget,
  );
}

async function issueProof() {
  const event = makeEvent();
  const issued = await issueReauthentication(event as unknown as ReauthenticationEvent, 'correct-password');
  if (!issued) throw new Error('The test human session could not issue a reauthentication proof');
  const header = event.node.res.getHeader('set-cookie');
  const values = Array.isArray(header) ? header : typeof header === 'string' ? [header] : [];
  const cookie = values
    .map((value) => value.split(';', 1)[0]!)
    .find((value) => value.startsWith(`${REAUTH_COOKIE_NAME}=`));
  if (!cookie) throw new Error('Reauthentication did not set its proof cookie');
  proofCookie = cookie.slice(REAUTH_COOKIE_NAME.length + 1);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.clearAllMocks();
  vi.stubEnv('BETTER_AUTH_SECRET', 'proposal-discard-test-secret');
  vi.stubEnv('NUXT_BETTER_AUTH_SECRET', 'proposal-discard-test-secret');
  vi.stubEnv('BETTER_AUTH_URL', ORIGIN);
  vi.stubEnv('BALANCEFRAME_DEV_BYPASS_AUTH', 'false');
  vi.stubEnv('NUXT_DEV_BYPASS_AUTH', 'false');
  mocks.getSession.mockResolvedValue({
    user: { id: ACTOR_ID },
    session: { id: SESSION_ID, userId: ACTOR_ID },
  });
  mocks.verifyPassword.mockResolvedValue({ status: true });

  const provider = getWorkflowStore(makeEvent() as EventWithContext);
  if ('error' in provider) throw new Error(provider.error);
  store = provider.store;
  if (!bootstrapped) {
    await store.claimBootstrap({
      name: 'Proposal owner',
      email: 'proposal-discard-owner@example.test',
      claimId: 'proposal-discard-route-fixture',
    });
    await store.finalizeBootstrap({ claimId: 'proposal-discard-route-fixture', ownerUserId: OWNER_ID });
    bootstrapped = true;
  }

  spaceId = '';
  budgetId = `proposal-discard-budget-${++sequence}`;
  const ownerAuth = {
    method: 'human-session' as const,
    actorId: OWNER_ID,
    sessionId: `session:${OWNER_ID}`,
    reauthenticatedAt: NOW,
  };
  const space = store.governance.createSpace({
    actorId: OWNER_ID,
    name: `Discard route space ${sequence}`,
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
  await store.upsertActorMembership(PROPOSER_ID, 'active', [], '');
  await store.upsertActorMembership(ACTOR_ID, 'active', [], '');
  const proposer = store.governance.addMembership({
    spaceId,
    actorId: PROPOSER_ID,
    validFrom: NOW,
    now: NOW,
    auth: ownerAuth,
  });
  proposerMembershipId = proposer.id;
  const actorMembership = store.governance.addMembership({
    spaceId,
    actorId: ACTOR_ID,
    validFrom: NOW,
    now: NOW,
    auth: ownerAuth,
  });
  actorMembershipId = actorMembership.id;
  proofCookie = null;
  await issueProof();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
afterAll(() => store.close());

describe('current proposal discard authorization', () => {
  it.each([
    ['set_category', 'categorization:execute'],
    ['create_rule', 'rule:execute'],
    ['update_rule', 'rule:execute'],
    ['delete_rule', 'rule:execute'],
  ] as const)('supersedes the exact %s proposal and invalidates its approval', async (operation, capability) => {
    grantProposerFor(operation);
    grantCapabilityFor(ACTOR_ID, actorMembershipId, operation, capability);
    grantCapabilityFor(
      ACTOR_ID,
      actorMembershipId,
      operation,
      operation === 'set_category' ? 'categorization:approve' : 'rule:approve',
    );
    const proposal = await seed(operation);
    const controlAuth = await getHumanControlAuth(makeEvent(proposal.id) as unknown as ReauthenticationEvent);
    if (!controlAuth) throw new Error('The test human session has no current HMAC proof');
    const approval = await store.createApproval({
      proposalId: proposal.id,
      actorId: ACTOR_ID,
      payloadHash: proposal.payloadHash,
      expiresAt: proposal.expiresAt,
      auth: controlAuth,
      now: NOW,
    });

    const response = await handler(makeEvent(proposal.id));

    expect(response.status).toBe('ok');
    expect((await store.getProposal(proposal.id))?.supersededAt).not.toBeNull();
    expect((await store.getApproval(approval.id))?.status).toBe('superseded');
  });
  it('admits discard through the exact operation named by a restricted execution grant', async () => {
    grantProposerFor('set_category');
    grantCapabilityFor(
      ACTOR_ID,
      actorMembershipId,
      'set_category',
      'categorization:execute',
      spaceId,
      budgetId,
      { operations: ['set_category'] },
    );
    const proposal = await seed('set_category');

    const response = await handler(makeEvent(proposal.id));

    expect(response.status).toBe('ok');
    expect((await store.getProposal(proposal.id))?.supersededAt).not.toBeNull();
  });

  it('does not reveal an existing proposal to an actor without its exact current execution grants', async () => {
    grantProposerFor('set_category');
    const proposal = await seed('set_category');
    const inaccessibleEvent = makeEvent(proposal.id);
    const inaccessible = await handler(inaccessibleEvent);
    const unknownEvent = makeEvent('proposal-that-does-not-exist');
    const unknown = await handler(unknownEvent);

    expect({
      status: inaccessibleEvent.node.res.statusCode,
      code: inaccessible.error?.code,
      message: inaccessible.error?.message,
    }).toEqual({
      status: unknownEvent.node.res.statusCode,
      code: unknown.error?.code,
      message: unknown.error?.message,
    });
    expect(JSON.stringify(inaccessible)).not.toContain(proposal.payloadHash);
    const hidden = JSON.stringify(inaccessible);
    expect(hidden).not.toContain(TRANSACTION_ID);
    expect(hidden).not.toContain(ACCOUNT_ID);
    expect(hidden).not.toContain(CATEGORY_ID);
    expect((await store.getProposal(proposal.id))?.supersededAt).toBeNull();
  });

  it('preserves a proposal when the selected-budget execution grant is absent', async () => {
    grantProposerFor('create_rule');
    const proposal = await seed();

    const response = await handler(makeEvent(proposal.id));

    expect(response.status).toBe('error');
    expect((await store.getProposal(proposal.id))?.supersededAt).toBeNull();
    expect(JSON.stringify(response)).not.toContain(proposal.payloadHash);
  });

  it('requires a current human session with its matching proof', async () => {
    grantProposerFor('create_rule');
    grant(ACTOR_ID, actorMembershipId, 'rule:execute', 'budget', budgetId);
    const proposal = await seed();

    const anonymous = await handler(makeEvent(proposal.id, { authenticated: false }));
    const noProof = await handler(makeEvent(proposal.id, { proof: false }));

    expect(anonymous.status).toBe('error');
    expect(noProof.status).toBe('error');
    expect((await store.getProposal(proposal.id))?.supersededAt).toBeNull();
  });

  it('does not disclose a real proposal from another selected space', async () => {
    const foreignBudget = `foreign-discard-budget-${sequence}`;
    const ownerAuth = {
      method: 'human-session' as const,
      actorId: OWNER_ID,
      sessionId: `session:${OWNER_ID}`,
      reauthenticatedAt: NOW,
    };
    const foreignSpace = store.governance.createSpace({
      actorId: OWNER_ID,
      name: 'Foreign discard space',
      kind: 'shared',
      now: NOW,
      auth: ownerAuth,
    });
    store.governance.bindBudget({
      spaceId: foreignSpace.id,
      budgetId: foreignBudget,
      now: NOW,
      auth: ownerAuth,
    });
    if (!store.governance.getPolicy({ spaceId: foreignSpace.id })) {
      store.governance.setPolicy({
        spaceId: foreignSpace.id,
        expectedVersion: null,
        policy: { minimumApprovers: 1, approvalThresholds: [] },
        now: NOW,
        auth: ownerAuth,
      });
    }
    const foreignMembership = store.governance.addMembership({
      spaceId: foreignSpace.id,
      actorId: PROPOSER_ID,
      validFrom: NOW,
      now: NOW,
      auth: ownerAuth,
    });
    grantProposerFor('create_rule', foreignSpace.id, foreignBudget, foreignMembership.id);
    const proposal = await seed('create_rule', foreignSpace.id, foreignBudget);

    const hidden = await handler(makeEvent(proposal.id));
    expect(hidden.status).toBe('error');
    expect(JSON.stringify(hidden)).not.toContain(proposal.payloadHash);
    expect((await store.getProposal(proposal.id))?.supersededAt).toBeNull();
  });
});
