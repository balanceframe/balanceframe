import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { HumanControlContext } from '../src/governance-types.js';
import type { SpendSession } from '../src/liquidity-types.js';
import { SqliteWorkflowStore } from '../src/store.js';

const now = '2098-01-01T00:00:00.000Z';
const expiresAt = '2099-01-01T00:00:00.000Z';
const budgetId = 'budget';
const actorId = 'holder';
const accountId = 'checking';
const categoryId = 'food';
const auth = (actorId: string, reauthenticatedAt = now): HumanControlContext => ({
  method: 'human-session',
  actorId,
  sessionId: `session:${actorId}`,
  reauthenticatedAt,
});
const money = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function hashPayload(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

interface CompletionManualInput {
  parentId: string;
  correlationId: string;
  accountId: string;
  amount: number;
  date: string;
  categoryId?: string | null;
  payeeName?: string;
  notes?: string;
  splits?: Array<{ amount: number; accountId: string; date: string; categoryId: string }>;
}
interface CompletionPayload {
  kind: 'session_completion';
  sessionId: string;
  sessionVersion: number;
  intentHash: string;
  materialHash: string;
  manualInput: CompletionManualInput;
  categoryCharges: Array<{ categoryId: string; amount: { minorUnits: string; currency: string } }>;
  cooldownUntil: string | null;
}
interface CompletionClaim {
  id: string;
  creationSnapshotId: string;
  creationPolicyVersion: string;
  state: 'active' | 'initiated';
  expiresAt: string;
  initiated: boolean;
  effects: Array<{
    kind: 'category' | 'account_debit' | 'destination_hold';
    resourceId: string;
    amount: { minorUnits: string; currency: string };
    economicObligationId: string;
    categoryId: string | null;
    includedInBalance: boolean;
    matchedTransactionIds: string[];
  }>;
}
interface CompletionState {
  phase: 'proposed' | 'approved' | 'write_intent' | 'verified' | 'review_required' | 'closed';
  outcome: string | null;
}
interface CompletionProposal {
  id: string;
  budgetId: string;
  version: number;
  payloadHash: string;
  payload: CompletionPayload;
  state: CompletionState;
  approvalId: string | null;
  approvalCount: number;
  requiredApprovals: number;
  approvalStatus: 'none' | 'active' | 'consumed' | 'superseded' | 'expired';
}
interface CompletionEvidence {
  evidenceId: string;
  kind: 'manual_parent' | 'imported_link' | 'ambiguous';
  parentId: string;
  accountId: string;
  transactionId?: string;
  verified: boolean;
  reason?: string;
}
interface ValidatorResult {
  valid: boolean;
  reason?: string;
}
type Validator = (context: unknown) => ValidatorResult;
interface FinancialContext {
  actorId: string;
  budgetId: string;
  spaceId: string;
  membershipId: string;
  governancePolicyVersion: string;
  now: string;
  auth: HumanControlContext;
}
interface AdmissionInput extends FinancialContext {
  sessionId: string;
  expectedSessionVersion: number;
  payload: CompletionPayload;
  payloadHash: string;
  claim: CompletionClaim;
  expectedClaimSetRevision: string;
  idempotencyKey: string;
}
interface CompletionCommand extends FinancialContext {
  proposalId: string;
  payloadHash: string;
  expectedVersion: number;
  idempotencyKey: string;
}
interface VersionedCompletionCommand extends CompletionCommand {
  expectedClaimSetRevision: string;
}
interface FinishCommand extends CompletionCommand {
  result: {
    success: boolean;
    verified: boolean;
    parentId: string;
    transactionId?: string;
    code?: string;
    reviewRequired?: boolean;
    evidenceId?: string;
  };
}
interface BeginResult {
  proposal: CompletionProposal;
  payload: CompletionPayload | null;
  acquiredWriteIntent: boolean;
}
interface CompletionWorkflow {
  admitSessionCompletion(input: AdmissionInput, validator: Validator): CompletionProposal;
  approveSessionCompletion(input: VersionedCompletionCommand, validator: Validator): CompletionProposal;
  beginSessionCompletionWrite(input: VersionedCompletionCommand, validator: Validator): BeginResult;
  finishSessionCompletionWrite(input: FinishCommand): CompletionProposal;
  reconcileSessionCompletion(
    input: VersionedCompletionCommand & { evidence: CompletionEvidence },
  ): CompletionProposal;
  getSessionCompletionProposal(
    input: FinancialContext & { proposalId: string },
  ): CompletionProposal;
}

const completion = (store: SqliteWorkflowStore): CompletionWorkflow =>
  store.liquidity as unknown as CompletionWorkflow;

function payload(sessionId: string, sessionVersion: number): CompletionPayload {
  return {
    kind: 'session_completion',
    sessionId,
    sessionVersion,
    intentHash: hashPayload({ sessionId, sessionVersion }),
    materialHash: hashPayload({ snapshot: 'fixture' }),
    manualInput: {
      parentId: 'session-parent-001',
      correlationId: 'session-correlation-001',
      accountId,
      amount: -1000,
      date: '2098-01-01',
      categoryId,
    },
    categoryCharges: [{ categoryId, amount: money('1000') }],
    cooldownUntil: null,
  };
}

function claim(claimId = 'completion-claim-001', policyVersion = '1'): CompletionClaim {
  return {
    id: claimId,
    creationSnapshotId: 'snapshot-001',
    creationPolicyVersion: policyVersion,
    state: 'active',
    expiresAt,
    initiated: false,
    effects: [
      {
        kind: 'account_debit',
        resourceId: accountId,
        amount: money('1000'),
        economicObligationId: 'completion:session-001:account:checking',
        categoryId: null,
        includedInBalance: false,
        matchedTransactionIds: [],
      },
      {
        kind: 'category',
        resourceId: categoryId,
        amount: money('1000'),
        economicObligationId: 'completion:session-001:category:food',
        categoryId,
        includedInBalance: false,
        matchedTransactionIds: [],
      },
    ],
  };
}

const capabilities = [
  'conclusion',
  'existence',
  'name',
  'balance',
  'history',
  'liquidity',
  'source',
  'category',
  'proposal',
  'approval',
  'initiation-report',
  'confirmation',
  'audit',
  'policy',
  'session',
] as const;

describe('session completion durable workflow', () => {
  let store: SqliteWorkflowStore;
  let spaceId: string;
  beforeEach(async () => {
    store = new SqliteWorkflowStore(':memory:');
    const claimId = 'session-completion-bootstrap';
    await store.claimBootstrap({ name: 'Owner', email: 'owner@example.com', claimId });
    await store.finalizeBootstrap({ claimId, ownerUserId: actorId });
    const space = store.governance.createSpace({
      actorId,
      name: 'Session completion',
      kind: 'shared',
      now,
      auth: auth(actorId),
    });
    spaceId = store.governance.bindBudget({
      spaceId: space.id,
      budgetId,
      now,
      auth: auth(actorId),
    }).id;

    const owner = financialContext();
    for (const capability of capabilities)
      for (const [resourceKind, resourceId] of [
        ['budget', budgetId],
        ['account', accountId],
        ['category', categoryId],
      ] as const)
        provisionGrant(owner, capability, resourceKind, resourceId);
    store.liquidity.savePolicy({
      ...owner,
      expectedVersion: null,
      expectedGovernancePolicyVersion: owner.governancePolicyVersion,
      policy: { version: '1', policyHash: 'policy', expiresAt, accounts: [], transferRoutes: [] },
      approvalPolicy: { minimumApprovers: 1 },
    });
  });
  afterEach(() => store.close());

  function financialContext(forActorId = actorId, at = now): FinancialContext {
    const membership = store.governance.getCurrentMembership({
      spaceId,
      actorId: forActorId,
      now: at,
    });
    const policy = store.governance.getPolicy({ spaceId });
    if (!membership || !policy) throw new Error('Expected current test membership and policy');
    return {
      actorId: forActorId,
      budgetId,
      spaceId,
      membershipId: membership.id,
      governancePolicyVersion: policy.version,
      now: at,
      auth: auth(forActorId, at),
    };
  }

  function provisionGrant(
    context: FinancialContext,
    capability: string,
    resourceKind: 'budget' | 'account' | 'category',
    resourceId: string,
    granted = true,
  ): void {
    store.governance.provisionResourceGrant({
      spaceId: context.spaceId,
      actorId: context.actorId,
      budgetId: context.budgetId,
      membershipId: context.membershipId,
      capability,
      resourceKind,
      resourceId,
      granted,
      now: context.now,
    });
  }

  async function addApprover(approverId: string): Promise<FinancialContext> {
    // Identity only; financial authority is granted to the exact space membership below.
    await store.upsertActorMembership(approverId, 'active', [], '');
    const membership = store.governance.addMembership({
      spaceId,
      actorId: approverId,
      validFrom: now,
      now,
      auth: auth(actorId),
    });
    const approver = { ...financialContext(approverId), membershipId: membership.id };
    provisionGrant(approver, 'session', 'budget', budgetId);
    provisionGrant(approver, 'proposal', 'budget', budgetId);
    provisionGrant(approver, 'approval', 'budget', budgetId);
    for (const [resourceKind, resourceId] of [
      ['account', accountId],
      ['category', categoryId],
    ] as const) {
      provisionGrant(approver, 'liquidity', resourceKind, resourceId);
      provisionGrant(approver, 'approval', resourceKind, resourceId);
      provisionGrant(approver, 'proposal', resourceKind, resourceId);
    }
    return financialContext(approverId);
  }

  function saveSession(): SpendSession {
    return store.liquidity.saveSpendSession(
      {
        ...financialContext(),
        id: 'session-001',
        expectedVersion: 0,
        idempotencyKey: 'session-create',
        expiresAt,
        accountId,
        items: [
          {
            id: 'item-001',
            categoryId,
            amount: money('1000'),
            accountId,
            purchaseAt: now,
            requiredBy: expiresAt,
          },
        ],
      },
      () => ({ valid: true }),
    );
  }
  it('keeps specialized session completion admission bound to its human session owner', async () => {
    const session = saveSession();
    const agentId = 'agent:specialized-completion-admission';
    const credentialId = 'key:specialized-completion-admission';
    store.governance.registerAgent({ spaceId, agentId, now, auth: auth(actorId) });
    const rights = [
      { capability: 'session', resourceKind: 'budget' as const, resourceId: budgetId },
      { capability: 'proposal', resourceKind: 'budget' as const, resourceId: budgetId },
      { capability: 'liquidity', resourceKind: 'account' as const, resourceId: accountId },
      { capability: 'proposal', resourceKind: 'account' as const, resourceId: accountId },
      { capability: 'liquidity', resourceKind: 'category' as const, resourceId: categoryId },
      { capability: 'proposal', resourceKind: 'category' as const, resourceId: categoryId },
    ];
    const delegation = store.governance.delegate({
      spaceId,
      agentId,
      issuerMembershipId: financialContext().membershipId,
      expectedVersion: null,
      rights,
      validFrom: now,
      validUntil: expiresAt,
      now,
      auth: auth(actorId),
    });
    const agentAuth = {
      method: 'api-key' as const,
      actorId: agentId,
      credentialId,
      credentialOwnerId: actorId,
      principalType: 'agent' as const,
      delegationId: delegation.id,
      delegationVersion: delegation.version,
    };
    store.governance.registerCredentialBinding({
      spaceId,
      credentialId,
      credentialOwnerId: actorId,
      principalType: 'agent',
      principalId: agentId,
      delegationId: delegation.id,
      expectedDelegationVersion: delegation.version,
      now,
      auth: auth(actorId),
    });
    const completionPayload = payload(session.id, session.version);
    expect(() => store.liquidity.admitSessionCompletion({
      actorId: agentId,
      budgetId,
      spaceId,
      membershipId: financialContext().membershipId,
      governancePolicyVersion: financialContext().governancePolicyVersion,
      now,
      auth: agentAuth,
      agentId,
      delegationId: delegation.id,
      sessionId: session.id,
      expectedSessionVersion: session.version,
      payload: completionPayload,
      payloadHash: hashPayload(completionPayload),
      claim: claim('agent-completion-claim'),
      expectedClaimSetRevision: '0',
      idempotencyKey: 'agent-specialized-completion-admit',
    }, () => ({ valid: true }))).toThrow(/Session authorization denied/);
    expect(store['db'].prepare(
      "SELECT id FROM action_proposals WHERE operation='session_completion'",
    ).all()).toEqual([]);
    expect(store.liquidity.getClaimSet(financialContext()).bundles).toEqual([]);
  });

  function admit(
    sessionVersion = 1,
    expectedClaimSetRevision = '0',
    idempotencyKey = 'completion-admit',
    claimId = 'completion-claim-001',
    policyVersion = '1',
    parentId = 'session-parent-001',
  ): CompletionProposal {
    const requestPayload = payload('session-001', sessionVersion);
    if (parentId !== requestPayload.manualInput.parentId) {
      requestPayload.manualInput.parentId = parentId;
      requestPayload.manualInput.correlationId = `${parentId}:correlation`;
    }
    return completion(store).admitSessionCompletion(
      {
        ...financialContext(),
        sessionId: 'session-001',
        expectedSessionVersion: sessionVersion,
        payload: requestPayload,
        payloadHash: hashPayload(requestPayload),
        claim: claim(claimId, policyVersion),
        expectedClaimSetRevision,
        idempotencyKey,
      },
      () => ({ valid: true }),
    );
  }
  async function approveAsPeer(
    api: CompletionWorkflow,
    proposal: CompletionProposal,
    expectedClaimSetRevision: string,
    idempotencyKey: string,
  ): Promise<CompletionProposal> {
    const approver = await addApprover(`${idempotencyKey}-approver`);
    return api.approveSessionCompletion({
      ...approver,
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      expectedVersion: proposal.version,
      expectedClaimSetRevision,
      idempotencyKey,
    }, () => ({ valid: true }));
  }

  it('admits, approves, and grants exactly one durable write intent', async () => {
    saveSession();
    const api = completion(store);
    const admitted = admit();
    expect(admitted.state.phase).toBe('proposed');
    expect(admitted.approvalCount).toBe(0);
    expect(admitted.approvalStatus).toBe('none');

    const approver = await addApprover('completion-approver');
    const approved = api.approveSessionCompletion(
      {
        ...approver,
        proposalId: admitted.id,
        payloadHash: admitted.payloadHash,
        expectedVersion: admitted.version,
        expectedClaimSetRevision: '1',
        idempotencyKey: 'completion-approve',
      },
      () => ({ valid: true }),
    );
    expect(approved.state.phase).toBe('approved');
    expect(approved.approvalCount).toBe(1);
    expect(approved.approvalStatus).toBe('active');

    const first = api.beginSessionCompletionWrite(
      {
        ...financialContext(),
        proposalId: admitted.id,
        payloadHash: admitted.payloadHash,
        expectedVersion: approved.version,
        expectedClaimSetRevision: '1',
        idempotencyKey: 'completion-begin-1',
      },
      () => ({ valid: true }),
    );
    expect(first.acquiredWriteIntent).toBe(true);
    expect(first.payload).toEqual(admitted.payload);
    expect(first.proposal.state.phase).toBe('write_intent');

    const replay = api.beginSessionCompletionWrite(
      {
        ...financialContext(),
        proposalId: admitted.id,
        payloadHash: admitted.payloadHash,
        expectedVersion: first.proposal.version,
        expectedClaimSetRevision: '2',
        idempotencyKey: 'completion-begin-2',
      },
      () => ({ valid: true }),
    );
    expect(replay.acquiredWriteIntent).toBe(false);
    expect(replay.payload).toBeNull();
    expect(replay.proposal.state.phase).toBe('write_intent');
  });

  it('requires confirmation capability before starting an Actual write', async () => {
    saveSession();
    const api = completion(store);
    const admitted = admit();
    const approver = await addApprover('confirmation-approver');
    const approved = api.approveSessionCompletion({
      ...approver,
      proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: admitted.version, expectedClaimSetRevision: '1',
      idempotencyKey: 'approval-before-confirmation-revoke',
    }, () => ({ valid: true }));
    provisionGrant(financialContext(), 'confirmation', 'budget', budgetId, false);
    expect(() => api.beginSessionCompletionWrite({
      ...financialContext(),
      proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: approved.version, expectedClaimSetRevision: '1',
      idempotencyKey: 'write-without-confirmation',
    }, () => ({ valid: true }))).toThrow();
    expect(api.getSessionCompletionProposal({
      ...financialContext(), proposalId: admitted.id,
    }).state.phase).toBe('approved');
  });
  it.each([
    ['proposal grant revoked', false, undefined],
    ['gross outgoing limit narrowed', true, { maxGrossOutgoing: [money('999')] }],
    ['operation count limit narrowed', true, { maxOperationCount: 0 }],
  ] as const)(
    'does not begin a completion write after origin %s',
    async (originChange, proposalGrantRemains, restrictions) => {
      saveSession();
      const api = completion(store);
      const admitted = admit();
      const approver = await addApprover('origin-authority-approver');
      const approved = api.approveSessionCompletion({
        ...approver,
        proposalId: admitted.id,
        payloadHash: admitted.payloadHash,
        expectedVersion: admitted.version,
        expectedClaimSetRevision: '1',
        idempotencyKey: `origin-authority-approve:${originChange}`,
      }, () => ({ valid: true }));
      const executor = await addApprover('origin-authority-executor');
      for (const capability of ['initiation-report', 'confirmation'] as const)
        for (const [resourceKind, resourceId] of [
          ['budget', budgetId],
          ['account', accountId],
          ['category', categoryId],
        ] as const)
          provisionGrant(executor, capability, resourceKind, resourceId);

      const origin = financialContext();
      store.governance.provisionResourceGrant({
        spaceId,
        actorId,
        membershipId: origin.membershipId,
        budgetId,
        capability: 'proposal',
        resourceKind: 'account',
        resourceId: accountId,
        granted: proposalGrantRemains,
        restrictions: restrictions ?? {},
        now,
      });

      const input = {
        ...executor,
        proposalId: admitted.id,
        payloadHash: admitted.payloadHash,
        expectedVersion: approved.version,
        expectedClaimSetRevision: '1',
        idempotencyKey: `origin-authority-begin:${originChange}`,
      };
      const proposalBefore = await store.getProposal(admitted.id);
      const claimsBefore = store.liquidity.getClaimSet(financialContext());
      let validatorCalls = 0;
      const validator: Validator = () => {
        validatorCalls++;
        return { valid: true };
      };

      expect(() => api.beginSessionCompletionWrite(input, validator)).toThrow();
      expect(validatorCalls).toBe(0);
      expect(await store.getProposal(admitted.id)).toEqual(proposalBefore);
      expect(store.liquidity.getClaimSet(financialContext())).toEqual(claimsBefore);
      expect(store['db'].prepare(
        'SELECT proposal_id FROM session_completion_writes WHERE proposal_id=?',
      ).get(admitted.id)).toBeUndefined();
    },
  );

  it('requires distinct currently authorized approvers before granting a write intent', async () => {
    const policyContext = financialContext();
    store.liquidity.savePolicy({
      ...policyContext,
      expectedVersion: '1',
      expectedGovernancePolicyVersion: policyContext.governancePolicyVersion,
      policy: { version: '2', policyHash: 'policy-2', expiresAt, accounts: [], transferRoutes: [] },
      approvalPolicy: { minimumApprovers: 2 },
    });
    saveSession();
    const api = completion(store);
    const admitted = admit(1, '0', 'multi-admit', 'multi-claim', '2');
    const requesterVote = api.approveSessionCompletion({
      ...financialContext(),
      proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: admitted.version, expectedClaimSetRevision: '1',
      idempotencyKey: 'multi-requester-vote',
    }, () => ({ valid: true }));
    expect(requesterVote.state.phase).toBe('proposed');
    expect(requesterVote.approvalCount).toBe(0);
    expect(() => api.approveSessionCompletion({
      ...financialContext(),
      proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: requesterVote.version, expectedClaimSetRevision: '1',
      idempotencyKey: 'multi-requester-duplicate',
    }, () => ({ valid: true }))).toThrow();
    expect(api.getSessionCompletionProposal({
      ...financialContext(), proposalId: admitted.id,
    }).approvalCount).toBe(0);

    const firstApprover = await addApprover('first-approver');
    const first = api.approveSessionCompletion({
      ...firstApprover,
      proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: requesterVote.version, expectedClaimSetRevision: '1',
      idempotencyKey: 'multi-first',
    }, () => ({ valid: true }));
    expect(first.state.phase).toBe('proposed');
    expect(first.approvalCount).toBe(1);
    expect(() => api.approveSessionCompletion({
      ...financialContext('first-approver'),
      proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: first.version, expectedClaimSetRevision: '1',
      idempotencyKey: 'multi-same-actor',
    }, () => ({ valid: true }))).toThrow();
    expect(api.getSessionCompletionProposal({
      ...financialContext('first-approver'), proposalId: admitted.id,
    }).approvalCount).toBe(1);

    const secondApprover = await addApprover('second-approver');
    const second = api.approveSessionCompletion({
      ...secondApprover,
      proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: first.version, expectedClaimSetRevision: '1',
      idempotencyKey: 'multi-second',
    }, () => ({ valid: true }));
    expect(second.state.phase).toBe('approved');
    expect(second.approvalCount).toBe(2);

    provisionGrant(financialContext('first-approver'), 'session', 'budget', budgetId, false);
    expect(api.getSessionCompletionProposal({
      ...financialContext(), proposalId: admitted.id,
    }).approvalCount).toBe(1);
    expect(() => api.beginSessionCompletionWrite({
      ...financialContext(),
      proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: second.version, expectedClaimSetRevision: '1',
      idempotencyKey: 'multi-write-revoked-session',
    }, () => ({ valid: true }))).toThrow();
    provisionGrant(financialContext('first-approver'), 'session', 'budget', budgetId);
    expect(api.beginSessionCompletionWrite({
      ...financialContext(),
      proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: second.version, expectedClaimSetRevision: '1',
      idempotencyKey: 'multi-write',
    }, () => ({ valid: true })).acquiredWriteIntent).toBe(true);
  });
  it('requires the displayed payload hash before recording approval or write intent', async () => {
    saveSession();
    const api = completion(store);
    const admitted = admit();
    const approver = await addApprover('wrong-hash-approver');
    const auditCount = () => {
      const row = store['db']
        .prepare('SELECT COUNT(*) AS count FROM audit_records WHERE proposal_id=?')
        .get(admitted.id);
      if (!row || typeof row !== 'object' || !('count' in row) || typeof row.count !== 'number')
        throw new Error('Audit count unavailable');
      return row.count;
    };
    const beforeApproval = auditCount();

    expect(() => api.approveSessionCompletion({
      ...approver,
      proposalId: admitted.id,
      payloadHash: 'f'.repeat(64),
      expectedVersion: admitted.version,
      expectedClaimSetRevision: '1',
      idempotencyKey: 'wrong-hash-approve',
    }, () => ({ valid: true }))).toThrow(/Payload hash mismatch/);
    expect(auditCount()).toBe(beforeApproval);
    expect(api.getSessionCompletionProposal({
      ...financialContext(), proposalId: admitted.id,
    })).toMatchObject({
      version: admitted.version,
      state: { phase: 'proposed' },
      approvalCount: 0,
      approvalStatus: 'none',
    });

    const approved = api.approveSessionCompletion({
      ...approver,
      proposalId: admitted.id,
      payloadHash: admitted.payloadHash,
      expectedVersion: admitted.version,
      expectedClaimSetRevision: '1',
      idempotencyKey: 'exact-hash-approve',
    }, () => ({ valid: true }));
    const claimsBeforeWrite = store.liquidity.getClaimSet({ ...financialContext() });
    const auditsBeforeWrite = auditCount();

    expect(() => api.beginSessionCompletionWrite({
      ...financialContext(),
      proposalId: admitted.id,
      payloadHash: 'e'.repeat(64),
      expectedVersion: approved.version,
      expectedClaimSetRevision: '1',
      idempotencyKey: 'wrong-hash-begin',
    }, () => ({ valid: true }))).toThrow(/Payload hash mismatch/);
    expect(auditCount()).toBe(auditsBeforeWrite);
    expect(store.liquidity.getClaimSet({ ...financialContext() })).toEqual(claimsBeforeWrite);
    expect(api.getSessionCompletionProposal({
      ...financialContext(), proposalId: admitted.id,
    })).toMatchObject({
      version: approved.version,
      state: { phase: 'approved' },
      approvalCount: 1,
      approvalStatus: 'active',
    });
  });

  it('reconciles initiated completions with current human authority after migration and membership changes', async () => {
    saveSession();
    const api = completion(store);
    const admitted = admit();
    const approver = await addApprover('departed-completion-approver');
    const approved = api.approveSessionCompletion({
      ...approver,
      proposalId: admitted.id,
      payloadHash: admitted.payloadHash,
      expectedVersion: admitted.version,
      expectedClaimSetRevision: '1',
      idempotencyKey: 'initiated-completion-approval',
    }, () => ({ valid: true }));
    const started = api.beginSessionCompletionWrite({
      ...financialContext(),
      proposalId: admitted.id,
      payloadHash: admitted.payloadHash,
      expectedVersion: approved.version,
      expectedClaimSetRevision: '1',
      idempotencyKey: 'initiated-completion-write',
    }, () => ({ valid: true }));
    expect(started.acquiredWriteIntent).toBe(true);
    const held = store.liquidity.getClaimSet({ ...financialContext() });
    expect(held.bundles).toMatchObject([{ id: 'completion-claim-001', state: 'initiated' }]);

    const later = '2098-01-01T00:10:00.000Z';
    const managerId = 'completion-governor';
    await store.upsertActorMembership(managerId, 'active', [], '');
    const managerMembership = store.governance.addMembership({
      spaceId,
      actorId: managerId,
      validFrom: now,
      now,
      auth: auth(actorId),
    });
    for (const capability of ['identity:manage', 'policy:manage'] as const)
      store.governance.provisionResourceGrant({
        spaceId,
        actorId: managerId,
        membershipId: managerMembership.id,
        capability,
        resourceKind: 'space',
        resourceId: spaceId,
        granted: true,
        now,
      });
    const managerAuth = auth(managerId, later);
    store.governance.revokeMembership({
      spaceId,
      membershipId: financialContext().membershipId,
      now: later,
      auth: managerAuth,
    });
    store.governance.revokeMembership({
      spaceId,
      membershipId: approver.membershipId,
      now: later,
      auth: managerAuth,
    });
    store.governance.addMembership({
      spaceId,
      actorId,
      validFrom: later,
      now: later,
      auth: managerAuth,
    });
    const policy = store.governance.getPolicy({ spaceId });
    if (!policy) throw new Error('Expected governance policy');
    store.governance.setPolicy({
      spaceId,
      expectedVersion: policy.version,
      policy: { minimumApprovers: 2, approvalThresholds: [] },
      now: later,
      auth: managerAuth,
    });

    for (const currentActor of [actorId, 'completion-reconciler']) {
      if (currentActor !== actorId) {
        await store.upsertActorMembership(currentActor, 'active', [], '');
        store.governance.addMembership({
          spaceId,
          actorId: currentActor,
          validFrom: later,
          now: later,
          auth: managerAuth,
        });
      }
      const context = financialContext(currentActor, later);
      for (const capability of capabilities)
        for (const [resourceKind, resourceId] of [
          ['budget', budgetId],
          ['account', accountId],
          ['category', categoryId],
        ] as const)
          provisionGrant(context, capability, resourceKind, resourceId);
    }
    const reconciliationActor = financialContext('completion-reconciler', later);
    expect(() => store.liquidity.getSpendSession({
      ...financialContext(actorId, later),
      id: 'session-001',
      now: later,
    })).toThrow();

    // A migrated initiated row can lack the original requester and approver provenance.
    store['db'].prepare(
      'UPDATE action_proposals SET requester_membership_id=NULL,governance_policy_version=NULL WHERE id=?',
    ).run(admitted.id);
    store['db'].prepare(
      'UPDATE proposal_approvals SET issuer_membership_id=NULL,governance_policy_version=NULL WHERE proposal_id=?',
    ).run(admitted.id);
    expect(api.getSessionCompletionProposal({
      ...reconciliationActor, proposalId: admitted.id,
    }).approvalCount).toBe(0);
    expect(store.liquidity.getClaimSet({ ...financialContext(actorId, later) }).bundles)
      .toMatchObject([{ id: 'completion-claim-001', state: 'initiated' }]);

    expect(() => api.finishSessionCompletionWrite({
      ...reconciliationActor,
      proposalId: admitted.id,
      payloadHash: admitted.payloadHash,
      expectedVersion: started.proposal.version,
      idempotencyKey: 'bad-finish-identity',
      result: {
        success: true,
        verified: true,
        parentId: admitted.payload.manualInput.parentId,
        transactionId: 'different-parent',
      },
    })).toThrow(/Invalid completion parent transaction identity/);
    expect(store.liquidity.getClaimSet({ ...financialContext(actorId, later) })).toEqual(held);

    const common = {
      ...reconciliationActor,
      proposalId: admitted.id,
      payloadHash: admitted.payloadHash,
      expectedVersion: started.proposal.version,
      expectedClaimSetRevision: store.liquidity.getClaimSet(reconciliationActor).revision,
    };
    const exactEvidence = {
      evidenceId: `manual:${accountId}:${admitted.payload.manualInput.parentId}`,
      kind: 'manual_parent' as const,
      parentId: admitted.payload.manualInput.parentId,
      accountId,
      transactionId: admitted.payload.manualInput.parentId,
      verified: true,
    };
    const invalidProofs = [
      {
        auth: {
          method: 'session' as const,
          actorId: reconciliationActor.actorId,
          sessionId: `session:${reconciliationActor.actorId}`,
        },
        idempotencyKey: 'ordinary-session-completion-reconcile',
      },
      {
        auth: auth(reconciliationActor.actorId, now),
        idempotencyKey: 'stale-human-completion-reconcile',
      },
      {
        auth: auth(reconciliationActor.actorId, '2098-01-01T00:20:00.000Z'),
        idempotencyKey: 'future-human-completion-reconcile',
      },
    ];
    for (const proof of invalidProofs)
      expect(() => api.reconcileSessionCompletion({
        ...common,
        ...proof,
        evidence: exactEvidence,
      })).toThrow(/Current human reconciliation required/);
    expect(() => api.finishSessionCompletionWrite({
      ...reconciliationActor,
      auth: {
        method: 'session',
        actorId: reconciliationActor.actorId,
        sessionId: `session:${reconciliationActor.actorId}`,
      },
      proposalId: admitted.id,
      payloadHash: admitted.payloadHash,
      expectedVersion: started.proposal.version,
      idempotencyKey: 'ordinary-session-completion-finish',
      result: {
        success: true,
        verified: true,
        parentId: admitted.payload.manualInput.parentId,
        transactionId: admitted.payload.manualInput.parentId,
      },
    })).toThrow(/Current human reconciliation required/);
    expect(store.liquidity.getClaimSet({ ...financialContext(actorId, later) })).toEqual(held);
    expect(() => api.reconcileSessionCompletion({
      ...common,
      idempotencyKey: 'bad-completion-evidence',
      evidence: {
        evidenceId: 'manual:checking:wrong-parent',
        kind: 'manual_parent',
        parentId: 'wrong-parent',
        accountId,
        transactionId: 'wrong-parent',
        verified: true,
      },
    })).toThrow(/Reconciliation parent mismatch/);
    expect(store.liquidity.getClaimSet({ ...financialContext(actorId, later) })).toEqual(held);

    const reconciled = api.reconcileSessionCompletion({
      ...common,
      idempotencyKey: 'exact-actual-completion-evidence',
      evidence: exactEvidence,
    });
    expect(reconciled.state.phase).toBe('verified');
    expect(store.liquidity.getClaimSet({ ...financialContext(actorId, later) }).bundles).toEqual([]);
    expect(store['db'].prepare(
      'SELECT status FROM session_completion_writes WHERE proposal_id=?',
    ).get(admitted.id)).toMatchObject({ status: 'verified' });
  });

  it('allows a current human to finish a verified initiated completion after original approval rights expire', async () => {
    saveSession();
    const api = completion(store);
    const admitted = admit();
    const approver = await addApprover('departed-finish-approver');
    const approved = api.approveSessionCompletion({
      ...approver,
      proposalId: admitted.id,
      payloadHash: admitted.payloadHash,
      expectedVersion: admitted.version,
      expectedClaimSetRevision: '1',
      idempotencyKey: 'finish-after-departure-approval',
    }, () => ({ valid: true }));
    const started = api.beginSessionCompletionWrite({
      ...financialContext(),
      proposalId: admitted.id,
      payloadHash: admitted.payloadHash,
      expectedVersion: approved.version,
      expectedClaimSetRevision: '1',
      idempotencyKey: 'finish-after-departure-write',
    }, () => ({ valid: true }));
    const later = '2098-01-01T00:20:00.000Z';
    const managerId = 'completion-finish-governor';
    await store.upsertActorMembership(managerId, 'active', [], '');
    const managerMembership = store.governance.addMembership({
      spaceId,
      actorId: managerId,
      validFrom: now,
      now,
      auth: auth(actorId),
    });
    for (const capability of ['identity:manage', 'policy:manage'] as const)
      store.governance.provisionResourceGrant({
        spaceId,
        actorId: managerId,
        membershipId: managerMembership.id,
        capability,
        resourceKind: 'space',
        resourceId: spaceId,
        granted: true,
        now,
      });
    const managerAuth = auth(managerId, later);
    store.governance.revokeMembership({
      spaceId, membershipId: financialContext().membershipId, now: later, auth: managerAuth,
    });
    store.governance.revokeMembership({
      spaceId, membershipId: approver.membershipId, now: later, auth: managerAuth,
    });
    store.governance.addMembership({
      spaceId, actorId, validFrom: later, now: later, auth: managerAuth,
    });
    const policy = store.governance.getPolicy({ spaceId });
    if (!policy) throw new Error('Expected governance policy');
    store.governance.setPolicy({
      spaceId,
      expectedVersion: policy.version,
      policy: { minimumApprovers: 2, approvalThresholds: [] },
      now: later,
      auth: managerAuth,
    });
    const current = financialContext(actorId, later);
    for (const capability of capabilities)
      for (const [resourceKind, resourceId] of [
        ['budget', budgetId],
        ['account', accountId],
        ['category', categoryId],
      ] as const)
        provisionGrant(current, capability, resourceKind, resourceId);

    const finished = api.finishSessionCompletionWrite({
      ...current,
      proposalId: admitted.id,
      payloadHash: admitted.payloadHash,
      expectedVersion: started.proposal.version,
      idempotencyKey: 'finish-after-departure-actual-success',
      result: {
        success: true,
        verified: true,
        parentId: admitted.payload.manualInput.parentId,
        transactionId: admitted.payload.manualInput.parentId,
      },
    });
    expect(finished.state.phase).toBe('verified');
    expect(store.liquidity.getClaimSet(current).bundles).toEqual([]);
  });


  it('supersedes pre-write completions on session edit but retains an initiated hold', async () => {
    const session = saveSession();
    const api = completion(store);
    const admitted = admit();

    store.liquidity.saveSpendSession(
      {
        ...financialContext(),
        id: session.id,
        expectedVersion: session.version,
        idempotencyKey: 'session-edit',
        expiresAt,
        accountId,
        items: session.items,
      },
      () => ({ valid: true }),
    );
    expect(api.getSessionCompletionProposal({
      ...financialContext(), proposalId: admitted.id,
    }).state).toMatchObject({
      phase: 'closed',
      outcome: 'superseded',
    });
    expect(store.liquidity.getClaimSet({ ...financialContext() }).bundles).toEqual([]);

    const second = admit(2, '2', 'completion-admit-2', 'completion-claim-002');
    const approved = await approveAsPeer(api, second, '3', 'completion-approve-2');
    const started = api.beginSessionCompletionWrite(
      {
        ...financialContext(),
        proposalId: second.id,
        payloadHash: second.payloadHash,
        expectedVersion: approved.version,
        expectedClaimSetRevision: '3',
        idempotencyKey: 'completion-begin-3',
      },
      () => ({ valid: true }),
    );
    expect(started.acquiredWriteIntent).toBe(true);

    store.liquidity.cancelSpendSession({
      ...financialContext(),
      id: session.id,
      expectedVersion: 2,
      idempotencyKey: 'session-cancel',
    });
    expect(api.getSessionCompletionProposal({
      ...financialContext(), proposalId: second.id,
    }).state.phase).toBe('write_intent');
    expect(store.liquidity.getClaimSet({ ...financialContext() }).bundles[0]?.state).toBe(
      'initiated',
    );
    expect(api.finishSessionCompletionWrite({
      ...financialContext(),
      proposalId: second.id,
      payloadHash: second.payloadHash,
      expectedVersion: started.proposal.version,
      idempotencyKey: 'finish-after-cancel',
      result: { success: true, verified: true,
        parentId: second.payload.manualInput.parentId,
        transactionId: second.payload.manualInput.parentId },
    }).state.phase).toBe('verified');
  });

  it('retains an initiated claim for an uncertain write and requires evidence identity to settle', async () => {
    saveSession();
    const api = completion(store);
    const admitted = admit();
    const approved = await approveAsPeer(api, admitted, '1', 'completion-approve-review');
    const started = api.beginSessionCompletionWrite(
      {
        ...financialContext(),
        proposalId: admitted.id,
        payloadHash: admitted.payloadHash,
        expectedVersion: approved.version,
        expectedClaimSetRevision: '1',
        idempotencyKey: 'completion-begin-review',
      },
      () => ({ valid: true }),
    );
    const reviewed = api.finishSessionCompletionWrite({
      ...financialContext(),
      proposalId: admitted.id,
      payloadHash: admitted.payloadHash,
      expectedVersion: started.proposal.version,
      idempotencyKey: 'completion-finish-review',
      result: {
        success: false,
        verified: false,
        parentId: started.payload!.manualInput.parentId,
        code: 'WRITE_UNCERTAIN',
        reviewRequired: true,
      },
    });
    expect(reviewed.state.phase).toBe('review_required');
    expect(store.liquidity.getClaimSet({ ...financialContext() }).bundles[0]?.state).toBe(
      'initiated',
    );
  });

  it('releases an initiated write intent only when Actual reports a certain prewrite import collision', async () => {
    saveSession();
    const api = completion(store);
    const admitted = admit();
    const approved = await approveAsPeer(api, admitted, '1', 'approve-prewrite');
    const started = api.beginSessionCompletionWrite({
      ...financialContext(),
      proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: approved.version, expectedClaimSetRevision: '1',
      idempotencyKey: 'begin-prewrite',
    }, () => ({ valid: true }));
    const finished = api.finishSessionCompletionWrite({
      ...financialContext(),
      proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: started.proposal.version,
      idempotencyKey: 'finish-prewrite',
      result: {
        success: false, verified: false, parentId: started.payload!.manualInput.parentId,
        code: 'IMPORTED_CANDIDATE_REVIEW', reviewRequired: true,
      },
    });
    expect(finished.state).toMatchObject({
      phase: 'closed', outcome: 'reconciliation_required',
    });
    expect(store.liquidity.getClaimSet({ ...financialContext() }).bundles).toEqual([]);
  });

  it('requires the exact manual parent identity and links later account-scoped Actual imports once', async () => {
    saveSession();
    const api = completion(store);
    const admitted = admit();
    const approved = await approveAsPeer(api, admitted, '1', 'approve-import-link');
    const started = api.beginSessionCompletionWrite({
      ...financialContext(),
      proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: approved.version, expectedClaimSetRevision: '1',
      idempotencyKey: 'begin-import-link',
    }, () => ({ valid: true }));
    const parentId = started.payload!.manualInput.parentId;
    const finish = {
      ...financialContext(),
      proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: started.proposal.version, idempotencyKey: 'finish-import-link',
    };
    expect(() => api.finishSessionCompletionWrite({
      ...finish, result: { success: true, verified: true, parentId, transactionId: 'another-parent' },
    })).toThrow();
    const verified = api.finishSessionCompletionWrite({
      ...finish, result: { success: true, verified: true, parentId, transactionId: parentId },
    });
    expect(verified.state.phase).toBe('verified');
    expect(store.liquidity.getClaimSet({ ...financialContext() }).bundles).toEqual([]);

    const linked = api.reconcileSessionCompletion({
      ...financialContext(),
      proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: verified.version, idempotencyKey: 'actual-import-link',
      expectedClaimSetRevision: store.liquidity.getClaimSet({ ...financialContext() }).revision,
      evidence: {
        evidenceId: `import:${accountId}:bank-import-001`, kind: 'imported_link', parentId, accountId,
        transactionId: parentId, verified: true,
      },
    });
    expect(linked.state.phase).toBe('verified');
    expect(store.liquidity.getClaimSet({ ...financialContext() }).bundles).toEqual([]);
    expect(() => admit(
      1,
      store.liquidity.getClaimSet({ ...financialContext() }).revision,
      'second-completion',
      'second-completion-claim',
      '1',
      'another-manual-parent',
    )).toThrow();
  });

  it('makes verified completion terminal even if the cart was edited during the write', async () => {
    const original = saveSession();
    const api = completion(store);
    const admitted = admit();
    const approved = await approveAsPeer(api, admitted, '1', 'terminal-approve');
    const started = api.beginSessionCompletionWrite({
      ...financialContext(),
      proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: approved.version, expectedClaimSetRevision: '1',
      idempotencyKey: 'terminal-begin',
    }, () => ({ valid: true }));
    const changed = store.liquidity.saveSpendSession({
      ...financialContext(),
      id: original.id, expectedVersion: original.version,
      idempotencyKey: 'edit-during-write', expiresAt, accountId,
      items: [{ ...original.items[0]!, amount: money('2000') }],
    }, () => ({ valid: true }));
    expect(changed.version).toBe(2);
    const verified = api.finishSessionCompletionWrite({
      ...financialContext(),
      proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: started.proposal.version, idempotencyKey: 'terminal-finish',
      result: {
        success: true, verified: true, parentId: started.payload!.manualInput.parentId,
        transactionId: started.payload!.manualInput.parentId,
      },
    });
    expect(() => store.liquidity.saveProspectiveClaim({
      ...financialContext(),
      expectedClaimSetRevision: store.liquidity.getClaimSet({ ...financialContext() }).revision,
      idempotencyKey: 'late-v2-reservation',
      claim: {
        claimId: 'late-v2-hold', kind: 'reservation',
        sourceId: `session:${changed.id}:${changed.version}`,
        scope: { kind: 'category', id: categoryId }, amount: money('2000'),
        status: 'active', effectiveFrom: now, expiresAt, visibility: 'visible',
        snapshotId: 'snapshot-001', policyVersion: '1',
      },
    }, () => ({ valid: true }))).toThrow();
    expect(verified.state.phase).toBe('verified');
    expect(() => admit(
      changed.version,
      store.liquidity.getClaimSet({ ...financialContext() }).revision,
      'second-version-completion', 'second-version-claim', '1', 'second-version-manual-parent',
    )).toThrow();
    expect(() => store.liquidity.saveSpendSession({
      ...financialContext(),
      id: changed.id, expectedVersion: changed.version,
      idempotencyKey: 'edit-after-verification', expiresAt, accountId,
      items: [{ ...changed.items[0]!, amount: money('3000') }],
    }, () => ({ valid: true }))).toThrow();
    expect(() => store.liquidity.cancelSpendSession({
      ...financialContext(),
      id: changed.id, expectedVersion: changed.version,
      idempotencyKey: 'cancel-after-verification',
    })).toThrow();
  });
});
