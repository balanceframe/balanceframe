import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { SqliteWorkflowStore } from '../src/store.js';
import type { SpendSession } from '../src/liquidity-types.js';

const now = '2098-01-01T00:00:00.000Z';
const expiresAt = '2099-01-01T00:00:00.000Z';
const budgetId = 'budget';
const actorId = 'holder';
const accountId = 'checking';
const categoryId = 'food';
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
interface AdmissionInput {
  actorId: string;
  budgetId: string;
  sessionId: string;
  expectedSessionVersion: number;
  payload: CompletionPayload;
  payloadHash: string;
  claim: CompletionClaim;
  expectedClaimSetRevision: string;
  idempotencyKey: string;
  now: string;
}
interface CompletionCommand {
  actorId: string;
  budgetId: string;
  proposalId: string;
  payloadHash: string;
  expectedVersion: number;
  expectedClaimSetRevision?: string;
  idempotencyKey: string;
  now: string;
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
  approveSessionCompletion(input: CompletionCommand, validator: Validator): CompletionProposal;
  beginSessionCompletionWrite(input: CompletionCommand, validator: Validator): BeginResult;
  finishSessionCompletionWrite(input: FinishCommand): CompletionProposal;
  reconcileSessionCompletion(input: CompletionCommand & { evidence: CompletionEvidence }): CompletionProposal;
  getSessionCompletionProposal(
    input: { actorId: string; budgetId: string; proposalId: string },
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
  beforeEach(async () => {
    store = new SqliteWorkflowStore(':memory:');
    await store.upsertActorMembership(
      actorId,
      'active',
      capabilities.map((capability) => `liquidity:${capability}`),
      `budget:${budgetId}`,
    );
    for (const capability of capabilities)
      for (const [resourceKind, resourceId] of [
        ['budget', budgetId],
        ['account', accountId],
        ['category', categoryId],
      ] as const)
        store.liquidity.setResourceGrant({
          actorId,
          budgetId,
          capability,
          resourceKind,
          resourceId,
          granted: true,
          now,
        });
    store.liquidity.savePolicy({
      actorId,
      budgetId,
      expectedVersion: null,
      now,
      policy: { version: '1', policyHash: 'policy', expiresAt, accounts: [], transferRoutes: [] },
      approvalPolicy: { minimumApprovers: 1 },
    });
  });
  afterEach(() => store.close());

  function saveSession(): SpendSession {
    return store.liquidity.saveSpendSession(
      {
        actorId,
        budgetId,
        id: 'session-001',
        expectedVersion: 0,
        idempotencyKey: 'session-create',
        now,
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
        actorId,
        budgetId,
        sessionId: 'session-001',
        expectedSessionVersion: sessionVersion,
        payload: requestPayload,
        payloadHash: hashPayload(requestPayload),
        claim: claim(claimId, policyVersion),
        expectedClaimSetRevision,
        idempotencyKey,
        now,
      },
      () => ({ valid: true }),
    );
  }

  it('admits, approves, and grants exactly one durable write intent', () => {
    saveSession();
    const api = completion(store);
    const admitted = admit();
    expect(admitted.state.phase).toBe('proposed');
    expect(admitted.approvalCount).toBe(0);
    expect(admitted.approvalStatus).toBe('none');

    const approved = api.approveSessionCompletion(
      {
        actorId,
        budgetId,
        proposalId: admitted.id,
        payloadHash: admitted.payloadHash,
        expectedVersion: admitted.version,
        expectedClaimSetRevision: '1',
        idempotencyKey: 'completion-approve',
        now,
      },
      () => ({ valid: true }),
    );
    expect(approved.state.phase).toBe('approved');
    expect(approved.approvalCount).toBe(1);
    expect(approved.approvalStatus).toBe('active');

    const first = api.beginSessionCompletionWrite(
      {
        actorId,
        budgetId,
        proposalId: admitted.id,
        payloadHash: admitted.payloadHash,
        expectedVersion: approved.version,
        expectedClaimSetRevision: '1',
        idempotencyKey: 'completion-begin-1',
        now,
      },
      () => ({ valid: true }),
    );
    expect(first.acquiredWriteIntent).toBe(true);
    expect(first.payload).toEqual(admitted.payload);
    expect(first.proposal.state.phase).toBe('write_intent');

    const replay = api.beginSessionCompletionWrite(
      {
        actorId,
        budgetId,
        proposalId: admitted.id,
        payloadHash: admitted.payloadHash,
        expectedVersion: first.proposal.version,
        expectedClaimSetRevision: '2',
        idempotencyKey: 'completion-begin-2',
        now,
      },
      () => ({ valid: true }),
    );
    expect(replay.acquiredWriteIntent).toBe(false);
    expect(replay.payload).toBeNull();
    expect(replay.proposal.state.phase).toBe('write_intent');
  });

  it('requires confirmation capability before starting an Actual write', () => {
    saveSession();
    const api = completion(store);
    const admitted = admit();
    const approved = api.approveSessionCompletion({
      actorId, budgetId, proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: admitted.version, expectedClaimSetRevision: '1',
      idempotencyKey: 'approval-before-confirmation-revoke', now,
    }, () => ({ valid: true }));
    store.liquidity.setResourceGrant({
      actorId, budgetId, resourceKind: 'budget', resourceId: budgetId,
      capability: 'confirmation', granted: false, now,
    });
    expect(() => api.beginSessionCompletionWrite({
      actorId, budgetId, proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: approved.version, expectedClaimSetRevision: '1',
      idempotencyKey: 'write-without-confirmation', now,
    }, () => ({ valid: true }))).toThrow(/authorization/i);
    expect(api.getSessionCompletionProposal({ actorId, budgetId, proposalId: admitted.id })
      .state.phase).toBe('approved');
  });

  it('requires distinct currently authorized approvers before granting a write intent', async () => {
    store.liquidity.savePolicy({
      actorId, budgetId, expectedVersion: '1', now,
      policy: { version: '2', policyHash: 'policy-2', expiresAt, accounts: [], transferRoutes: [] },
      approvalPolicy: { minimumApprovers: 2 },
    });
    saveSession();
    const api = completion(store);
    const admitted = admit(1, '0', 'multi-admit', 'multi-claim', '2');
    const first = api.approveSessionCompletion({
      actorId, budgetId, proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: admitted.version, expectedClaimSetRevision: '1',
      idempotencyKey: 'multi-first', now,
    }, () => ({ valid: true }));
    expect(first.state.phase).toBe('proposed');
    expect(first.approvalCount).toBe(1);
    expect(() => api.approveSessionCompletion({
      actorId, budgetId, proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: first.version, expectedClaimSetRevision: '1',
      idempotencyKey: 'multi-same-actor', now,
    }, () => ({ valid: true }))).toThrow();
    expect(api.getSessionCompletionProposal({ actorId, budgetId, proposalId: admitted.id }).approvalCount).toBe(1);

    const peer = 'second-approver';
    await store.upsertActorMembership(
      peer, 'active', capabilities.map((capability) => `liquidity:${capability}`), `budget:${budgetId}`,
    );
    for (const capability of capabilities)
      for (const [resourceKind, resourceId] of [
        ['budget', budgetId], ['account', accountId], ['category', categoryId],
      ] as const)
        store.liquidity.setResourceGrant({
          actorId: peer, budgetId, capability, resourceKind, resourceId, granted: true, now,
        });
    expect(api.getSessionCompletionProposal({
      actorId: peer, budgetId, proposalId: admitted.id,
    }).approvalCount).toBe(1);
    const second = api.approveSessionCompletion({
      actorId: peer, budgetId, proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: first.version, expectedClaimSetRevision: '1',
      idempotencyKey: 'multi-second', now,
    }, () => ({ valid: true }));
    expect(second.state.phase).toBe('approved');
    expect(second.approvalCount).toBe(2);
    store.liquidity.setResourceGrant({
      actorId: peer, budgetId, resourceKind: 'budget', resourceId: budgetId,
      capability: 'session', granted: false, now,
    });
    expect(api.getSessionCompletionProposal({
      actorId, budgetId, proposalId: admitted.id,
    }).approvalCount).toBe(1);
    expect(() => api.beginSessionCompletionWrite({
      actorId, budgetId, proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: second.version, expectedClaimSetRevision: '1',
      idempotencyKey: 'multi-write-revoked-session', now,
    }, () => ({ valid: true }))).toThrow(/Current authorized approvals required/);
    store.liquidity.setResourceGrant({
      actorId: peer, budgetId, resourceKind: 'budget', resourceId: budgetId,
      capability: 'session', granted: true, now,
    });
    expect(api.beginSessionCompletionWrite({
      actorId, budgetId, proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: second.version, expectedClaimSetRevision: '1',
      idempotencyKey: 'multi-write', now,
    }, () => ({ valid: true })).acquiredWriteIntent).toBe(true);
  });

  it('supersedes pre-write completions on session edit but retains an initiated hold', () => {
    const session = saveSession();
    const api = completion(store);
    const admitted = admit();

    store.liquidity.saveSpendSession(
      {
        actorId,
        budgetId,
        id: session.id,
        expectedVersion: session.version,
        idempotencyKey: 'session-edit',
        now,
        expiresAt,
        accountId,
        items: session.items,
      },
      () => ({ valid: true }),
    );
    expect(api.getSessionCompletionProposal({ actorId, budgetId, proposalId: admitted.id }).state).toMatchObject({
      phase: 'closed',
      outcome: 'superseded',
    });
    expect(store.liquidity.getClaimSet({ actorId, budgetId, now }).bundles).toEqual([]);

    const second = admit(2, '2', 'completion-admit-2', 'completion-claim-002');
    const approved = api.approveSessionCompletion(
      {
        actorId,
        budgetId,
        proposalId: second.id,
        payloadHash: second.payloadHash,
        expectedVersion: second.version,
        expectedClaimSetRevision: '3',
        idempotencyKey: 'completion-approve-2',
        now,
      },
      () => ({ valid: true }),
    );
    const started = api.beginSessionCompletionWrite(
      {
        actorId,
        budgetId,
        proposalId: second.id,
        payloadHash: second.payloadHash,
        expectedVersion: approved.version,
        expectedClaimSetRevision: '3',
        idempotencyKey: 'completion-begin-3',
        now,
      },
      () => ({ valid: true }),
    );
    expect(started.acquiredWriteIntent).toBe(true);

    store.liquidity.cancelSpendSession({
      actorId,
      budgetId,
      id: session.id,
      expectedVersion: 2,
      idempotencyKey: 'session-cancel',
      now,
    });
    expect(api.getSessionCompletionProposal({ actorId, budgetId, proposalId: second.id }).state.phase).toBe(
      'write_intent',
    );
    expect(store.liquidity.getClaimSet({ actorId, budgetId, now }).bundles[0]?.state).toBe(
      'initiated',
    );
    expect(api.finishSessionCompletionWrite({
      actorId, budgetId, proposalId: second.id, payloadHash: second.payloadHash,
      expectedVersion: started.proposal.version, idempotencyKey: 'finish-after-cancel', now,
      result: { success: true, verified: true,
        parentId: second.payload.manualInput.parentId,
        transactionId: second.payload.manualInput.parentId },
    }).state.phase).toBe('verified');
  });

  it('retains an initiated claim for an uncertain write and requires evidence identity to settle', () => {
    saveSession();
    const api = completion(store);
    const admitted = admit();
    const approved = api.approveSessionCompletion(
      {
        actorId,
        budgetId,
        proposalId: admitted.id,
        payloadHash: admitted.payloadHash,
        expectedVersion: admitted.version,
        expectedClaimSetRevision: '1',
        idempotencyKey: 'completion-approve-review',
        now,
      },
      () => ({ valid: true }),
    );
    const started = api.beginSessionCompletionWrite(
      {
        actorId,
        budgetId,
        proposalId: admitted.id,
        payloadHash: admitted.payloadHash,
        expectedVersion: approved.version,
        expectedClaimSetRevision: '1',
        idempotencyKey: 'completion-begin-review',
        now,
      },
      () => ({ valid: true }),
    );
    const reviewed = api.finishSessionCompletionWrite({
      actorId,
      budgetId,
      proposalId: admitted.id,
      payloadHash: admitted.payloadHash,
      expectedVersion: started.proposal.version,
      idempotencyKey: 'completion-finish-review',
      now,
      result: {
        success: false,
        verified: false,
        parentId: started.payload!.manualInput.parentId,
        code: 'WRITE_UNCERTAIN',
        reviewRequired: true,
      },
    });
    expect(reviewed.state.phase).toBe('review_required');
    expect(store.liquidity.getClaimSet({ actorId, budgetId, now }).bundles[0]?.state).toBe(
      'initiated',
    );
  });

  it('releases an initiated write intent only when Actual reports a certain prewrite import collision', () => {
    saveSession();
    const api = completion(store);
    const admitted = admit();
    const approved = api.approveSessionCompletion({
      actorId, budgetId, proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: admitted.version, expectedClaimSetRevision: '1',
      idempotencyKey: 'approve-prewrite', now,
    }, () => ({ valid: true }));
    const started = api.beginSessionCompletionWrite({
      actorId, budgetId, proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: approved.version, expectedClaimSetRevision: '1',
      idempotencyKey: 'begin-prewrite', now,
    }, () => ({ valid: true }));
    const finished = api.finishSessionCompletionWrite({
      actorId, budgetId, proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: started.proposal.version,
      idempotencyKey: 'finish-prewrite', now,
      result: {
        success: false, verified: false, parentId: started.payload!.manualInput.parentId,
        code: 'IMPORTED_CANDIDATE_REVIEW', reviewRequired: true,
      },
    });
    expect(finished.state).toMatchObject({
      phase: 'closed', outcome: 'reconciliation_required',
    });
    expect(store.liquidity.getClaimSet({ actorId, budgetId, now }).bundles).toEqual([]);
  });

  it('requires the exact manual parent identity and links later account-scoped Actual imports once', () => {
    saveSession();
    const api = completion(store);
    const admitted = admit();
    const approved = api.approveSessionCompletion({
      actorId, budgetId, proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: admitted.version, expectedClaimSetRevision: '1',
      idempotencyKey: 'approve-import-link', now,
    }, () => ({ valid: true }));
    const started = api.beginSessionCompletionWrite({
      actorId, budgetId, proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: approved.version, expectedClaimSetRevision: '1',
      idempotencyKey: 'begin-import-link', now,
    }, () => ({ valid: true }));
    const parentId = started.payload!.manualInput.parentId;
    const finish = {
      actorId, budgetId, proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: started.proposal.version, idempotencyKey: 'finish-import-link', now,
    };
    expect(() => api.finishSessionCompletionWrite({
      ...finish, result: { success: true, verified: true, parentId, transactionId: 'another-parent' },
    })).toThrow(/parent|identity|transaction/i);
    const verified = api.finishSessionCompletionWrite({
      ...finish, result: { success: true, verified: true, parentId, transactionId: parentId },
    });
    expect(verified.state.phase).toBe('verified');
    expect(store.liquidity.getClaimSet({ actorId, budgetId, now }).bundles).toEqual([]);

    const linked = api.reconcileSessionCompletion({
      actorId, budgetId, proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: verified.version, idempotencyKey: 'actual-import-link', now,
      expectedClaimSetRevision: store.liquidity.getClaimSet({ actorId, budgetId, now }).revision,
      evidence: {
        evidenceId: `import:${accountId}:bank-import-001`, kind: 'imported_link', parentId, accountId,
        transactionId: parentId, verified: true,
      },
    });
    expect(linked.state.phase).toBe('verified');
    expect(store.liquidity.getClaimSet({ actorId, budgetId, now }).bundles).toEqual([]);
    expect(() => admit(
      1,
      store.liquidity.getClaimSet({ actorId, budgetId, now }).revision,
      'second-completion',
      'second-completion-claim',
      '1',
      'another-manual-parent',
    )).toThrow(/already completed|completed session/i);
  });
  it('makes verified completion terminal even if the cart was edited during the write', () => {
    const original = saveSession();
    const api = completion(store);
    const admitted = admit();
    const approved = api.approveSessionCompletion({
      actorId, budgetId, proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: admitted.version, expectedClaimSetRevision: '1',
      idempotencyKey: 'terminal-approve', now,
    }, () => ({ valid: true }));
    const started = api.beginSessionCompletionWrite({
      actorId, budgetId, proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: approved.version, expectedClaimSetRevision: '1',
      idempotencyKey: 'terminal-begin', now,
    }, () => ({ valid: true }));
    const changed = store.liquidity.saveSpendSession({
      actorId, budgetId, id: original.id, expectedVersion: original.version,
      idempotencyKey: 'edit-during-write', now, expiresAt, accountId,
      items: [{ ...original.items[0]!, amount: money('2000') }],
    }, () => ({ valid: true }));
    expect(changed.version).toBe(2);
    const verified = api.finishSessionCompletionWrite({
      actorId, budgetId, proposalId: admitted.id, payloadHash: admitted.payloadHash,
      expectedVersion: started.proposal.version, idempotencyKey: 'terminal-finish', now,
      result: {
        success: true, verified: true, parentId: started.payload!.manualInput.parentId,
        transactionId: started.payload!.manualInput.parentId,
      },
    });
    expect(() => store.liquidity.saveProspectiveClaim({
      actorId, budgetId, expectedClaimSetRevision: store.liquidity.getClaimSet({
        actorId, budgetId, now,
      }).revision, idempotencyKey: 'late-v2-reservation', now,
      claim: {
        claimId: 'late-v2-hold', kind: 'reservation',
        sourceId: `session:${changed.id}:${changed.version}`,
        scope: { kind: 'category', id: categoryId }, amount: money('2000'),
        status: 'active', effectiveFrom: now, expiresAt, visibility: 'visible',
        snapshotId: 'snapshot-001', policyVersion: '1',
      },
    }, () => ({ valid: true }))).toThrow(/already completed/);
    expect(verified.state.phase).toBe('verified');
    expect(() => admit(
      changed.version,
      store.liquidity.getClaimSet({ actorId, budgetId, now }).revision,
      'second-version-completion', 'second-version-claim', '1', 'second-version-manual-parent',
    )).toThrow(/already completed/);
    expect(() => store.liquidity.saveSpendSession({
      actorId, budgetId, id: changed.id, expectedVersion: changed.version,
      idempotencyKey: 'edit-after-verification', now, expiresAt, accountId,
      items: [{ ...changed.items[0]!, amount: money('3000') }],
    }, () => ({ valid: true }))).toThrow(/already completed/);
    expect(() => store.liquidity.cancelSpendSession({
      actorId, budgetId, id: changed.id, expectedVersion: changed.version,
      idempotencyKey: 'cancel-after-verification', now,
    })).toThrow(/already completed/);
  });
});
