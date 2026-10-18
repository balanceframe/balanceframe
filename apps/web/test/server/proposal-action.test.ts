import type * as H3 from 'h3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type { GenericActionProposal, ProposalApprovalSummary } from '@balanceframe/workflow-store';
import type { ConsequentialActionProposal } from '@balanceframe/application';
import { ApplicationError } from '@balanceframe/application';
import type { EventWithContext } from '../../server/utils/workflow-store';
import { issueReauthentication, REAUTH_COOKIE_NAME } from '../../server/utils/reauthentication';
import type { ReauthenticationEvent } from '../../server/utils/reauthentication';
import { getWorkflowStore } from '../../server/utils/workflow-store';
import * as workflowStore from '../../server/utils/workflow-store';
import actionFixture from '../../../../protocol/fixtures/consequential-action.json';
import liquidityFixture from '../../../../protocol/fixtures/account-aware-liquidity.json';

const mocks = vi.hoisted(() => ({
  readBody: vi.fn(async (event: { body: unknown }) => {
    if (event.body instanceof Error) throw event.body;
    return event.body;
  }),
  createActionService: vi.fn(),
  selectedActionActor: vi.fn(),
  getSession: vi.fn(),
  verifyPassword: vi.fn(),
  actionService: {
    propose: vi.fn(),
    getProposal: vi.fn(),
    getProposals: vi.fn(),
    execute: vi.fn(),
    reconcile: vi.fn(),
  },
}));

vi.mock('h3', async (importOriginal) => ({
  ...(await importOriginal<typeof H3>()),
  readBody: mocks.readBody,
  getRouterParam: (event: { context: { params?: Record<string, string> } }, name: string) =>
    event.context.params?.[name],
}));
vi.mock('@balanceframe/workflow-store', async () =>
  import('../../../../packages/workflow-store/src/index'));

vi.mock('../../lib/auth', () => ({
  auth: { api: { getSession: mocks.getSession, verifyPassword: mocks.verifyPassword } },
  isAuthCredentialValid: () => true,
}));
vi.mock('../../server/utils/liquidity-service', () => ({
  createWebConsequentialActionService: mocks.createActionService,
  selectedLiquidityActor: mocks.selectedActionActor,
}));
import createActionProposal from '../../server/api/proposal/action.post';
import listProposals from '../../server/api/proposal/index.get';
import proposalDetail from '../../server/api/proposal/[id].get';
import executeProposal from '../../server/api/proposal/[id]/execute.post';
import reconcileProposal from '../../server/api/proposal/[id]/reconcile.post';
import { projectConsequentialActionExecution, projectConsequentialActionProposal } from '../../server/utils/proposal-route';

interface TestResponse {
  statusCode: number;
  statusMessage: string;
  headersSent: boolean;
  setHeader(name: string, value: string | string[]): TestResponse;
  getHeader(name: string): string | string[] | undefined;
  removeHeader(name: string): void;
}
type RequestEvent = H3.H3Event & EventWithContext & { body: unknown };

const OWNER_ID = 'action-route-owner';
const MEMBER_ID = 'action-route-member';
const ORIGIN = 'https://balanceframe.action.test';
const NOW = '2026-10-13T12:00:00.000Z';
let store: SqliteWorkflowStore;
let spaceId = '';
let budgetId = '';
let sequence = 0;
let bootstrapped = false;

function event(body: unknown, selectedSpace = spaceId, actorId = OWNER_ID): RequestEvent {
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
          origin: ORIGIN,
          host: new URL(ORIGIN).host,
          'x-balanceframe-space': selectedSpace,
        },
      },
      res: response,
    },
    context: {
      params: {},
      auth: {
        authenticated: true,
        user: { id: actorId },
        actorId: 'untrusted-legacy-actor',
        method: 'session',
        principalType: 'human',
        sessionId: `session:${actorId}`,
      },
      runtimeConfig: { workflowDbPath: ':memory:', devBypassAuth: false },
    },
  } as unknown as RequestEvent;
}

function ownerControl() {
  return {
    method: 'human-session' as const,
    actorId: OWNER_ID,
    sessionId: `session:${OWNER_ID}`,
    reauthenticatedAt: NOW,
  };
}

const validIntent = {
  action: actionFixture.intent,
  decision: { origin: { sessionId: 'saved-session', sessionVersion: 1 } },
};

const PRIVATE_NATIVE_FACT = 'private-native-hash-and-source-marker';

function actionProjection(): ConsequentialActionProposal {
  const governancePolicyVersion =
    store.governance.getPolicy({ spaceId })?.version ?? 'governance-current';
  return {
    id: 'public-action-proposal',
    operation: 'consequential_action',
    budgetId,
    spaceId,
    policyVersion: 'generic-mutation-v1',
    requesterActorId: OWNER_ID,
    governancePolicyVersion,
    currentGovernancePolicyVersion: governancePolicyVersion,
    payloadHash: 'a'.repeat(64),
    financialPolicyVersion: 'financial-captured',
    currentFinancialPolicyVersion: 'financial-current',
    requiredApprovers: 2,
    decisionContext: {
      horizon: { startsAt: NOW, endsAt: '2026-10-20T12:00:00.000Z' },
      validUntil: '2026-10-20T12:00:00.000Z',
      items: [{
        id: 'visible-cart-item',
        categoryId: 'visible-category',
        accountId: 'visible-account',
        amount: { minorUnits: '2500', currency: 'USD' },
        purchaseAt: NOW,
        requiredBy: '2026-10-14T12:00:00.000Z',
        priority: 'required',
        nativeEvidenceHash: PRIVATE_NATIVE_FACT,
      }],
      nativeSupplemental: PRIVATE_NATIVE_FACT,
    },
    expiresAt: '2026-10-14T12:00:00.000Z',
    supersededAt: null,
    createdAt: NOW,
    version: 1,
    payload: {
      kind: 'consequential_action',
      plan: {
        version: '1',
        action: { ...actionFixture.intent, actionHash: PRIVATE_NATIVE_FACT },
        source: {
          snapshotReference: '00000000-0000-4000-8000-000000000001',
          policyVersion: 'liquidity-policy-1',
          financialPolicyVersion: 'financial-policy-1',
          claimSetRevision: 'claim-set-1',
          snapshotId: PRIVATE_NATIVE_FACT,
          contentHash: PRIVATE_NATIVE_FACT,
          preconditionsHash: PRIVATE_NATIVE_FACT,
        },
        evidenceReferences: [{
          evidenceId: 'visible-evidence',
          subjectId: 'visible-cart-item',
          state: 'resolved',
          contentHash: PRIVATE_NATIVE_FACT,
        }],
        expiresAt: '2026-10-14T12:00:00.000Z',
        reasonCodes: ['safe_reallocation'],
        impacts: [],
        expectedPostconditions: [],
        actionHash: PRIVATE_NATIVE_FACT,
        idempotencyKey: PRIVATE_NATIVE_FACT,
      },
    },
    state: { phase: 'proposed', outcome: null, effects: [PRIVATE_NATIVE_FACT] },
    preconditions: PRIVATE_NATIVE_FACT,
    supplemental: PRIVATE_NATIVE_FACT,
  } as unknown as ConsequentialActionProposal;
}

function approvalSummary(): ProposalApprovalSummary {
  return {
    currentGovernancePolicyVersion:
      store.governance.getPolicy({ spaceId })?.version ?? 'governance-current',
    requesterMembershipCurrent: true,
    privateEnvelopeVisible: true,
    approvalAuthorized: true,
    executionAuthorized: false,
    requiredApprovers: 2,
    approvers: [{
      actorId: 'current-human-approver',
      issuedAt: NOW,
      expiresAt: '2026-10-14T12:00:00.000Z',
    }],
    disposition: { kind: 'approval_required', reason: PRIVATE_NATIVE_FACT },
    canApprove: true,
    canExecute: false,
  } as unknown as ProposalApprovalSummary;
}

function rawActionProposal(): GenericActionProposal {
  return {
    ...actionProjection(),
    actorId: OWNER_ID,
    requesterMembershipId: 'private-membership-id',
    provenance: PRIVATE_NATIVE_FACT,
    providerModel: PRIVATE_NATIVE_FACT,
    correlationId: PRIVATE_NATIVE_FACT,
  } as unknown as GenericActionProposal;
}

function mockActionRead() {
  const proposal = rawActionProposal();
  vi.spyOn(store, 'getProposal').mockResolvedValue(proposal);
  vi.spyOn(store, 'listProposals').mockResolvedValue([proposal]);
  vi.spyOn(store, 'getProposalApprovalReads').mockReturnValue([{
    proposal,
    preconditions: { nativeHash: PRIVATE_NATIVE_FACT },
    summary: approvalSummary(),
  }]);
  return proposal;
}

async function humanExecutionRequest(proposalId: string): Promise<RequestEvent> {
  const request = event(undefined);
  request.context.params = { id: proposalId };
  request.context.auth!.actorId = OWNER_ID;
  mocks.getSession.mockResolvedValue({
    user: { id: OWNER_ID },
    session: { id: `session:${OWNER_ID}`, userId: OWNER_ID },
  });
  mocks.verifyPassword.mockResolvedValue({ status: true });
  const issued = await issueReauthentication(request as unknown as ReauthenticationEvent, 'fixture-password');
  if (!issued) throw new Error('Fixture human proof must be issued');
  const headers = request.node.res.getHeader('set-cookie');
  const cookies = Array.isArray(headers) ? headers : typeof headers === 'string' ? [headers] : [];
  const proof = cookies.map((cookie) => cookie.split(';', 1)[0]!)
    .find((cookie) => cookie.startsWith(`${REAUTH_COOKIE_NAME}=`));
  if (!proof) throw new Error('Fixture human proof cookie must be present');
  request.node.req.headers.cookie = proof;
  return request;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.stubEnv('BETTER_AUTH_URL', ORIGIN);
  vi.stubEnv('BALANCEFRAME_SEED_ALLOWED', 'false');
  vi.stubEnv('BETTER_AUTH_SECRET', 'phase9-test-human-proof-secret');
  vi.stubEnv('BALANCEFRAME_DEV_BYPASS_AUTH', 'false');
  vi.clearAllMocks();
  mocks.createActionService.mockReset().mockResolvedValue(mocks.actionService);
  mocks.selectedActionActor.mockReset().mockReturnValue({});
  mocks.actionService.propose.mockReset();
  mocks.actionService.getProposal.mockReset();
  mocks.actionService.getProposals.mockReset();
  mocks.actionService.execute.mockReset();
  mocks.actionService.reconcile.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const initialized = getWorkflowStore({
    context: { runtimeConfig: { workflowDbPath: ':memory:', devBypassAuth: false } },
  } as unknown as EventWithContext);
  if ('error' in initialized) throw new Error(initialized.error);
  store = initialized.store;
  if (!bootstrapped) {
    await store.claimBootstrap({
      name: 'Action route owner',
      email: 'action-route-owner@example.test',
      claimId: 'action-route-bootstrap',
    });
    await store.finalizeBootstrap({ claimId: 'action-route-bootstrap', ownerUserId: OWNER_ID });
    bootstrapped = true;
  }
  sequence += 1;
  budgetId = `action-route-budget-${sequence}`;
  const space = store.governance.createSpace({
    actorId: OWNER_ID,
    name: `Action route space ${sequence}`,
    kind: 'shared',
    now: NOW,
    auth: ownerControl(),
  });
  spaceId = space.id;
  store.governance.bindBudget({ spaceId, budgetId, now: NOW, auth: ownerControl() });
  await store.upsertActorMembership(MEMBER_ID, 'active', [], '');
  store.governance.addMembership({
    spaceId,
    actorId: MEMBER_ID,
    validFrom: NOW,
    now: NOW,
    auth: ownerControl(),
  });
});

afterAll(() => {
  store?.close();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('consequential-action proposal API trust boundary', () => {
  it.each([
    'actor', 'actorId', 'auth', 'space', 'spaceId', 'budgetId', 'source', 'plan', 'hash',
    'payloadHash', 'actionHash', 'nativeActionHash', 'idempotencyKey', 'proofToken',
    'evidence', 'resolvedEvidence', 'currentLedger', 'result', 'executionResult', 'approvals',
    'authority', 'clientAuthority',
  ])('rejects client-supplied %s before composing the application service', async (field) => {
    const response = await createActionProposal(event({ ...validIntent, [field]: {} }));
    expect(response).toMatchObject({ status: 'error', error: { code: 'INVALID_BODY' } });
  });

  it('rejects server facts nested inside an otherwise valid decision selector', async () => {
    const response = await createActionProposal(event({
      ...validIntent,
      decision: { origin: { sessionId: 'saved-session', sessionVersion: 1 }, source: {} },
    }));
    expect(response).toMatchObject({ status: 'error', error: { code: 'INVALID_BODY' } });
  });

  it('rejects a member whose selected space is not currently authorized before reading the body', async () => {
    const owner = ownerControl();
    const foreign = store.governance.createSpace({
      actorId: OWNER_ID,
      name: 'Unrelated space',
      kind: 'shared',
      now: NOW,
      auth: owner,
    });
    store.governance.bindBudget({
      spaceId: foreign.id,
      budgetId: `foreign-action-budget-${sequence}`,
      now: NOW,
      auth: owner,
    });
    const body = new Error('body must not be read for an unauthorized selection');
    const response = await createActionProposal(event(body, foreign.id, MEMBER_ID));
    expect(response.status).toBe('error');
    expect(mocks.readBody).not.toHaveBeenCalled();
  });

  it('rejects an untrusted browser origin before reading action intent', async () => {
    const request = event(new Error('body must not be read for an untrusted origin'));
    (request.node.req.headers as Record<string, string>).origin = 'https://attacker.example.test';
    const response = await createActionProposal(request);
    expect(response).toMatchObject({ status: 'error', error: { code: 'FORBIDDEN' } });
    expect(mocks.readBody).not.toHaveBeenCalled();
  });
  it('publishes the action-creation projection with current approval facts and no native fields', async () => {
    mocks.actionService.propose.mockResolvedValue(actionProjection());
    vi.spyOn(store, 'getProposalApprovalSummary').mockResolvedValue(approvalSummary());

    const response = await createActionProposal(event(validIntent));

    expect(response.status).toBe('ok');
    expect(response.result!.proposal).toMatchObject({
      requesterActorId: OWNER_ID,
      payloadHash: 'a'.repeat(64),
      governancePolicyVersion: store.governance.getPolicy({ spaceId })!.version,
      currentGovernancePolicyVersion: store.governance.getPolicy({ spaceId })!.version,
      financialPolicyVersion: 'financial-captured',
      currentFinancialPolicyVersion: 'financial-current',
      requiredApprovers: 2,
      approvers: [{ actorId: 'current-human-approver' }],
    });
    expect(response.result!.proposal.payload.plan.source).toEqual({
      snapshotReference: '00000000-0000-4000-8000-000000000001',
      policyVersion: 'liquidity-policy-1',
      financialPolicyVersion: 'financial-policy-1',
      claimSetRevision: 'claim-set-1',
    });
    expect(response.result!.proposal).not.toHaveProperty('preconditions');
    expect(JSON.stringify(response)).not.toContain(PRIVATE_NATIVE_FACT);
  });

  it('accepts a public purchase cart without requiring a caller-selected server expiry', async () => {
    mocks.actionService.propose.mockResolvedValue(actionProjection());
    vi.spyOn(store, 'getProposalApprovalSummary').mockResolvedValue(approvalSummary());
    const item = liquidityFixture.scenario.items[0]!;
    const response = await createActionProposal(event({
      ...validIntent,
      decision: {
        accountId: item.routeSelection.explicitAccountId,
        items: [{
          id: item.id,
          categoryId: item.categoryId,
          amount: item.amount,
          accountId: item.routeSelection.explicitAccountId,
          purchaseAt: item.purchaseAt,
          requiredBy: item.requiredBy,
        }],
      },
    }));
    expect(response.status).toBe('ok');
    expect(response.result!.proposal.expiresAt).toBe(actionProjection().expiresAt);
  });

  it('reports an unsafe native reallocation as a non-retryable state conflict', async () => {
    mocks.actionService.propose.mockRejectedValue(new Error('reallocation_not_safe_in_decision_card'));
    const request = event(validIntent);
    const response = await createActionProposal(request);
    expect(request.node.res.statusCode).toBe(409);
    expect(response).toMatchObject({
      status: 'error',
      result: null,
      error: { code: 'ACTION_STATE_CHANGED', retryable: false },
    });
    expect(JSON.stringify(response)).not.toContain('reallocation_not_safe_in_decision_card');
  });

  it('reports persisted but undisclosed creation as non-retryable without publishing its financial DTO', async () => {
    mocks.actionService.propose.mockRejectedValue(new ApplicationError({
      code: 'PROPOSAL_CREATED_DETAILS_WITHHELD',
      message: 'Proposal persisted; financial detail publication is unavailable',
      retryable: false,
    }));
    const request = event(validIntent);
    const response = await createActionProposal(request);
    expect(request.node.res.statusCode).toBe(403);
    expect(response).toMatchObject({
      status: 'error',
      result: null,
      error: { code: 'PROPOSAL_CREATED_DETAILS_WITHHELD', retryable: false },
    });
  });

  it('withholds creation detail when current publication authority changes after planning', async () => {
    mocks.actionService.propose.mockResolvedValue(actionProjection());
    vi.spyOn(store, 'getProposalApprovalSummary').mockResolvedValue({
      ...approvalSummary(),
      privateEnvelopeVisible: false,
    });
    const request = event(validIntent);
    const response = await createActionProposal(request);
    expect(request.node.res.statusCode).toBe(403);
    expect(response).toMatchObject({
      status: 'error',
      result: null,
      error: { code: 'PROPOSAL_CREATED_DETAILS_WITHHELD', retryable: false },
    });
  });

  it('uses only scoped projections for individual and batch reads without passing propose authority', async () => {
    const raw = mockActionRead();
    const projection = actionProjection();
    mocks.actionService.getProposal.mockResolvedValue(projection);
    mocks.actionService.getProposals.mockResolvedValue([projection]);

    const detailRequest = event(undefined);
    detailRequest.context.params = { id: raw.id };
    const detail = await proposalDetail(detailRequest);
    const listed = await listProposals(event(undefined));

    expect(detail.status).toBe('ok');
    expect(detail.result!.proposal).toMatchObject({
      requesterActorId: OWNER_ID,
      payloadHash: 'a'.repeat(64),
      requiredApprovers: 2,
      approvers: [{ actorId: 'current-human-approver' }],
      currentGovernancePolicyVersion: store.governance.getPolicy({ spaceId })!.version,
      financialPolicyVersion: 'financial-captured',
      currentFinancialPolicyVersion: 'financial-current',
    });
    expect(detail.result!.proposal).not.toHaveProperty('preconditions');
    expect(detail.result!.proposal).toMatchObject({ state: { phase: 'proposed', outcome: null } });
    expect(listed.status).toBe('ok');
    expect(listed.result!.proposals).toHaveLength(1);
    expect(listed.result!.proposals[0]).toMatchObject({
      id: raw.id,
      requesterActorId: OWNER_ID,
      payloadHash: 'a'.repeat(64),
      requiredApprovers: 2,
      approvers: [{ actorId: 'current-human-approver' }],
    });
    expect(listed.result!.proposals[0]).not.toHaveProperty('preconditions');
    expect(listed.result!.proposals[0]).not.toHaveProperty('provenance');
    expect(mocks.actionService.propose).not.toHaveBeenCalled();
    expect(JSON.stringify({ detail, listed })).not.toContain(PRIVATE_NATIVE_FACT);
  });

  it('publishes only the safe execution result and strips any effects', async () => {
    const current = store.governance.getPolicy({ spaceId });
    const policy = store.governance.setPolicy({
      spaceId,
      expectedVersion: current?.version ?? null,
      policy: { minimumApprovers: 1, assistanceMaximum: 'execute_approved_actions' },
      now: NOW,
      auth: ownerControl(),
    });
    const proposal = {
      ...rawActionProposal(),
      governancePolicyVersion: policy.version,
      state: { phase: 'approved', outcome: null, effects: [PRIVATE_NATIVE_FACT] },
    } as unknown as GenericActionProposal;
    vi.spyOn(store, 'getProposal').mockResolvedValue(proposal);
    vi.spyOn(store, 'getProposalApprovalSummary').mockResolvedValue({
      ...approvalSummary(),
      executionAuthorized: true,
    });
    mocks.actionService.execute.mockResolvedValue({
      id: proposal.id,
      phase: 'verified',
      outcome: 'verified',
      effects: [PRIVATE_NATIVE_FACT],
    });
    const request = await humanExecutionRequest(proposal.id);

    const response = await executeProposal(request);

    expect(response.status).toBe('ok');
    expect(response.result).toEqual({ id: proposal.id, phase: 'verified', outcome: 'verified' });
    expect(Object.keys(response.result!).sort()).toEqual(['id', 'outcome', 'phase']);
    expect(mocks.actionService.propose).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain(PRIVATE_NATIVE_FACT);
  });

  it('denies an unavailable selected action actor before composing execution or requesting proof', async () => {
    const proposal = mockActionRead();
    mocks.selectedActionActor.mockReturnValue(null);
    const request = event(undefined);
    request.context.params = { id: proposal.id };

    const response = await executeProposal(request);

    expect(request.node.res.statusCode).toBe(403);
    expect(response).toMatchObject({
      status: 'error', result: null, error: { code: 'FORBIDDEN', retryable: false },
    });
    expect(mocks.createActionService).not.toHaveBeenCalled();
    expect(mocks.actionService.execute).not.toHaveBeenCalled();
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it.each([
    ['review_required', 'REVIEW_REQUIRED'],
    ['invalidated_no_dispatch', 'PRECONDITION_FAILED'],
    ['write_intent', 'PRECONDITION_FAILED'],
  ] as const)('refuses a %s execution result without advertising a retry or requiring new proof', async (phase, code) => {
    const proposal = { ...rawActionProposal(), state: { phase, outcome: null } } as GenericActionProposal;
    vi.spyOn(store, 'getProposal').mockResolvedValue(proposal);
    const actor = { actorId: OWNER_ID, spaceId, budgetId };
    mocks.selectedActionActor.mockReturnValue(actor);
    mocks.actionService.execute.mockResolvedValue({ id: proposal.id, phase, outcome: null, effects: [PRIVATE_NATIVE_FACT] });
    const request = event(undefined);
    request.context.params = { id: proposal.id };

    const response = await executeProposal(request);

    expect(request.node.res.statusCode).toBe(409);
    expect(response).toMatchObject({ status: 'error', result: null, error: { code, retryable: false } });
    expect(mocks.actionService.execute).toHaveBeenCalledExactlyOnceWith(actor, proposal.id);
    expect(mocks.actionService.propose).not.toHaveBeenCalled();
    expect(mocks.actionService.reconcile).not.toHaveBeenCalled();
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain(PRIVATE_NATIVE_FACT);
  });

  it.each([
    ['Explicit decision deadline expired', 409, 'PROPOSAL_EXPIRED'],
    ['Consequential action precondition failed: source_changed', 409, 'PRECONDITION_FAILED'],
    ['Native binding unavailable', 501, 'NATIVE_UNAVAILABLE'],
  ] as const)('reports %s without retrying execution or publishing native details', async (message, status, code) => {
    const proposal = { ...rawActionProposal(), state: { phase: 'approved', outcome: null } } as GenericActionProposal;
    vi.spyOn(store, 'getProposal').mockResolvedValue(proposal);
    mocks.actionService.execute.mockRejectedValue(new Error(message, { cause: PRIVATE_NATIVE_FACT }));
    const request = await humanExecutionRequest(proposal.id);

    const response = await executeProposal(request);

    expect(request.node.res.statusCode).toBe(status);
    expect(response).toMatchObject({ status: 'error', result: null, error: { code, retryable: false } });
    expect(mocks.actionService.execute).toHaveBeenCalledOnce();
    expect(mocks.actionService.reconcile).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain(PRIVATE_NATIVE_FACT);
  });

  it.each(['policy', 'execution authority'] as const)(
    'withholds a completed write after current %s is revoked without retrying or altering its outcome', async (boundary) => {
      const current = store.governance.getPolicy({ spaceId });
      const policy = store.governance.setPolicy({
        spaceId, expectedVersion: current?.version ?? null,
        policy: { minimumApprovers: 1, assistanceMaximum: 'execute_approved_actions' },
        now: NOW, auth: ownerControl(),
      });
      const proposal = {
        ...rawActionProposal(), governancePolicyVersion: policy.version,
        state: { phase: 'approved', outcome: null },
      } as GenericActionProposal;
      vi.spyOn(store, 'getProposal').mockResolvedValue(proposal);
      const authorization = vi.spyOn(store, 'getProposalApprovalSummary')
        .mockResolvedValue({ ...approvalSummary(), executionAuthorized: true });
      const completed = Object.freeze({
        id: proposal.id, phase: 'verified', outcome: 'verified', effects: [PRIVATE_NATIVE_FACT],
      });
      mocks.actionService.execute.mockImplementation(async () => {
        if (boundary === 'policy') {
          store.governance.setPolicy({
            spaceId, expectedVersion: policy.version,
            policy: { minimumApprovers: 1, assistanceMaximum: 'analysis_only' },
            now: NOW, auth: ownerControl(),
          });
        } else authorization.mockResolvedValue({ ...approvalSummary(), executionAuthorized: false });
        return completed;
      });
      const request = await humanExecutionRequest(proposal.id);

      const response = await executeProposal(request);

      expect(request.node.res.statusCode).toBe(403);
      expect(response).toMatchObject({
        status: 'error', result: null, error: { code: 'PUBLICATION_WITHHELD', retryable: false },
      });
      expect(response.error?.message).toMatch(/completed.*withheld.*not rolled back/i);
      expect(completed).toEqual({
        id: proposal.id, phase: 'verified', outcome: 'verified', effects: [PRIVATE_NATIVE_FACT],
      });
      expect(mocks.actionService.execute).toHaveBeenCalledOnce();
      expect(mocks.actionService.propose).not.toHaveBeenCalled();
      expect(mocks.actionService.reconcile).not.toHaveBeenCalled();
      expect(JSON.stringify(response)).not.toContain(PRIVATE_NATIVE_FACT);
    },
  );

  it('denies a new action dispatch without a session-bound human proof', async () => {
    const proposal = {
      ...rawActionProposal(),
      state: { phase: 'approved', outcome: null },
    } as unknown as GenericActionProposal;
    vi.spyOn(store, 'getProposal').mockResolvedValue(proposal);
    mocks.actionService.execute.mockResolvedValue({ id: proposal.id, phase: 'verified', outcome: 'verified' });
    const request = event(undefined);
    request.context.params = { id: proposal.id };

    const response = await executeProposal(request);

    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('REAUTHENTICATION_REQUIRED');
    expect(mocks.actionService.execute).not.toHaveBeenCalled();
  });
  it('withholds action metadata when a scoped projection is unavailable', async () => {
    const raw = mockActionRead();
    mocks.actionService.getProposal.mockResolvedValue(null);
    mocks.actionService.getProposals.mockResolvedValue([]);
    const detailRequest = event(undefined);
    detailRequest.context.params = { id: raw.id };

    const detail = await proposalDetail(detailRequest);
    const listed = await listProposals(event(undefined));

    expect(detail.status).toBe('error');
    expect(listed.status).toBe('ok');
    expect(listed.result!.proposals).toEqual([]);
    expect(JSON.stringify({ detail, listed })).not.toContain(PRIVATE_NATIVE_FACT);
  });
});


describe('read-only consequential-action reconciliation', () => {
  it('fails closed when the store becomes unavailable after space selection without composing an SDK service', async () => {
    const request = event(undefined);
    request.context.params = { id: 'unavailable-store-proposal' };
    vi.spyOn(workflowStore, 'getWorkflowStore')
      .mockReturnValueOnce({ store })
      .mockReturnValueOnce({ error: PRIVATE_NATIVE_FACT });

    const response = await reconcileProposal(request);

    expect(request.node.res.statusCode).toBe(503);
    expect(response).toMatchObject({
      status: 'error', result: null, error: { code: 'STORE_UNAVAILABLE', retryable: false },
    });
    expect(mocks.createActionService).not.toHaveBeenCalled();
    expect(mocks.actionService.reconcile).not.toHaveBeenCalled();
    expect(mocks.actionService.execute).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain(PRIVATE_NATIVE_FACT);
  });

  it.each(['verified', 'write_intent', 'review_required', 'approved'] as const)(
    'returns safe %s state without execution or recent human proof', async (phase) => {
      const proposal = mockActionRead();
      const actor = { actorId: OWNER_ID, spaceId, budgetId };
      mocks.selectedActionActor.mockReturnValue(actor);
      mocks.actionService.reconcile.mockResolvedValue({
        id: proposal.id, phase, outcome: phase === 'verified' ? 'verified' : null,
        effects: [PRIVATE_NATIVE_FACT],
      });
      const request = event(undefined);
      request.context.params = { id: proposal.id };
      const response = await reconcileProposal(request);
      expect(response.status).toBe('ok');
      expect(response.result).toEqual({
        id: proposal.id, phase, outcome: phase === 'verified' ? 'verified' : null,
      });
      expect(mocks.actionService.reconcile).toHaveBeenCalledExactlyOnceWith(actor, proposal.id);
      expect(mocks.actionService.execute).not.toHaveBeenCalled();
      expect(mocks.getSession).not.toHaveBeenCalled();
      expect(mocks.verifyPassword).not.toHaveBeenCalled();
      expect(JSON.stringify(response)).not.toContain(PRIVATE_NATIVE_FACT);
    },
  );

  it.each(['origin', 'id', 'space', 'budget', 'operation', 'actor', 'missing'])(
    'rejects invalid %s before reconciliation', async (boundary) => {
      const proposal = rawActionProposal();
      vi.spyOn(store, 'getProposal').mockResolvedValue(boundary === 'missing' ? null : {
        ...proposal,
        ...(boundary === 'space' ? { spaceId: 'foreign-space' } : {}),
        ...(boundary === 'budget' ? { budgetId: 'foreign-budget' } : {}),
        ...(boundary === 'operation' ? { operation: 'set_category' } : {}),
      } as GenericActionProposal);
      if (boundary === 'actor') mocks.selectedActionActor.mockReturnValue(null);
      const request = event(undefined);
      request.context.params = { id: boundary === 'id' ? ' ' : proposal.id };
      if (boundary === 'origin') request.node.req.headers.origin = 'https://attacker.example.test';
      const response = await reconcileProposal(request);
      expect(response.status).toBe('error');
      expect(mocks.actionService.reconcile).not.toHaveBeenCalled();
      expect(mocks.actionService.execute).not.toHaveBeenCalled();
    },
  );

  it('requires a selected space with a bound budget', async () => {
    const unbound = store.governance.createSpace({
      actorId: OWNER_ID, name: 'Unbound reconciliation space', kind: 'shared',
      now: NOW, auth: ownerControl(),
    });
    const request = event(undefined, unbound.id);
    request.context.params = { id: 'unbound-proposal' };
    const response = await reconcileProposal(request);
    expect(response).toMatchObject({ status: 'error', error: { code: 'SPACE_BUDGET_REQUIRED' } });
    expect(mocks.actionService.reconcile).not.toHaveBeenCalled();
    expect(mocks.actionService.execute).not.toHaveBeenCalled();
  });

  it('withholds private service failure details', async () => {
    const proposal = mockActionRead();
    mocks.actionService.reconcile.mockRejectedValue(new Error(PRIVATE_NATIVE_FACT));
    const request = event(undefined);
    request.context.params = { id: proposal.id };
    const response = await reconcileProposal(request);
    expect(response.status).toBe('error');
    expect(JSON.stringify(response)).not.toContain(PRIVATE_NATIVE_FACT);
    expect(mocks.actionService.execute).not.toHaveBeenCalled();
  });
});
