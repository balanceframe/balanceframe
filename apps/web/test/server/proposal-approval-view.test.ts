import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import { GENERIC_MUTATION_POLICY_VERSION } from '../../../../packages/workflow-store/src/proposal';
import { buildProposalApprovalView } from '../../server/utils/proposal-approval-view';
vi.mock('@balanceframe/workflow-store', async () =>
  await import('../../../../packages/workflow-store/src/index'));

let now = '';
let proposalExpiresAt = '';
const requesterId = 'proposal-view-requester';
const budgetId = 'proposal-view-budget';
const accountId = 'proposal-view-account';
const categoryId = 'proposal-view-category';
const sessionAuth = {
  method: 'session' as const,
  actorId: requesterId,
  sessionId: `session:${requesterId}`,
};
let store: SqliteWorkflowStore;
let spaceId: string;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2098-01-01T12:00:00.000Z'));
  now = new Date().toISOString();
  proposalExpiresAt = '2099-01-01T00:00:00.000Z';
  store = new SqliteWorkflowStore(':memory:');
  const claimId = 'proposal-approval-view-fixture';
  await store.claimBootstrap({ name: 'Proposal requester', email: 'proposal-view-requester@example.test', claimId });
  await store.finalizeBootstrap({ claimId, ownerUserId: requesterId });

  const controlAuth = {
    method: 'human-session' as const,
    actorId: requesterId,
    sessionId: `session:${requesterId}`,
    reauthenticatedAt: now,
  };
  const space = store.governance.createSpace({
    actorId: requesterId,
    name: 'Proposal view test',
    kind: 'shared',
    now,
    auth: controlAuth,
  });
  spaceId = space.id;
  store.governance.bindBudget({ spaceId, budgetId, now, auth: controlAuth });
  const membership = store.governance.getCurrentMembership({ spaceId, actorId: requesterId, now });
  if (!membership) throw new Error('Proposal requester membership was not created');
  for (const resource of [
    { kind: 'budget' as const, id: budgetId },
    { kind: 'account' as const, id: accountId },
    { kind: 'transaction' as const, id: 'proposal-view-transaction' },
    { kind: 'category' as const, id: categoryId },
  ]) {
    store.governance.provisionResourceGrant({
      spaceId,
      actorId: requesterId,
      budgetId,
      membershipId: membership.id,
      capability: 'categorization:propose',
      resourceKind: resource.kind,
      resourceId: resource.id,
      granted: true,
      now,
    });
  }
});

afterEach(() => {
  store.close();
  vi.useRealTimers();
});

describe('proposal approval wire view', () => {
  it('withholds the server-owned financial envelope from operation-only rights and reveals it only through independent current read grants', async () => {
    const proposal = await store.createProposal({
      operation: 'set_category',
      budgetId,
      spaceId,
      payload: { kind: 'set_category', transactionId: 'proposal-view-transaction', categoryId },
      policyVersion: GENERIC_MUTATION_POLICY_VERSION,
      preconditions: JSON.stringify({
        transaction: {
          id: 'proposal-view-transaction',
          accountId,
          direction: 'outgoing',
          amount: { minorUnits: '1200', currency: 'USD' },
        },
      }),
      expiresAt: proposalExpiresAt,
      actorId: requesterId,
      auth: sessionAuth,
      provenance: 'proposal-view-test',
    });
    const summaryNow = new Date().toISOString();
    const summaryInput = { proposalId: proposal.id, spaceId, actorId: requesterId, auth: sessionAuth, now: summaryNow };
    const nativeSummary = await store.getProposalApprovalSummary(summaryInput);
    expect(typeof nativeSummary.disposition).toBe('object');
    expect(nativeSummary.disposition).toMatchObject({ kind: 'approval_required' });

    const view = await buildProposalApprovalView({ store, proposal, actorId: requesterId, auth: sessionAuth, now: summaryNow });
    if (!view) throw new Error('Expected an authorized proposal view');
    expect(typeof view.disposition).toBe('string');
    expect(view.disposition).toBe(nativeSummary.disposition.kind);
    expect(view).toMatchObject({
      id: proposal.id,
      operation: 'set_category',
      spaceId,
      budgetId,
      requesterActorId: requesterId,
      requesterMembershipId: proposal.requesterMembershipId,
      governancePolicyVersion: proposal.governancePolicyVersion,
      policyVersion: GENERIC_MUTATION_POLICY_VERSION,
      payloadHash: proposal.payloadHash,
      payload: null,
      preconditions: null,
      privateEnvelopeVisible: false,
      expiresAt: proposal.expiresAt,
    });
    expect(JSON.stringify(view)).not.toContain('1200');
    expect(JSON.stringify(view)).not.toContain(accountId);
    expect(view.canApprove).toBe(false);
    const membership = store.governance.getCurrentMembership({ spaceId, actorId: requesterId, now: summaryNow });
    if (!membership) throw new Error('Current requester membership is required');
    const grant = {
      spaceId, actorId: requesterId, membershipId: membership.id, budgetId,
      resourceKind: 'budget' as const, resourceId: budgetId, capability: 'full-read',
      now: summaryNow,
      auth: { method: 'human-session' as const, actorId: requesterId, sessionId: `session:${requesterId}`, reauthenticatedAt: summaryNow },
    };
    store.governance.setResourceGrant({ ...grant, granted: true });
    const readable = await buildProposalApprovalView({ store, proposal, actorId: requesterId, auth: sessionAuth, now: summaryNow });
    expect(readable).toMatchObject({
      privateEnvelopeVisible: true, payload: proposal.payload,
      preconditions: JSON.parse(proposal.preconditions),
    });
    store.governance.setResourceGrant({ ...grant, granted: false });
    const revoked = await buildProposalApprovalView({ store, proposal, actorId: requesterId, auth: sessionAuth, now: summaryNow });
    expect(revoked).toMatchObject({ privateEnvelopeVisible: false, payload: null, preconditions: null });

    await store.supersedeProposal(proposal.id);
    const deniedNow = new Date().toISOString();
    const deniedSummary = await store.getProposalApprovalSummary({ ...summaryInput, now: deniedNow });
    if (deniedSummary.disposition.kind !== 'denied') throw new Error('Expected native denial');
    const deniedView = await buildProposalApprovalView({ store, proposal, actorId: requesterId, auth: sessionAuth, now: deniedNow });
    if (!deniedView) throw new Error('Expected an authorized proposal view after superseding');
    expect(deniedView.disposition).toBe('denied');
    expect(JSON.stringify(deniedView)).not.toContain(deniedSummary.disposition.reason);
  });
});
