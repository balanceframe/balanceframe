import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { TransferPlan, TransferSettlementResult } from '@balanceframe/protocol-generated';
import type { HumanControlContext } from '../src/governance-types.js';
import { SqliteWorkflowStore } from '../src/store.js';

const now = '2098-01-01T00:00:00.000Z';
const after = '2098-01-01T00:01:00.000Z';
const expiresAt = '2099-01-01T00:00:00.000Z';
const budgetId = 'budget';
const actorId = 'holder';
const approverId = 'approver';
const humanAuth = (actorId: string, at = now): HumanControlContext => ({
  method: 'human-session',
  actorId,
  sessionId: `session:${actorId}`,
  reauthenticatedAt: at,
});
const money = (amount: string) => ({ minorUnits: amount, currency: 'USD' });
function plan(hash = 'a'.repeat(64)): TransferPlan {
  const before = (accountId: string) => ({
    accountId,
    recordedBalance: money('100'),
    signedHeadroom: money('100'),
    backingCapacity: money('100'),
    baselineTransactionIds: [],
  });
  return {
    version: '1',
    preconditionsHash: 'e'.repeat(64),
    scenario: { kind: 'none' },
    snapshotId: 'snapshot',
    contentHash: 'ledger',
    policyVersion: '1',
    policyHash: 'policy',
    claimSetRevision: '0',
    evaluatedAt: now,
    expiresAt,
    minimumAmount: money('20'),
    payloadHash: hash,
    legs: [
      {
        id: 'leg',
        sourceAccountId: 'source',
        destinationAccountId: 'destination',
        amount: money('20'),
        requiredBy: expiresAt,
        estimatedArrival: now,
        timingRouteId: 'route',
        sourceBefore: before('source'),
        destinationBefore: before('destination'),
        sourceAfter: money('80'),
        destinationAfter: money('120'),
      },
    ],
    reservations: [
      {
        kind: 'account_debit',
        resourceId: 'source',
        amount: money('20'),
        economicObligationId: 'transfer',
        categoryId: null,
        includedInBalance: false,
        matchedTransactionIds: [],
      },
    ],
    backingAfter: {
      version: '1',
      snapshotId: 'snapshot',
      contentHash: 'ledger',
      policyVersion: '1',
      policyHash: 'policy',
      claimSetRevision: '0',
      feasible: true,
      lines: [],
      reasons: [],
    },
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

const fixtureResources = [
  ['budget', budgetId],
  ['account', 'source'],
  ['account', 'destination'],
  ['category', 'food'],
] as const;

describe('resource-scoped consequential actions', () => {
  let store: SqliteWorkflowStore;
  let directory: string;
  let path: string;
  let spaceId: string;
  let ownerMembershipId: string;
  let approverMembershipId: string;

  function scoped(actor = actorId, at = now) {
    const membership = store.governance.getCurrentMembership({ spaceId, actorId: actor, now: at });
    const policy = store.governance.getPolicy({ spaceId });
    if (!policy) throw new Error('Fixture governance policy unavailable');
    return {
      actorId: actor,
      budgetId,
      spaceId,
      ...(membership ? { membershipId: membership.id } : {}),
      governancePolicyVersion: policy.version,
      now: at,
      auth: humanAuth(actor),
    };
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'liquidity-workflow-'));
    path = join(directory, 'workflow.sqlite');
    store = new SqliteWorkflowStore(path);
    const claimId = 'liquidity-workflow-fixture';
    await store.claimBootstrap({ name: 'Holder', email: 'holder@example.com', claimId });
    await store.finalizeBootstrap({ claimId, ownerUserId: actorId });
    const space = store.governance.createSpace({
      actorId,
      name: 'Liquidity fixture',
      kind: 'shared',
      now,
      auth: humanAuth(actorId),
    });
    const boundSpace = store.governance.bindBudget({
      spaceId: space.id,
      budgetId,
      now,
      auth: humanAuth(actorId),
    });
    spaceId = boundSpace.id;
    ownerMembershipId = store.governance.getCurrentMembership({
      spaceId,
      actorId,
      now,
    })!.id;

    await store.upsertActorMembership(approverId, 'active', [], '');
    const approver = store.governance.addMembership({
      spaceId,
      actorId: approverId,
      validFrom: now,
      now,
      auth: humanAuth(actorId),
    });
    approverMembershipId = approver.id;

    const initialGovernancePolicy = store.governance.getPolicy({ spaceId });
    if (!initialGovernancePolicy) throw new Error('New space has no governance policy');
    store.liquidity.savePolicy({
      ...scoped(),
      expectedVersion: null,
      expectedGovernancePolicyVersion: initialGovernancePolicy.version,
      policy: { version: '1', policyHash: 'policy', expiresAt, accounts: [], transferRoutes: [] },
      approvalPolicy: { minimumApprovers: 1 },
    });

    for (const capability of capabilities)
      for (const [resourceKind, resourceId] of fixtureResources)
        store.governance.provisionResourceGrant({
          spaceId,
          actorId,
          membershipId: ownerMembershipId,
          budgetId,
          capability,
          resourceKind,
          resourceId,
          granted: true,
          now,
        });
    for (const [capability, resources] of [
      ['approval', fixtureResources],
      ['source', [['account', 'source']] as const],
    ] as const)
      for (const [resourceKind, resourceId] of resources)
        store.governance.provisionResourceGrant({
          spaceId,
          actorId: approverId,
          membershipId: approverMembershipId,
          budgetId,
          capability,
          resourceKind,
          resourceId,
          granted: true,
          now,
        });
  });
  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  it('persists an immutable actor-scoped transfer preview without admitting claims', () => {
    const preview = store.liquidity.saveTransferPreview({ ...scoped(), plan: plan() });
    expect(preview.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(preview.plan.payloadHash).toBe(plan().payloadHash);
    expect(store.liquidity.getClaimSet(scoped())).toEqual({
      revision: '0',
      bundles: [],
    });
    store.close();
    store = new SqliteWorkflowStore(path);
    expect(store.liquidity.getTransferPreview({ ...scoped(), id: preview.id })).toEqual(
      preview,
    );
    expect(() =>
      store.liquidity.getTransferPreview({ ...scoped('other'), id: preview.id }),
    ).toThrow();
    expect(() =>
      store.liquidity.getTransferPreview({
        ...scoped(),
        budgetId: 'foreign-budget',
        id: preview.id,
      }),
    ).toThrow();
  });
  it('rejects transfer preview overwrite and retains expired originals for trusted replay lookup', () => {
    const preview = store.liquidity.saveTransferPreview({
      ...scoped(),
      id: 'server-generated-preview-id',
      plan: plan(),
    });
    expect(() =>
      store.liquidity.saveTransferPreview({
        ...scoped(),
        id: preview.id,
        plan: plan('b'.repeat(64)),
      }),
    ).toThrow();
    const original = store.liquidity.getTransferPreview({ ...scoped(), id: preview.id });
    expect(original?.plan).toEqual(plan());
    expect(() =>
      store.liquidity.admitTransferProposal(
        {
          ...scoped(actorId, '2100-01-01T00:00:00.000Z'),
          plan: original!.plan,
          expectedClaimSetRevision: '0',
          idempotencyKey: 'expired-preview',
        },
        () => ({ valid: true }),
      ),
    ).toThrow();
    expect(store.liquidity.getTransferPreview({ ...scoped(), id: preview.id })).toEqual(
      original,
    );
  });
  it('replays admitted preview intent with a fresh server clock without admitting it twice', () => {
    const preview = store.liquidity.saveTransferPreview({ ...scoped(), plan: plan() });
    const input = {
      ...scoped(),
      plan: preview.plan,
      expectedClaimSetRevision: '0',
      idempotencyKey: 'preview-admission',
    };
    const admitted = store.liquidity.admitTransferProposal(input, () => ({ valid: true }));
    const replay = store.liquidity.admitTransferProposal(
      { ...input, expectedClaimSetRevision: '1', now: '2100-01-01T00:00:00.000Z' },
      () => {
        throw new Error('Replay cannot readmit');
      },
    );
    expect(replay.id).toBe(admitted.id);
    expect(replay.payloadHash).toBe(preview.plan.payloadHash);
  });
  function admit(hash = 'a'.repeat(64), revision = '0', sessionId?: string) {
    return store.liquidity.admitTransferProposal(
      {
        ...scoped(),
        plan: { ...plan(hash), claimSetRevision: revision },
        expectedClaimSetRevision: revision,
        idempotencyKey: hash,
        sessionId,
      },
      () => ({ valid: true }),
    );
  }
  async function approve(id: string, payloadHash = 'a'.repeat(64)) {
    return store.liquidity.approveTransfer(
      {
        ...scoped(approverId),
        proposalId: id,
        payloadHash,
        expectedVersion: 1,
        expectedClaimSetRevision: '1',
        idempotencyKey: `approve:${id}`,
      },
      () => ({ valid: true }),
    );
  }
  async function initiate(id: string, payloadHash = 'a'.repeat(64)) {
    await approve(id, payloadHash);
    return store.liquidity.reportTransferInitiated(
      {
        ...scoped(),
        proposalId: id,
        payloadHash,
        expectedVersion: 2,
        expectedClaimSetRevision: '1',
        idempotencyKey: `initiate:${id}`,
      },
      () => ({ valid: true }),
    );
  }
  function grantApproverInitiationReport(): void {
    for (const [resourceKind, resourceId] of fixtureResources)
      store.governance.provisionResourceGrant({
        spaceId,
        actorId: approverId,
        membershipId: approverMembershipId,
        budgetId,
        capability: 'initiation-report',
        resourceKind,
        resourceId,
        granted: true,
        now,
      });
  }
  it.each([
    ['approval', 'source grant revoked', false, undefined],
    ['instructions', 'source grant revoked', false, undefined],
    ['initiation report', 'source grant revoked', false, undefined],
    ['approval', 'gross outgoing limit narrowed', true, { maxGrossOutgoing: [money('19')] }],
    ['instructions', 'gross outgoing limit narrowed', true, { maxGrossOutgoing: [money('19')] }],
    ['initiation report', 'gross outgoing limit narrowed', true, { maxGrossOutgoing: [money('19')] }],
    ['approval', 'operation count limit narrowed', true, { maxOperationCount: 0 }],
    ['instructions', 'operation count limit narrowed', true, { maxOperationCount: 0 }],
    ['initiation report', 'operation count limit narrowed', true, { maxOperationCount: 0 }],
  ] as const)(
    'rejects transfer %s after the origin %s without changing its claim',
    async (continuation, originChange, proposalGrantRemains, restrictions) => {
      grantApproverInitiationReport();
      const proposal = admit();
      if (continuation !== 'approval') await approve(proposal.id);

      if (originChange === 'source grant revoked') {
        store.governance.provisionResourceGrant({
          spaceId,
          actorId,
          membershipId: ownerMembershipId,
          budgetId,
          capability: 'source',
          resourceKind: 'account',
          resourceId: 'source',
          granted: false,
          now,
        });
      } else {
        store.governance.provisionResourceGrant({
          spaceId,
          actorId,
          membershipId: ownerMembershipId,
          budgetId,
          capability: 'proposal',
          resourceKind: 'budget',
          resourceId: budgetId,
          granted: proposalGrantRemains,
          restrictions: restrictions ?? {},
          now,
        });
      }

      const beforeProposal = await store.getProposal(proposal.id);
      const beforeClaims = store.liquidity.getClaimSet(scoped());
      const validator = vi.fn(() => ({ valid: true }));
      const input = {
        ...scoped(approverId),
        proposalId: proposal.id,
        payloadHash: proposal.payloadHash,
        expectedVersion: continuation === 'approval' ? 1 : 2,
        expectedClaimSetRevision: beforeClaims.revision,
        idempotencyKey: `origin-authority:${continuation}:${originChange}`,
      };
      const continueTransfer = () => {
        if (continuation === 'approval')
          return store.liquidity.approveTransfer(input, validator);
        if (continuation === 'instructions')
          return store.liquidity.getTransferInstructions(input, validator);
        return store.liquidity.reportTransferInitiated(input, validator);
      };

      expect(continueTransfer).toThrow();
      expect(validator).not.toHaveBeenCalled();
      expect(await store.getProposal(proposal.id)).toEqual(beforeProposal);
      expect(store.liquidity.getClaimSet(scoped())).toEqual(beforeClaims);
    },
  );
  it('records an authorized already-initiated manual transfer when fresh financial preconditions changed', async () => {
    const p = admit();
    await approve(p.id);
    const approvals = await store.findActiveApprovals(p.id);
    const command = {
      ...scoped(),
      proposalId: p.id,
      payloadHash: p.payloadHash,
      expectedVersion: 2,
      expectedClaimSetRevision: '1',
      idempotencyKey: 'manual-transfer-report',
    };
    const changedLedger = () => ({ valid: false, reason: 'financial_preconditions_changed' });
    expect(() => store.liquidity.getTransferInstructions(command, changedLedger)).toThrow(
      /financial_preconditions_changed/,
    );
    const reported = store.liquidity.reportTransferInitiated(command, changedLedger);
    expect(reported.state).toEqual({
      phase: 'initiated',
      sourceObserved: false,
      destinationObserved: false,
      reconciled: false,
      outcome: 'reconciliation_required',
    });
    const held = store.liquidity.getClaimSet(scoped());
    expect(held).toMatchObject({
      revision: '2',
      bundles: [
        { id: p.id, state: 'initiated', initiated: true, effects: p.payload.plan.reservations },
      ],
    });
    expect((await store.getApproval(approvals[0]!.id))?.status).toBe('consumed');
    const replay = store.liquidity.reportTransferInitiated(
      { ...command, now: '2098-01-01T00:01:00.000Z' },
      () => {
        throw new Error('A replay cannot revalidate or reserve again');
      },
    );
    expect(replay).toEqual(reported);
    expect(store.liquidity.getClaimSet(scoped())).toEqual(held);
  });
  it('requires a fresh current human proof before invoking transfer settlement verification', async () => {
    const proposal = admit();
    const initiated = await initiate(proposal.id);
    const held = store.liquidity.getClaimSet(scoped());
    let verifierCalls = 0;
    const invalidProofs = [
      {
        now,
        auth: { method: 'session', actorId, sessionId: `session:${actorId}` },
      },
      {
        now: '2098-01-01T00:05:01.000Z',
        auth: humanAuth(actorId),
      },
      {
        now,
        auth: humanAuth(actorId, '2098-01-01T00:00:01.000Z'),
      },
    ] as const;
    for (const [index, proof] of invalidProofs.entries())
      expect(() => store.liquidity.verifyTransferSettlement({
        ...scoped(actorId, proof.now),
        auth: proof.auth,
        proposalId: proposal.id,
        payloadHash: proposal.payloadHash,
        expectedVersion: initiated.version,
        idempotencyKey: `unproved-settlement-${index}`,
      }, () => {
        verifierCalls++;
        return {
          confirmed: true,
          sourceObserved: true,
          destinationObserved: true,
          reconciled: true,
          evidenceIds: ['actual:source:receipt', 'actual:destination:receipt'],
          claimEffects: [],
          reasons: [],
        };
      })).toThrow(/Current human reconciliation required/);
    expect(verifierCalls).toBe(0);
    expect(store.liquidity.getClaimSet(scoped())).toEqual(held);
    expect(store.liquidity.getTransferProposal({
      ...scoped(),
      proposalId: proposal.id,
    }).state.phase).toBe('initiated');
  });
  it('keeps specialized transfer admission human-only for a current delegated agent', () => {
    const agentId = 'agent:specialized-transfer-admission';
    const credentialId = 'key:specialized-transfer-admission';
    store.governance.registerAgent({ spaceId, agentId, now, auth: humanAuth(actorId) });
    const rights = [
      { capability: 'proposal', resourceKind: 'budget' as const, resourceId: budgetId },
      { capability: 'proposal', resourceKind: 'account' as const, resourceId: 'source' },
      { capability: 'proposal', resourceKind: 'account' as const, resourceId: 'destination' },
      { capability: 'source', resourceKind: 'account' as const, resourceId: 'source' },
    ];
    const delegation = store.governance.delegate({
      spaceId,
      agentId,
      issuerMembershipId: ownerMembershipId,
      expectedVersion: null,
      rights,
      validFrom: now,
      validUntil: expiresAt,
      now,
      auth: humanAuth(actorId),
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
      auth: humanAuth(actorId),
    });
    const input = {
      actorId: agentId,
      budgetId,
      spaceId,
      membershipId: ownerMembershipId,
      governancePolicyVersion: scoped().governancePolicyVersion,
      now,
      auth: agentAuth,
      agentId,
      delegationId: delegation.id,
      plan: plan(),
      expectedClaimSetRevision: '0',
      idempotencyKey: 'agent-specialized-transfer-admit',
    };
    expect(store.liquidity.isTransferPlanAuthorized({
      ...input,
      capability: 'proposal',
      phase: 'propose',
    })).toBe(true);
    expect(() => store.liquidity.admitTransferProposal(input, () => ({ valid: true })))
      .toThrow(/Current human membership unavailable/);
    expect(store.liquidity.listTransferProposals(scoped())).toEqual([]);
    expect(store.liquidity.getClaimSet(scoped()).bundles).toEqual([]);
    store.governance.provisionResourceGrant({
      spaceId,
      actorId,
      membershipId: ownerMembershipId,
      budgetId,
      capability: 'source',
      resourceKind: 'account',
      resourceId: 'source',
      granted: false,
      now: after,
    });
    expect(store.liquidity.isTransferPlanAuthorized({
      ...input,
      now: after,
      capability: 'proposal',
      phase: 'propose',
    })).toBe(false);
    store.governance.revokeDelegation({
      spaceId,
      delegationId: delegation.id,
      expectedVersion: delegation.version,
      now: after,
      auth: humanAuth(actorId, after),
    });
    expect(store.liquidity.isTransferPlanAuthorized({
      ...input,
      now: after,
      capability: 'proposal',
      phase: 'propose',
    })).toBe(false);
  });
  it('settles an initiated transfer with current human confirmation after approval provenance changes', async () => {
    const proposal = admit();
    const initiated = await initiate(proposal.id);
    const agentId = 'agent:native-transfer-settlement';
    const credentialId = 'key:native-transfer-settlement';
    store.governance.registerAgent({ spaceId, agentId, now, auth: humanAuth(actorId) });
    const delegation = store.governance.delegate({
      spaceId,
      agentId,
      issuerMembershipId: ownerMembershipId,
      expectedVersion: null,
      rights: [{ capability: 'liquidity', resourceKind: 'budget', resourceId: budgetId }],
      validFrom: now,
      validUntil: expiresAt,
      now,
      auth: humanAuth(actorId),
    });
    const settlementRights = [
      { capability: 'confirmation', resourceKind: 'budget', resourceId: budgetId },
      { capability: 'confirmation', resourceKind: 'account', resourceId: 'source' },
      { capability: 'confirmation', resourceKind: 'account', resourceId: 'destination' },
    ];
    // Model a pre-policy legacy delegation that already carried nondelegable confirmation.
    store['db'].prepare(
      'UPDATE agent_delegations SET rights=? WHERE id=? AND version=?',
    ).run(JSON.stringify(settlementRights), delegation.id, delegation.version);
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
      auth: humanAuth(actorId),
    });
    expect(store.governance.resolveCredentialPrincipal({
      credentialId,
      referenceId: actorId,
      spaceId,
      now,
    })).toMatchObject({ principalType: 'agent', actorId: agentId });
    let agentVerifierCalls = 0;
    expect(() => store.liquidity.verifyTransferSettlement({
      actorId: agentId,
      budgetId,
      spaceId,
      governancePolicyVersion: scoped().governancePolicyVersion,
      now,
      auth: agentAuth,
      agentId,
      delegationId: delegation.id,
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      expectedVersion: initiated.version,
      idempotencyKey: 'delegated-native-settlement',
    }, () => {
      agentVerifierCalls++;
      return {
        confirmed: true,
        sourceObserved: true,
        destinationObserved: true,
        reconciled: true,
        evidenceIds: ['agent:source:receipt', 'agent:destination:receipt'],
        claimEffects: [],
        reasons: [],
      };
    })).toThrow();
    expect(agentVerifierCalls).toBe(0);
    expect(store.liquidity.getClaimSet(scoped()).bundles)
      .toMatchObject([{ id: proposal.id, state: 'initiated' }]);
    const later = '2098-01-01T00:10:00.000Z';
    const policy = store.governance.getPolicy({ spaceId });
    if (!policy) throw new Error('Expected governance policy');
    store.governance.setPolicy({
      spaceId,
      expectedVersion: policy.version,
      policy: { minimumApprovers: 2, approvalThresholds: [] },
      now: later,
      auth: humanAuth(actorId, later),
    });
    store.governance.revokeMembership({
      spaceId,
      membershipId: approverMembershipId,
      now: later,
      auth: humanAuth(actorId, later),
    });

    const settlerId = 'current-settler';
    await store.upsertActorMembership(settlerId, 'active', [], '');
    const membership = store.governance.addMembership({
      spaceId,
      actorId: settlerId,
      validFrom: later,
      now: later,
      auth: humanAuth(actorId, later),
    });
    for (const [resourceKind, resourceId] of [
      ['budget', budgetId],
      ['account', 'source'],
      ['account', 'destination'],
    ] as const)
      store.governance.provisionResourceGrant({
        spaceId,
        actorId: settlerId,
        membershipId: membership.id,
        budgetId,
        capability: 'confirmation',
        resourceKind,
        resourceId,
        granted: true,
        now: later,
      });
    const settler = {
      ...scoped(settlerId, later),
      auth: humanAuth(settlerId, '2098-01-01T00:05:00.000Z'),
    };
    const held = store.liquidity.getClaimSet(scoped(actorId, later));

    // Migrated initiated rows may lack all original approval provenance.
    store['db'].prepare(
      'UPDATE action_proposals SET requester_membership_id=NULL,governance_policy_version=NULL WHERE id=?',
    ).run(proposal.id);
    store['db'].prepare(
      'UPDATE proposal_approvals SET issuer_membership_id=NULL,governance_policy_version=NULL WHERE proposal_id=?',
    ).run(proposal.id);

    let verifierCalls = 0;
    const valid = {
      confirmed: true,
      sourceObserved: true,
      destinationObserved: true,
      reconciled: true,
      evidenceIds: ['actual:source:transfer-receipt', 'actual:destination:transfer-receipt'],
      claimEffects: [],
      reasons: [],
    };
    const command = {
      ...settler,
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      expectedVersion: initiated.version,
    };
    expect(() => store.liquidity.verifyTransferSettlement({
      ...command,
      spaceId: 'different-selected-space',
      idempotencyKey: 'wrong-settlement-space',
    }, () => {
      verifierCalls++;
      return valid;
    })).toThrow();
    expect(verifierCalls).toBe(0);

    const unprivilegedId = 'unprivileged-settler';
    await store.upsertActorMembership(unprivilegedId, 'active', [], '');
    store.governance.addMembership({
      spaceId,
      actorId: unprivilegedId,
      validFrom: later,
      now: later,
      auth: humanAuth(actorId, later),
    });
    expect(() => store.liquidity.verifyTransferSettlement({
      ...scoped(unprivilegedId, later),
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      expectedVersion: initiated.version,
      idempotencyKey: 'unprivileged-settlement',
    }, () => {
      verifierCalls++;
      return valid;
    })).toThrow();
    expect(verifierCalls).toBe(0);

    expect(() => store.liquidity.verifyTransferSettlement({
      ...command,
      idempotencyKey: 'stale-settlement-evidence',
    }, () => {
      verifierCalls++;
      return {
        ...valid,
        evidenceIds: [],
      };
    })).toThrow(/Invalid native settlement result/);
    expect(verifierCalls).toBe(1);
    expect(store.liquidity.getClaimSet(scoped(actorId, later))).toEqual(held);

    const settled = store.liquidity.verifyTransferSettlement({
      ...command,
      idempotencyKey: 'current-human-settlement',
    }, () => valid);
    expect(settled.state.phase).toBe('confirmed');
    expect(store.liquidity.getClaimSet(scoped(actorId, later)).bundles).toEqual([]);
  });

  it.each([
    'wrong_actor',
    'wrong_hash',
    'wrong_version',
    'wrong_claim_revision',
    'missing_approval',
    'revoked_approval',
    'expired',
    'cancelled',
  ] as const)(
    'does not weaken %s checks while accepting diagnostic financial failures on a manual initiation report',
    async (failure) => {
      const p = admit();
      if (failure !== 'missing_approval') await approve(p.id);
      const command = {
        ...scoped(),
        proposalId: p.id,
        payloadHash: p.payloadHash,
        expectedVersion: failure === 'missing_approval' ? 1 : 2,
        expectedClaimSetRevision: '1',
        idempotencyKey: `denied-report:${failure}`,
      };
      if (failure === 'wrong_actor') Object.assign(command, scoped('outsider'));
      if (failure === 'wrong_hash') command.payloadHash = 'b'.repeat(64);
      if (failure === 'wrong_version') command.expectedVersion = 1;
      if (failure === 'wrong_claim_revision') command.expectedClaimSetRevision = '0';
      if (failure === 'expired')
        Object.assign(command, scoped(actorId, '2100-01-01T00:00:00.000Z'));
      if (failure === 'revoked_approval')
        store.governance.provisionResourceGrant({
          spaceId,
          actorId: approverId,
          membershipId: approverMembershipId,
          budgetId,
          capability: 'approval',
          resourceKind: 'account',
          resourceId: 'source',
          granted: false,
          now,
        });
      if (failure === 'cancelled') {
        const cancelled = store.liquidity.cancelTransfer({
          ...command,
          idempotencyKey: 'cancel-before-report',
        });
        command.expectedVersion = cancelled.version;
      }
      const before = await store.getProposal(p.id);
      const claims = store.liquidity.getClaimSet(scoped());
      expect(() =>
        store.liquidity.reportTransferInitiated(command, () => ({
          valid: false,
          reason: 'financial_preconditions_changed',
        })),
      ).toThrow();
      expect(await store.getProposal(p.id)).toEqual(before);
      expect(store.liquidity.getClaimSet(scoped())).toEqual(claims);
    },
  );
  it('migrates legacy proposals and preserves exact approvals and hashes after reopen', async () => {
    store.close();
    path = join(directory, 'legacy.sqlite');
    const legacy = new Database(path);
    legacy.exec(
      'CREATE TABLE schema_version(version INTEGER NOT NULL UNIQUE, applied_at TEXT NOT NULL)',
    );
    const migrations = (
      SqliteWorkflowStore as unknown as { MIGRATIONS: Array<(db: Database.Database) => void> }
    ).MIGRATIONS;
    for (const migration of migrations.slice(0, 9)) migration(legacy);
    legacy.prepare('INSERT INTO schema_version VALUES (9,?)').run(now);
    legacy
      .prepare(
        "INSERT INTO actor_memberships(actor_id,status,capabilities,scope) VALUES ('legacy','active','[\"categorization:execute\"]',?)",
      )
      .run(`budget:${budgetId}`);
    legacy
      .prepare(
        'INSERT INTO registration_state(singleton,owner_user_id,bootstrapped_at) VALUES (1,?,?)',
      )
      .run('legacy', now);
    const hash = 'f'.repeat(64);
    legacy
      .prepare(
        "INSERT INTO categorization_proposals (id,operation,budget_id,transaction_id,category_id,payload_hash,policy_version,preconditions,expires_at,actor_id,provenance,created_at) VALUES ('legacy-proposal','set_category',?,'transaction','food',?,'1','{\"currentCategoryId\":null}',?,'legacy','human',?)",
      )
      .run(budgetId, hash, expiresAt, now);
    legacy
      .prepare(
        "INSERT INTO proposal_approvals(id,proposal_id,payload_hash,actor_id,status,expires_at,created_at) VALUES ('legacy-approval','legacy-proposal',?,'legacy','active',?,?)",
      )
      .run(hash, expiresAt, now);
    legacy.close();
    store = new SqliteWorkflowStore(path);
    expect(await store.getProposal('legacy-proposal')).toMatchObject({
      id: 'legacy-proposal',
      payloadHash: hash,
      preconditions: '{"currentCategoryId":null}',
      payload: { kind: 'set_category', transactionId: 'transaction', categoryId: 'food' },
    });
    expect(await store.getApproval('legacy-approval')).toMatchObject({
      id: 'legacy-approval',
      payloadHash: hash,
      status: 'superseded',
    });
    const legacySpace = store.governance.createSpace({
      actorId: 'legacy',
      name: 'Migrated legacy workflow',
      kind: 'shared',
      now,
      auth: humanAuth('legacy'),
    });
    spaceId = store.governance.bindBudget({
      spaceId: legacySpace.id,
      budgetId,
      now,
      auth: humanAuth('legacy'),
    }).id;
    ownerMembershipId = store.governance.getCurrentMembership({
      spaceId,
      actorId: 'legacy',
      now,
    })!.id;
    store.governance.provisionResourceGrant({
      spaceId,
      actorId: 'legacy',
      membershipId: ownerMembershipId,
      budgetId,
      capability: 'source',
      resourceKind: 'account',
      resourceId: 'source',
      granted: true,
      now,
    });
    store.close();
    store = new SqliteWorkflowStore(path);
    expect(await store.getApproval('legacy-approval')).toMatchObject({
      payloadHash: hash,
      status: 'superseded',
    });
    expect(
      store.liquidity.isAuthorized({
        ...scoped('legacy'),
        resourceKind: 'account',
        resourceId: 'source',
        capability: 'source',
      }),
    ).toBe(true);
    await store.upsertActorMembership('observer', 'active', [], '');
    store.governance.addMembership({
      spaceId,
      actorId: 'observer',
      validFrom: now,
      now,
      auth: humanAuth('legacy'),
    });
    expect(
      store.liquidity.isAuthorized({
        ...scoped('observer'),
        resourceKind: 'account',
        resourceId: 'source',
        capability: 'source',
      }),
    ).toBe(false);
  });
  it('reads attributed transfer audit metadata at the supplied trusted time', () => {
    const proposal = admit();
    const audit = store.liquidity.getTransferAudit({
      ...scoped(),
      proposalId: proposal.id,
    });
    expect(audit).toContainEqual(expect.objectContaining({
      classification: 'workflow_transition',
      timestamp: now,
      actor_id: actorId,
      operation: 'transfer',
      proposal_id: proposal.id,
      budget_id: budgetId,
      result: 'transfer:admit',
      idempotency_key: proposal.payloadHash,
    }));
    expect(() => store.liquidity.getTransferAudit({
      ...scoped('outsider'),
      proposalId: proposal.id,
    })).toThrow();
  });
  it('retains reservations on ambiguous settlement and rejects unconfirmed empty effects', async () => {
    const p = admit();
    await initiate(p.id);
    const before = store.liquidity.getClaimSet(scoped());
    const input = {
      ...scoped(),
      proposalId: p.id,
      payloadHash: p.payloadHash,
      expectedVersion: 3,
      idempotencyKey: 'ambiguous',
    };
    const ambiguous = {
      confirmed: false,
      sourceObserved: false,
      destinationObserved: false,
      reconciled: false,
      evidenceIds: [],
      claimEffects: null,
      reasons: ['duplicate_candidate'],
    };
    store.liquidity.verifyTransferSettlement(input, () => ambiguous);
    expect(store.liquidity.getClaimSet(scoped())).toEqual(before);
    expect(() =>
      store.liquidity.verifyTransferSettlement(
        { ...input, expectedVersion: 4, idempotencyKey: 'empty' },
        () => ({ ...ambiguous, claimEffects: [] }),
      ),
    ).toThrow();
    expect(store.liquidity.getClaimSet(scoped())).toEqual(before);
  });
  it('denies nonmembers and wrong-resource grants before exposing action data', async () => {
    const p = admit();
    expect(() =>
      store.liquidity.getTransferProposal({ ...scoped('outsider'), proposalId: p.id }),
    ).toThrow();
    store.governance.provisionResourceGrant({
      spaceId,
      actorId,
      membershipId: ownerMembershipId,
      budgetId,
      capability: 'liquidity',
      resourceKind: 'account',
      resourceId: 'source',
      granted: false,
      now,
    });
    expect(() =>
      store.liquidity.getTransferProposal({ ...scoped(), proposalId: p.id }),
    ).toThrow();
    expect(() =>
      store.liquidity.approveTransfer(
        {
          ...scoped('outsider'),
          proposalId: p.id,
          payloadHash: p.payloadHash,
          expectedVersion: 1,
          expectedClaimSetRevision: '1',
          idempotencyKey: 'denied',
        },
        () => ({ valid: true }),
      ),
    ).toThrow();
  });
  it('does not infer account visibility or source authority from a conclusion grant', async () => {
    await store.upsertActorMembership('reader', 'active', [], '');
    const readerMembership = store.governance.addMembership({
      spaceId,
      actorId: 'reader',
      validFrom: now,
      now,
      auth: humanAuth(actorId),
    });
    store.governance.provisionResourceGrant({
      spaceId,
      actorId: 'reader',
      membershipId: readerMembership.id,
      budgetId,
      capability: 'conclusion',
      resourceKind: 'budget',
      resourceId: budgetId,
      granted: true,
      now,
    });
    expect(
      store.liquidity.isAuthorized({
        ...scoped('reader'),
        capability: 'conclusion',
        resourceKind: 'budget',
        resourceId: budgetId,
      }),
    ).toBe(true);
    for (const capability of ['name', 'balance', 'source'] as const)
      expect(
        store.liquidity.isAuthorized({
          ...scoped('reader'),
          capability,
          resourceKind: 'account',
          resourceId: 'source',
        }),
      ).toBe(false);
    const p = admit();
    expect(() =>
      store.liquidity.getTransferProposal({
        ...scoped('reader'),
        proposalId: p.id,
      }),
    ).toThrow();
  });
  it('admits aggregate conclusion readers to exact trusted intents without private transfer reads', async () => {
    const proposal = admit();
    const readerId = 'aggregate-reader';
    await store.upsertActorMembership(readerId, 'active', [], '');
    const readerMembership = store.governance.addMembership({
      spaceId,
      actorId: readerId,
      validFrom: now,
      now,
      auth: humanAuth(actorId),
    });
    const restrictions = {
      aggregateOnly: true,
      operations: ['transfer'],
      maxGrossOutgoing: [money('20')],
      maxOperationCount: 1,
    };
    const grant = {
      spaceId,
      actorId: readerId,
      membershipId: readerMembership.id,
      budgetId,
      capability: 'conclusion',
      resourceKind: 'budget' as const,
      resourceId: budgetId,
      granted: true,
      restrictions,
      now,
    };
    store.governance.provisionResourceGrant(grant);
    const reader = { ...scoped(readerId), membershipId: readerMembership.id };
    const conclusion = { ...reader, capability: 'conclusion' as const };

    const completePlan = {
      ...proposal.payload.plan,
      scenario: {
        kind: 'purchases' as const,
        items: [
          {
            id: 'purchase-A',
            categoryId: 'cat-A',
            amount: money('10'),
            purchaseAt: now,
            requiredBy: expiresAt,
            routeSelection: {
              explicitAccountId: 'route-A',
              sessionAccountId: null,
              approvedPreference: { accountId: 'route-B', referenceId: 'approved-route' },
              historicalRoute: { accountId: 'route-C', referenceId: 'historical-route' },
            },
          },
          {
            id: 'purchase-B',
            categoryId: 'cat-B',
            amount: money('10'),
            purchaseAt: now,
            requiredBy: expiresAt,
            routeSelection: {
              explicitAccountId: null,
              sessionAccountId: null,
              approvedPreference: null,
              historicalRoute: null,
            },
          },
        ],
      },
      backingAfter: {
        ...proposal.payload.plan.backingAfter,
        lines: [{
          accountId: 'backing-account',
          categoryId: 'backing-category',
          cashBucketId: 'backing-bucket',
          amount: money('10'),
        }],
      },
    };
    const authorizedPlan = () => store.liquidity.isTransferPlanAuthorized({
      ...conclusion,
      plan: completePlan,
      capability: 'conclusion',
      phase: 'read',
    });
    expect(authorizedPlan()).toBe(true);
    store.governance.provisionResourceGrant({
      ...grant,
      restrictions: { ...restrictions, accountIds: ['source'] },
    });
    expect(authorizedPlan()).toBe(false);
    store.governance.provisionResourceGrant({
      ...grant,
      restrictions: {
        ...restrictions,
        accountIds: ['source', 'destination'],
        categoryIds: ['cat-A'],
      },
    });
    expect(authorizedPlan()).toBe(false);
    store.governance.provisionResourceGrant({
      ...grant,
      restrictions: {
        ...restrictions,
        accountIds: ['source', 'destination', 'route-A', 'route-B', 'route-C'],
        categoryIds: ['cat-A', 'cat-B', 'backing-category'],
      },
    });
    expect(authorizedPlan()).toBe(false);
    store.governance.provisionResourceGrant({
      ...grant,
      restrictions: {
        ...restrictions,
        accountIds: ['source', 'destination', 'route-A', 'route-B', 'route-C', 'backing-account'],
        categoryIds: ['cat-A', 'cat-B'],
      },
    });
    expect(authorizedPlan()).toBe(false);
    store.governance.provisionResourceGrant({
      ...grant,
      restrictions: {
        ...restrictions,
        accountIds: ['source', 'destination', 'route-A', 'route-B', 'route-C', 'backing-account'],
        categoryIds: ['cat-A', 'cat-B', 'backing-category'],
      },
    });
    expect(authorizedPlan()).toBe(true);
    store.governance.provisionResourceGrant({ ...grant, restrictions });

    const trustedResources = [
      { resourceKind: 'account' as const, resourceId: 'acct-A' },
      { resourceKind: 'category' as const, resourceId: 'cat-A' },
    ];
    const isAuthorizedClosure = (resources: typeof trustedResources) =>
      store.liquidity.isAuthorized({
        ...reader,
        resourceKind: 'budget',
        resourceId: budgetId,
        capability: 'conclusion',
        operation: 'transfer',
        phase: 'read',
        visibility: 'aggregate',
        operations: [{
          operation: 'transfer',
          direction: 'outgoing',
          amount: money('20'),
          sourceAccountId: 'acct-A',
          destinationAccountId: 'acct-A',
        }],
        resources,
      });
    store.governance.provisionResourceGrant({
      ...grant,
      restrictions: { ...restrictions, accountIds: ['acct-A'], categoryIds: ['cat-A'] },
    });
    expect(isAuthorizedClosure(trustedResources)).toBe(true);
    expect(isAuthorizedClosure([
      ...trustedResources,
      { resourceKind: 'account', resourceId: 'acct-B' },
    ])).toBe(false);
    expect(isAuthorizedClosure([
      ...trustedResources,
      { resourceKind: 'category', resourceId: 'cat-B' },
    ])).toBe(false);
    store.governance.provisionResourceGrant({ ...grant, restrictions });

    expect(store.liquidity.listTransferProposalIntents(conclusion)).toEqual([proposal]);
    expect(store.liquidity.getTransferProposalIntent({
      ...conclusion,
      proposalId: proposal.id,
    })).toEqual(proposal);
    expect(() => store.liquidity.getTransferProposal({
      ...reader,
      proposalId: proposal.id,
    })).toThrow();

    store.governance.provisionResourceGrant({
      ...grant,
      restrictions: { ...restrictions, maxGrossOutgoing: [money('19')] },
    });
    expect(store.liquidity.listTransferProposalIntents(conclusion)).toEqual([]);
    expect(() => store.liquidity.getTransferProposalIntent({
      ...conclusion,
      proposalId: proposal.id,
    })).toThrow();
    store.governance.provisionResourceGrant({
      ...grant,
      restrictions: { ...restrictions, maxOperationCount: 0 },
    });
    expect(store.liquidity.listTransferProposalIntents(conclusion)).toEqual([]);
    expect(() => store.liquidity.getTransferProposalIntent({
      ...conclusion,
      proposalId: proposal.id,
    })).toThrow();

    store.governance.provisionResourceGrant({ ...grant, now: after });
    const foreignBudget = { ...conclusion, budgetId: 'foreign-budget' };
    expect(() => store.liquidity.listTransferProposalIntents(foreignBudget)).toThrow();
    expect(() => store.liquidity.getTransferProposalIntent({
      ...foreignBudget,
      proposalId: proposal.id,
    })).toThrow();

    store.governance.provisionResourceGrant({ ...grant, granted: false, now: after });
    const afterRevocation = {
      ...scoped(readerId, after),
      membershipId: readerMembership.id,
      capability: 'conclusion' as const,
    };
    expect(() => store.liquidity.listTransferProposalIntents(afterRevocation)).toThrow();
    expect(() => store.liquidity.getTransferProposalIntent({
      ...afterRevocation,
      proposalId: proposal.id,
    })).toThrow();

    store.governance.revokeMembership({
      spaceId,
      membershipId: readerMembership.id,
      now: after,
      auth: humanAuth(actorId, after),
    });
    const replacementMembership = store.governance.addMembership({
      spaceId,
      actorId: readerId,
      validFrom: after,
      now: after,
      auth: humanAuth(actorId, after),
    });
    const oldPeriod = {
      ...scoped(readerId, after),
      membershipId: readerMembership.id,
      capability: 'conclusion' as const,
    };
    expect(replacementMembership.id).not.toBe(readerMembership.id);
    expect(() => store.liquidity.listTransferProposalIntents(oldPeriod)).toThrow();
    expect(() => store.liquidity.getTransferProposalIntent({
      ...oldPeriod,
      proposalId: proposal.id,
    })).toThrow();
  });
  it('binds immutable plans, exact approvals and idempotency identity', async () => {
    const p = admit();
    expect('transactionId' in p).toBe(false);
    expect('categoryId' in p).toBe(false);
    const second = admit('b'.repeat(64), '1');
    expect(second.payloadHash).toBe('b'.repeat(64));
    expect(
      store.liquidity.getClaimSet(scoped()).bundles.map((b) => b.id),
    ).toEqual(expect.arrayContaining([p.id, second.id]));
    await expect(approve(p.id, 'c'.repeat(64))).rejects.toThrow();
    expect(() =>
      store.liquidity.admitTransferProposal(
        {
          ...scoped(),
          plan: { ...plan(), minimumAmount: money('999') },
          expectedClaimSetRevision: '0',
          idempotencyKey: 'a'.repeat(64),
        },
        () => ({ valid: true }),
      ),
    ).toThrow();
    expect(
      store.liquidity.getTransferProposal({ ...scoped(), proposalId: p.id }).payload.plan
        .minimumAmount,
    ).toEqual(money('20'));
  });
  it('serializes competing admissions with an independent claim revision and current effects', () => {
    admit();
    expect(() => admit('b'.repeat(64))).toThrow();
    let seen: unknown;
    expect(() =>
      store.liquidity.admitTransferProposal(
        {
          ...scoped(),
          plan: { ...plan('b'.repeat(64)), snapshotId: 'new-snapshot', claimSetRevision: '1' },
          expectedClaimSetRevision: '1',
          idempotencyKey: 'second',
        },
        (context) => {
          seen = context.claimSet;
          return { valid: false, reason: 'source_insufficient' };
        },
      ),
    ).toThrow();
    expect(seen).toMatchObject({
      revision: '1',
      bundles: [{ creationSnapshotId: 'snapshot', effects: [{ resourceId: 'source' }] }],
    });
    expect(store.liquidity.getClaimSet(scoped()).revision).toBe('1');
  });
  it.each(['source', 'destination'] as const)(
    'accepts %s first without releasing claims until both reconciled',
    async (side) => {
      const p = admit();
      await initiate(p.id);
      const observed: TransferSettlementResult = {
        confirmed: false,
        sourceObserved: side === 'source',
        destinationObserved: side === 'destination',
        reconciled: false,
        evidenceIds: [side],
        claimEffects: plan().reservations,
        reasons: [],
      };
      const input = {
        ...scoped(),
        proposalId: p.id,
        payloadHash: p.payloadHash,
        expectedVersion: 3,
        idempotencyKey: 'observe',
      };
      const first = store.liquidity.verifyTransferSettlement(input, () => observed);
      expect(first.state.phase).toBe('initiated');
      expect(store.liquidity.getClaimSet(scoped()).bundles[0]?.state).toBe('initiated');
      const final = store.liquidity.verifyTransferSettlement(
        { ...input, expectedVersion: 4, idempotencyKey: 'settle' },
        () => ({
          confirmed: true,
          sourceObserved: true,
          destinationObserved: true,
          reconciled: true,
          evidenceIds: ['source', 'destination'],
          claimEffects: [],
          reasons: [],
        }),
      );
      expect(final.state.phase).toBe('confirmed');
      expect(store.liquidity.getClaimSet(scoped()).bundles).toEqual([]);
    },
  );
  it('replays transitions exactly and consumes evidence exclusively across proposals', async () => {
    const p = admit();
    await initiate(p.id);
    const input = {
      ...scoped(),
      proposalId: p.id,
      payloadHash: p.payloadHash,
      expectedVersion: 3,
      idempotencyKey: 'settle',
    };
    const result = {
      confirmed: true,
      sourceObserved: true,
      destinationObserved: true,
      reconciled: true,
      evidenceIds: ['source', 'destination'],
      claimEffects: [],
      reasons: [],
    };
    const settled = store.liquidity.verifyTransferSettlement(input, () => result);
    expect(
      store.liquidity.verifyTransferSettlement(input, () => {
        throw new Error('must not verify replay');
      }),
    ).toEqual(settled);
    const revision = store.liquidity.getClaimSet(scoped()).revision;
    const second = admit('b'.repeat(64), revision);
    store.liquidity.approveTransfer(
      {
        ...input,
        ...scoped(approverId),
        proposalId: second.id,
        payloadHash: second.payloadHash,
        expectedVersion: 1,
        expectedClaimSetRevision: String(Number(revision) + 1),
        idempotencyKey: 'approve-second',
      },
      () => ({ valid: true }),
    );
    store.liquidity.reportTransferInitiated(
      {
        ...input,
        proposalId: second.id,
        payloadHash: second.payloadHash,
        expectedVersion: 2,
        expectedClaimSetRevision: String(Number(revision) + 1),
        idempotencyKey: 'initiate-second',
      },
      () => ({ valid: true }),
    );
    expect(() =>
      store.liquidity.verifyTransferSettlement(
        {
          ...input,
          proposalId: second.id,
          payloadHash: second.payloadHash,
          idempotencyKey: 'settle-second',
        },
        () => result,
      ),
    ).toThrow();
  });
  it('retains initiated holds through expiry, cancellation and reconciliation-required outcomes', async () => {
    const p = admit();
    await initiate(p.id);
    const late = '2100-01-01T00:00:00.000Z';
    store.liquidity.expire(scoped(actorId, late));
    const current = store.liquidity.getTransferProposal({
      ...scoped(actorId, late),
      proposalId: p.id,
    });
    expect(current.state).toMatchObject({ phase: 'initiated', outcome: 'expired' });
    expect(store.liquidity.getClaimSet(scoped(actorId, late)).bundles[0]?.state).toBe(
      'initiated',
    );
    store.liquidity.cancelTransfer({
      ...scoped(actorId, late),
      proposalId: p.id,
      payloadHash: p.payloadHash,
      expectedVersion: current.version,
      idempotencyKey: 'cancel',
    });
    expect(store.liquidity.getClaimSet(scoped(actorId, late)).bundles[0]?.state).toBe(
      'initiated',
    );
  });
  it('edits sessions with CAS and invalidates linked approvals without erasing initiated claims', async () => {
    const session = store.liquidity.saveSpendSession(
      {
        ...scoped(),
        id: 'session',
        expectedVersion: 0,
        idempotencyKey: 'session-create',
        expiresAt,
        accountId: 'destination',
        items: [
          {
            id: 'item',
            categoryId: 'food',
            amount: money('20'),
            purchaseAt: now,
            requiredBy: expiresAt,
            routeSelection: {
              explicitAccountId: null,
              sessionAccountId: 'destination',
              approvedPreference: null,
              historicalRoute: null,
            },
          },
        ],
      },
      () => ({ valid: true }),
    );
    const p = admit('a'.repeat(64), '0', session.id);
    await approve(p.id);
    const update = {
      ...scoped(),
      id: session.id,
      expectedVersion: 1,
      idempotencyKey: 'session-edit',
      expiresAt,
      accountId: 'source',
      items: session.items,
    };
    store.liquidity.saveSpendSession(update, () => ({ valid: true }));
    expect(await store.findActiveApprovals(p.id)).toEqual([]);
    expect(
      store.liquidity.getTransferProposal({ ...scoped(), proposalId: p.id }).state.outcome,
    ).toBe('superseded');
    expect(() =>
      store.liquidity.saveSpendSession({ ...update, idempotencyKey: 'stale' }, () => ({
        valid: true,
      })),
    ).toThrow();
    expect(store.liquidity.saveSpendSession(update, () => ({ valid: true })).version).toBe(2);
  });
  it('replays approvals and sessions after human proof renewal without revalidating or writing twice', async () => {
    const proposal = admit();
    const approvalInput = {
      ...scoped(approverId),
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      expectedVersion: 1,
      expectedClaimSetRevision: '1',
      idempotencyKey: 'approval-proof-renewal',
    };
    const validateApproval = vi.fn(() => ({ valid: true }));
    const approved = store.liquidity.approveTransfer(approvalInput, validateApproval);
    const approvalReplay = store.liquidity.approveTransfer(
      {
        ...approvalInput,
        now: after,
        auth: { ...humanAuth(approverId, after), sessionId: 'renewed-approval-session' },
      },
      validateApproval,
    );
    expect(approvalReplay).toEqual(approved);
    expect(validateApproval).toHaveBeenCalledTimes(1);
    expect(await store.findActiveApprovals(proposal.id)).toHaveLength(1);

    const sessionInput = {
      ...scoped(),
      id: 'proof-renewal-session',
      expectedVersion: 0,
      idempotencyKey: 'session-proof-renewal',
      expiresAt,
      accountId: null,
      items: [],
    };
    const validateSession = vi.fn(() => ({ valid: true }));
    const saved = store.liquidity.saveSpendSession(sessionInput, validateSession);
    const sessionReplay = store.liquidity.saveSpendSession(
      {
        ...sessionInput,
        now: after,
        auth: { ...humanAuth(actorId, after), sessionId: 'renewed-session-proof' },
      },
      validateSession,
    );
    expect(sessionReplay).toEqual(saved);
    expect(sessionReplay.version).toBe(1);
    expect(validateSession).toHaveBeenCalledTimes(1);
  });

  it('denies approval replays after principal mismatch or current membership revocation', async () => {
    const proposal = admit();
    const input = {
      ...scoped(approverId),
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      expectedVersion: 1,
      expectedClaimSetRevision: '1',
      idempotencyKey: 'approval-current-authority',
    };
    const validator = () => ({ valid: true });
    store.liquidity.approveTransfer(input, validator);
    expect(() =>
      store.liquidity.approveTransfer(
        { ...input, now: after, auth: humanAuth(actorId, after) },
        validator,
      ),
    ).toThrow();

    store.governance.revokeMembership({
      spaceId,
      membershipId: approverMembershipId,
      now: after,
      auth: humanAuth(actorId, after),
    });
    expect(() =>
      store.liquidity.approveTransfer(
        {
          ...scoped(approverId, after),
          proposalId: proposal.id,
          payloadHash: proposal.payloadHash,
          expectedVersion: 1,
          expectedClaimSetRevision: '1',
          idempotencyKey: input.idempotencyKey,
          auth: humanAuth(approverId, after),
        },
        validator,
      ),
    ).toThrow();
  });
});
