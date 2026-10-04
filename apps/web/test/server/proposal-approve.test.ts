import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as H3 from 'h3';
import type { EventWithContext } from '../../server/utils/workflow-store';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import {
  GENERIC_MUTATION_POLICY_VERSION,
  canonicalProposalHash,
} from '@balanceframe/workflow-store';
import type { GenericActionProposal, GenericProposalOperation } from '@balanceframe/workflow-store';
import { getWorkflowStore } from '../../server/utils/workflow-store';
import type { ReauthenticationEvent } from '../../server/utils/reauthentication';
import { issueReauthentication, REAUTH_COOKIE_NAME } from '../../server/utils/reauthentication';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  verifyPassword: vi.fn(),
}));

vi.mock('h3', async (importOriginal) => ({
  ...(await importOriginal<typeof H3>()),
  readBody: async (event: { body: unknown }) => {
    if (event.body instanceof Error) throw event.body;
    return event.body;
  },
}));
vi.mock('better-auth/node', () => ({
  fromNodeHeaders: (headers: ConstructorParameters<typeof Headers>[0]) => new Headers(headers),
}));
vi.mock('../../lib/auth', () => ({
  auth: { api: { getSession: mocks.getSession, verifyPassword: mocks.verifyPassword } },
}));
vi.mock('@balanceframe/workflow-store', async () =>
  import('../../../../packages/workflow-store/src/index'));

import handler from '../../server/api/proposal/[id]/approve.post';

const OWNER_ID = 'proposal-approval-owner';
const PROPOSER_ID = 'proposal-author';
const APPROVER_ID = 'authenticated-user';
const SESSION_ID = `session:${APPROVER_ID}`;
const ORIGIN = 'https://balanceframe.example.test';
const NOW = '2098-01-01T12:00:00.000Z';
const EXPIRES_AT = '2099-01-01T00:00:00.000Z';
const ACCOUNT_ID = 'approval-account';
const TRANSACTION_ID = 'approval-transaction';
const CATEGORY_ID = 'approval-category';
const RULE_ID = 'approval-rule';
const GROUP_ID = 'approval-group';
const GROUP_CATEGORY_ID = 'approval-group-category';
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

let store: SqliteWorkflowStore;
let bootstrapped = false;
let sequence = 0;
let spaceId = '';
let budgetId = '';
let proposerMembershipId = '';
let approverMembershipId = '';
let proofCookie: string | null = null;

type RequestEvent = H3.H3Event & EventWithContext & { body: unknown };

function makeEvent(
  id = '',
  body: unknown = undefined,
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
    body,
    node: { req: { headers }, res: response },
    context: {
      params: { id },
      auth: {
        authenticated: options.authenticated ?? true,
        actorId: APPROVER_ID,
        method: 'session',
        principalType: 'human',
        sessionId: SESSION_ID,
        user: { id: APPROVER_ID },
      },
      runtimeConfig: { workflowDbPath: ':memory:', devBypassAuth: false },
    },
  } as unknown as RequestEvent;
}

interface TestResponse {
  statusCode: number;
  statusMessage: string;
  headersSent: boolean;
  setHeader(name: string, value: string | string[]): TestResponse;
  getHeader(name: string): string | string[] | undefined;
  removeHeader(name: string): void;
}

function grant(
  actorId: string,
  membershipId: string,
  capability: string,
  resourceKind: 'budget' | 'account' | 'category' | 'rule' | 'transaction',
  resourceId: string,
  restrictions?: { operations: readonly string[] },
) {
  store.governance.provisionResourceGrant({
    spaceId,
    actorId,
    membershipId,
    budgetId,
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
            actualVersion: 'actual-approval-v1',
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
          rule: {
            name: 'Merchant rule',
            conditions: [{ field: 'payee_name', op: 'is', value: 'Merchant' }],
            actions: [{ type: 'set-category', field: 'category', value: CATEGORY_ID }],
          },
        },
        preconditions: { actualVersion: 'actual-approval-v1' },
      };
    case 'update_rule':
      return {
        payload: { kind: 'update_rule', ruleId: RULE_ID, inactive: true, composite: COMPOSITE },
        preconditions: {
          rule: RULE_SNAPSHOT,
          override: null,
          actualVersion: 'actual-approval-v1',
          categoryGroupMembers: { [GROUP_ID]: [GROUP_CATEGORY_ID] },
        },
      };
    case 'delete_rule':
      return {
        payload: { kind: 'delete_rule', ruleId: RULE_ID, composite: COMPOSITE },
        preconditions: {
          rule: RULE_SNAPSHOT,
          override: null,
          actualVersion: 'actual-approval-v1',
          categoryGroupMembers: { [GROUP_ID]: [GROUP_CATEGORY_ID] },
        },
      };
  }
}

async function seed(operation: GenericProposalOperation = 'create_rule', expiresAt = EXPIRES_AT) {
  const { payload, preconditions } = proposalInput(operation);
  const auth = { method: 'session' as const, actorId: PROPOSER_ID, sessionId: `session:${PROPOSER_ID}` };
  const proposal = await store.createProposal({
    operation,
    budgetId,
    spaceId,
    payload,
    policyVersion: GENERIC_MUTATION_POLICY_VERSION,
    preconditions: JSON.stringify(preconditions),
    payloadHash: canonicalProposalHash({
      operation,
      budgetId,
      payload,
      preconditions,
      actorId: PROPOSER_ID,
      policyVersion: GENERIC_MUTATION_POLICY_VERSION,
      expiresAt,
    }),
    expiresAt,
    actorId: PROPOSER_ID,
    auth,
    provenance: 'proposal-approval-test',
  });
  return proposal;
}

function proposalResources(operation: GenericProposalOperation) {
  if (operation === 'set_category')
    return [
      ['transaction', TRANSACTION_ID],
      ['account', ACCOUNT_ID],
      ['category', CATEGORY_ID],
    ] as const;
  if (operation === 'create_rule')
    return [['category', CATEGORY_ID]] as const;
  return [
    ['rule', RULE_ID],
    ['account', ACCOUNT_ID],
    ['category', CATEGORY_ID],
    ['category', GROUP_CATEGORY_ID],
  ] as const;
}

function grantProposerFor(operation: GenericProposalOperation) {
  const capability = operation === 'set_category' ? 'categorization:propose' : 'rule:propose';
  grant(PROPOSER_ID, proposerMembershipId, capability, 'budget', budgetId);
  for (const [kind, id] of proposalResources(operation))
    grant(PROPOSER_ID, proposerMembershipId, capability, kind, id);
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
  vi.stubEnv('BETTER_AUTH_SECRET', 'proposal-approval-test-secret');
  vi.stubEnv('NUXT_BETTER_AUTH_SECRET', 'proposal-approval-test-secret');
  vi.stubEnv('BETTER_AUTH_URL', ORIGIN);
  vi.stubEnv('BALANCEFRAME_DEV_BYPASS_AUTH', 'false');
  vi.stubEnv('NUXT_DEV_BYPASS_AUTH', 'false');
  mocks.getSession.mockResolvedValue({
    user: { id: APPROVER_ID },
    session: { id: SESSION_ID, userId: APPROVER_ID },
  });
  mocks.verifyPassword.mockResolvedValue({ status: true });

  const provider = getWorkflowStore(makeEvent() as EventWithContext);
  if ('error' in provider) throw new Error(provider.error);
  store = provider.store;
  if (!bootstrapped) {
    await store.claimBootstrap({
      name: 'Proposal owner',
      email: 'proposal-owner@example.test',
      claimId: 'proposal-approval-route-fixture',
    });
    await store.finalizeBootstrap({
      claimId: 'proposal-approval-route-fixture',
      ownerUserId: OWNER_ID,
    });
    bootstrapped = true;
  }

  spaceId = '';
  budgetId = `proposal-approval-budget-${++sequence}`;
  const ownerAuth = {
    method: 'human-session' as const,
    actorId: OWNER_ID,
    sessionId: `session:${OWNER_ID}`,
    reauthenticatedAt: NOW,
  };
  const space = store.governance.createSpace({
    actorId: OWNER_ID,
    name: `Approval route space ${sequence}`,
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
  await store.upsertActorMembership(APPROVER_ID, 'active', [], '');
  const proposer = store.governance.addMembership({
    spaceId,
    actorId: PROPOSER_ID,
    validFrom: NOW,
    now: NOW,
    auth: ownerAuth,
  });
  proposerMembershipId = proposer.id;
  const approver = store.governance.addMembership({
    spaceId,
    actorId: APPROVER_ID,
    validFrom: NOW,
    now: NOW,
    auth: ownerAuth,
  });
  approverMembershipId = approver.id;
  proofCookie = null;
  await issueProof();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
afterAll(() => store.close());

describe('POST proposal approval authorization', () => {
  it.each([
    ['set_category', 'categorization:approve'],
    ['create_rule', 'rule:approve'],
    ['update_rule', 'rule:approve'],
    ['delete_rule', 'rule:approve'],
  ] as const)('approves the exact current %s proposal in the selected budget', async (operation, capability) => {
    grantProposerFor(operation);
    grant(APPROVER_ID, approverMembershipId, capability, 'budget', budgetId, { operations: [operation] });
    for (const [kind, id] of proposalResources(operation))
      grant(APPROVER_ID, approverMembershipId, capability, kind, id);
    const proposal = await seed(operation);

    const response = await handler(makeEvent(proposal.id, { payloadHash: proposal.payloadHash }));

    expect(response.status).toBe('ok');
    expect(response.result).toMatchObject({ proposalId: proposal.id, status: 'active' });
    expect(await store.findActiveApprovals(proposal.id)).toMatchObject([
      {
        actorId: APPROVER_ID,
        payloadHash: proposal.payloadHash,
        reauthenticatedSessionId: SESSION_ID,
      },
    ]);
  });

  it.each([
    { name: 'nonmember', capability: null },
    { name: 'observer', capability: 'observe' },
    { name: 'wrong operation', capability: 'categorization:approve' },
    { name: 'wrong budget', capability: 'rule:approve', foreign: true },
  ])('denies $name without disclosing proposal contents', async ({ capability, foreign }) => {
    grantProposerFor('create_rule');
    const proposal = await seed();
    if (capability === null) {
      store.governance.revokeMembership({
        spaceId,
        membershipId: approverMembershipId,
        now: NOW,
        auth: {
          method: 'human-session',
          actorId: OWNER_ID,
          sessionId: `session:${OWNER_ID}`,
          reauthenticatedAt: NOW,
        },
      });
    } else if (foreign) {
      const foreignBudget = `approval-foreign-budget-${sequence}`;
      const ownerAuth = {
        method: 'human-session' as const,
        actorId: OWNER_ID,
        sessionId: `session:${OWNER_ID}`,
        reauthenticatedAt: NOW,
      };
      const foreignSpace = store.governance.createSpace({
        actorId: OWNER_ID,
        name: 'Foreign approval space',
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
        actorId: APPROVER_ID,
        validFrom: NOW,
        now: NOW,
        auth: ownerAuth,
      });
      for (const [kind, id] of [
        ['budget', foreignBudget] as const,
        ...proposalResources('create_rule'),
      ])
        store.governance.provisionResourceGrant({
          spaceId: foreignSpace.id,
          actorId: APPROVER_ID,
          membershipId: foreignMembership.id,
          budgetId: foreignBudget,
          capability: capability!,
          resourceKind: kind,
          resourceId: id,
          granted: true,
          now: NOW,
        });

    } else {
      grant(APPROVER_ID, approverMembershipId, capability!, 'budget', budgetId);
      if (capability === 'categorization:approve') {
        for (const [kind, id] of proposalResources('create_rule'))
          grant(APPROVER_ID, approverMembershipId, capability, kind, id);
      }
    }
    const response = await handler(makeEvent(proposal.id, { payloadHash: proposal.payloadHash }));

    expect(response.status).toBe('error');
    expect(await store.findActiveApprovals(proposal.id)).toEqual([]);
    const serialized = JSON.stringify(response);
    for (const secret of [budgetId, proposal.transactionId, proposal.categoryId, proposal.payloadHash, proposal.id])
      expect(serialized).not.toContain(secret);
  });

  it('does not distinguish missing and unavailable proposals to a nonmember', async () => {
    grantProposerFor('create_rule');
    const proposal = await seed();
    store.governance.revokeMembership({
      spaceId,
      membershipId: approverMembershipId,
      now: NOW,
      auth: {
        method: 'human-session',
        actorId: OWNER_ID,
        sessionId: `session:${OWNER_ID}`,
        reauthenticatedAt: NOW,
      },
    });
    const activeResponse = await handler(makeEvent(proposal.id, { payloadHash: proposal.payloadHash }));
    await store.supersedeProposal(proposal.id);
    const supersededResponse = await handler(makeEvent(proposal.id, { payloadHash: proposal.payloadHash }));
    const missingResponse = await handler(makeEvent('missing', { payloadHash: 'a'.repeat(64) }));
    expect(activeResponse.status).toBe('error');
    expect(supersededResponse.error).toEqual(activeResponse.error);
    expect(missingResponse.error).toEqual(activeResponse.error);
  });
  it('does not reveal existence or displayed-hash conflicts to a budget-only operation approver', async () => {
    grantProposerFor('create_rule');
    const proposal = await seed();
    grant(APPROVER_ID, approverMembershipId, 'rule:approve', 'budget', budgetId);
    const absent = await handler(makeEvent('missing-proposal', { payloadHash: 'a'.repeat(64) }));
    const known = await handler(makeEvent(proposal.id, { payloadHash: proposal.payloadHash }));
    const wrongHash = await handler(makeEvent(proposal.id, { payloadHash: 'a'.repeat(64) }));
    expect(known.error).toEqual(absent.error);
    expect(wrongHash.error).toEqual(absent.error);
    expect(known.authorization).toEqual(absent.authorization);
    expect(wrongHash.authorization).toEqual(absent.authorization);
    expect(await store.findActiveApprovals(proposal.id)).toEqual([]);
  });

  it('requires an authenticated identity and the matching human proof', async () => {
    grantProposerFor('create_rule');
    grant(APPROVER_ID, approverMembershipId, 'rule:approve', 'budget', budgetId);
    const proposal = await seed();

    const anonymous = await handler(makeEvent(proposal.id, { payloadHash: proposal.payloadHash }, { authenticated: false }));
    const noProof = await handler(makeEvent(proposal.id, { payloadHash: proposal.payloadHash }, { proof: false }));

    expect(anonymous.status).toBe('error');
    expect(noProof.status).toBe('error');
    expect(await store.findActiveApprovals(proposal.id)).toEqual([]);
  });

  it('rejects malformed and forged displayed hashes without creating approval state', async () => {
    grantProposerFor('create_rule');
    grant(APPROVER_ID, approverMembershipId, 'rule:approve', 'budget', budgetId);
    const proposal = await seed();

    const malformed = await handler(makeEvent(proposal.id, { payloadHash: 'not-a-hash' }));
    const forged = await handler(makeEvent(proposal.id, { payloadHash: 'f'.repeat(64) }));

    expect(malformed.status).toBe('error');
    expect(forged.status).toBe('error');
    expect(await store.findActiveApprovals(proposal.id)).toEqual([]);
  });

  it('rejects a revoked current member before creating approval state', async () => {
    grantProposerFor('create_rule');
    grant(APPROVER_ID, approverMembershipId, 'rule:approve', 'budget', budgetId);
    const proposal = await seed();
    store.governance.revokeMembership({
      spaceId,
      membershipId: approverMembershipId,
      now: NOW,
      auth: {
        method: 'human-session',
        actorId: OWNER_ID,
        sessionId: `session:${OWNER_ID}`,
        reauthenticatedAt: NOW,
      },
    });

    expect((await handler(makeEvent(proposal.id, { payloadHash: proposal.payloadHash }))).status).toBe('error');
    expect(await store.findActiveApprovals(proposal.id)).toEqual([]);
  });
});
