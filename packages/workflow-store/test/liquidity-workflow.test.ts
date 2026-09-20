import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteWorkflowStore } from '../src/store.js';
import type { TransferPlan, TransferSettlementResult } from '@balanceframe/protocol-generated';

const now = '2098-01-01T00:00:00.000Z';
const expiresAt = '2099-01-01T00:00:00.000Z';
const budgetId = 'budget';
const actorId = 'holder';
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

describe('resource-scoped consequential actions', () => {
  let store: SqliteWorkflowStore;
  let directory: string;
  let path: string;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'liquidity-workflow-'));
    path = join(directory, 'workflow.sqlite');
    store = new SqliteWorkflowStore(path);
    await store.upsertActorMembership(
      actorId,
      'active',
      capabilities.map((c) => `liquidity:${c}`),
      `budget:${budgetId}`,
    );
    for (const capability of capabilities)
      for (const [resourceKind, resourceId] of [
        ['budget', budgetId],
        ['account', 'source'],
        ['account', 'destination'],
        ['category', 'food'],
      ] as const) {
        store.liquidity.setResourceGrant({
          actorId,
          budgetId,
          capability,
          resourceKind,
          resourceId,
          granted: true,
          now,
        });
      }
    store.liquidity.savePolicy({
      actorId,
      budgetId,
      expectedVersion: null,
      now,
      policy: { version: '1', policyHash: 'policy', expiresAt, accounts: [], transferRoutes: [] },
      approvalPolicy: { minimumApprovers: 1 },
    });
  });
  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  it('persists an immutable actor-scoped transfer preview without admitting claims', () => {
    const preview = store.liquidity.saveTransferPreview({ actorId, budgetId, plan: plan(), now });
    expect(preview.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(preview.plan.payloadHash).toBe(plan().payloadHash);
    expect(store.liquidity.getClaimSet({ actorId, budgetId, now })).toEqual({
      revision: '0',
      bundles: [],
    });
    store.close();
    store = new SqliteWorkflowStore(path);
    expect(store.liquidity.getTransferPreview({ actorId, budgetId, id: preview.id })).toEqual(
      preview,
    );
    expect(() =>
      store.liquidity.getTransferPreview({ actorId: 'other', budgetId, id: preview.id }),
    ).toThrow(/authoriz/i);
    expect(() =>
      store.liquidity.getTransferPreview({ actorId, budgetId: 'foreign-budget', id: preview.id }),
    ).toThrow(/authoriz/i);
  });
  it('rejects transfer preview overwrite and retains expired originals for trusted replay lookup', () => {
    const preview = store.liquidity.saveTransferPreview({
      actorId,
      budgetId,
      id: 'server-generated-preview-id',
      plan: plan(),
      now,
    });
    expect(() =>
      store.liquidity.saveTransferPreview({
        actorId,
        budgetId,
        id: preview.id,
        plan: plan('b'.repeat(64)),
        now,
      }),
    ).toThrow(/immutable|unique|exists/i);
    const original = store.liquidity.getTransferPreview({ actorId, budgetId, id: preview.id });
    expect(original?.plan).toEqual(plan());
    expect(() =>
      store.liquidity.admitTransferProposal(
        {
          actorId,
          budgetId,
          plan: original!.plan,
          expectedClaimSetRevision: '0',
          idempotencyKey: 'expired-preview',
          now: '2100-01-01T00:00:00.000Z',
        },
        () => ({ valid: true }),
      ),
    ).toThrow(/expir/i);
    expect(store.liquidity.getTransferPreview({ actorId, budgetId, id: preview.id })).toEqual(
      original,
    );
  });
  it('replays admitted preview intent with a fresh server clock without admitting it twice', () => {
    const preview = store.liquidity.saveTransferPreview({ actorId, budgetId, plan: plan(), now });
    const input = {
      actorId,
      budgetId,
      plan: preview.plan,
      expectedClaimSetRevision: '0',
      idempotencyKey: 'preview-admission',
      now,
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
        actorId,
        budgetId,
        plan: { ...plan(hash), claimSetRevision: revision },
        expectedClaimSetRevision: revision,
        idempotencyKey: hash,
        now,
        sessionId,
      },
      () => ({ valid: true }),
    );
  }
  async function approve(id: string, payloadHash = 'a'.repeat(64)) {
    return store.liquidity.approveTransfer(
      {
        actorId,
        budgetId,
        proposalId: id,
        payloadHash,
        expectedVersion: 1,
        expectedClaimSetRevision: '1',
        idempotencyKey: `approve:${id}`,
        now,
      },
      () => ({ valid: true }),
    );
  }
  async function initiate(id: string, payloadHash = 'a'.repeat(64)) {
    await approve(id, payloadHash);
    return store.liquidity.reportTransferInitiated(
      {
        actorId,
        budgetId,
        proposalId: id,
        payloadHash,
        expectedVersion: 2,
        expectedClaimSetRevision: '1',
        idempotencyKey: `initiate:${id}`,
        now,
      },
      () => ({ valid: true }),
    );
  }
  it('records an authorized already-initiated manual transfer when fresh financial preconditions changed', async () => {
    const p = admit();
    await approve(p.id);
    const approvals = await store.findActiveApprovals(p.id);
    const command = {
      actorId,
      budgetId,
      proposalId: p.id,
      payloadHash: p.payloadHash,
      expectedVersion: 2,
      expectedClaimSetRevision: '1',
      idempotencyKey: 'manual-transfer-report',
      now,
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
    const held = store.liquidity.getClaimSet({ actorId, budgetId, now });
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
    expect(store.liquidity.getClaimSet({ actorId, budgetId, now })).toEqual(held);
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
        actorId,
        budgetId,
        proposalId: p.id,
        payloadHash: p.payloadHash,
        expectedVersion: failure === 'missing_approval' ? 1 : 2,
        expectedClaimSetRevision: '1',
        idempotencyKey: `denied-report:${failure}`,
        now,
      };
      if (failure === 'wrong_actor') command.actorId = 'outsider';
      if (failure === 'wrong_hash') command.payloadHash = 'b'.repeat(64);
      if (failure === 'wrong_version') command.expectedVersion = 1;
      if (failure === 'wrong_claim_revision') command.expectedClaimSetRevision = '0';
      if (failure === 'expired') command.now = '2100-01-01T00:00:00.000Z';
      if (failure === 'revoked_approval')
        store.liquidity.setResourceGrant({
          actorId,
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
      const claims = store.liquidity.getClaimSet({ actorId, budgetId, now });
      expect(() =>
        store.liquidity.reportTransferInitiated(command, () => ({
          valid: false,
          reason: 'financial_preconditions_changed',
        })),
      ).toThrow();
      expect(await store.getProposal(p.id)).toEqual(before);
      expect(store.liquidity.getClaimSet({ actorId, budgetId, now })).toEqual(claims);
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
    expect(await store.verifyApprovalForExecution('legacy-proposal', hash)).toBeNull();
    expect((await store.consumeApproval('legacy-approval')).status).toBe('consumed');
    expect(store.liquidity.isOwner({ actorId: 'legacy', budgetId })).toBe(true);
    store.liquidity.provisionOwnerAccess({
      actorId: 'legacy',
      budgetId,
      resources: [{ resourceKind: 'account', resourceId: 'source' }],
      now,
    });
    store.close();
    store = new SqliteWorkflowStore(path);
    expect((await store.getApproval('legacy-approval'))?.payloadHash).toBe(hash);
    expect(
      store.liquidity.isAuthorized({
        actorId: 'legacy',
        budgetId,
        resourceKind: 'account',
        resourceId: 'source',
        capability: 'source',
      }),
    ).toBe(true);
    await store.upsertActorMembership('observer', 'active', ['observe'], `budget:${budgetId}`);
    expect(() =>
      store.liquidity.provisionOwnerAccess({ actorId: 'observer', budgetId, resources: [], now }),
    ).toThrow(/authoriz/i);
    expect(
      store.liquidity.isAuthorized({
        actorId: 'observer',
        budgetId,
        resourceKind: 'account',
        resourceId: 'source',
        capability: 'source',
      }),
    ).toBe(false);
  });
  it('retains reservations on ambiguous settlement and rejects unconfirmed empty effects', async () => {
    const p = admit();
    await initiate(p.id);
    const before = store.liquidity.getClaimSet({ actorId, budgetId, now });
    const input = {
      actorId,
      budgetId,
      proposalId: p.id,
      payloadHash: p.payloadHash,
      expectedVersion: 3,
      idempotencyKey: 'ambiguous',
      now,
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
    expect(store.liquidity.getClaimSet({ actorId, budgetId, now })).toEqual(before);
    expect(() =>
      store.liquidity.verifyTransferSettlement(
        { ...input, expectedVersion: 4, idempotencyKey: 'empty' },
        () => ({ ...ambiguous, claimEffects: [] }),
      ),
    ).toThrow(/native settlement/i);
    expect(store.liquidity.getClaimSet({ actorId, budgetId, now })).toEqual(before);
  });
  it('denies nonmembers and wrong-resource grants before exposing action data', async () => {
    const p = admit();
    expect(() =>
      store.liquidity.getTransferProposal({ actorId: 'outsider', budgetId, proposalId: p.id }),
    ).toThrow(/authoriz/i);
    store.liquidity.setResourceGrant({
      actorId,
      budgetId,
      capability: 'proposal',
      resourceKind: 'account',
      resourceId: 'source',
      granted: false,
      now,
    });
    expect(() =>
      store.liquidity.getTransferProposal({ actorId, budgetId, proposalId: p.id }),
    ).toThrow(/authoriz/i);
    expect(() =>
      store.liquidity.approveTransfer(
        {
          actorId: 'outsider',
          budgetId,
          proposalId: p.id,
          payloadHash: p.payloadHash,
          expectedVersion: 1,
          expectedClaimSetRevision: '1',
          idempotencyKey: 'denied',
          now,
        },
        () => ({ valid: true }),
      ),
    ).toThrow(/authoriz/i);
  });
  it('does not infer account visibility or source authority from a conclusion grant', async () => {
    await store.upsertActorMembership(
      'reader',
      'active',
      ['liquidity:conclusion'],
      `budget:${budgetId}`,
    );
    store.liquidity.setResourceGrant({
      actorId: 'reader',
      budgetId,
      capability: 'conclusion',
      resourceKind: 'budget',
      resourceId: budgetId,
      granted: true,
      now,
    });
    expect(
      store.liquidity.isAuthorized({
        actorId: 'reader',
        budgetId,
        capability: 'conclusion',
        resourceKind: 'budget',
        resourceId: budgetId,
      }),
    ).toBe(true);
    for (const capability of ['name', 'balance', 'source'] as const)
      expect(
        store.liquidity.isAuthorized({
          actorId: 'reader',
          budgetId,
          capability,
          resourceKind: 'account',
          resourceId: 'source',
        }),
      ).toBe(false);
    const p = admit();
    expect(() =>
      store.liquidity.getTransferProposal({ actorId: 'reader', budgetId, proposalId: p.id }),
    ).toThrow(/authoriz/i);
  });
  it('binds immutable plans, exact approvals and idempotency identity', async () => {
    const p = admit();
    expect('transactionId' in p).toBe(false);
    expect('categoryId' in p).toBe(false);
    const second = admit('b'.repeat(64), '1');
    expect(second.payloadHash).toBe('b'.repeat(64));
    expect(
      store.liquidity.getClaimSet({ actorId, budgetId, now }).bundles.map((b) => b.id),
    ).toEqual(expect.arrayContaining([p.id, second.id]));
    await expect(approve(p.id, 'c'.repeat(64))).rejects.toThrow(/hash|revision/i);
    expect(() =>
      store.liquidity.admitTransferProposal(
        {
          actorId,
          budgetId,
          plan: { ...plan(), minimumAmount: money('999') },
          expectedClaimSetRevision: '0',
          idempotencyKey: 'a'.repeat(64),
          now,
        },
        () => ({ valid: true }),
      ),
    ).toThrow(/replay|immutable/i);
    expect(
      store.liquidity.getTransferProposal({ actorId, budgetId, proposalId: p.id }).payload.plan
        .minimumAmount,
    ).toEqual(money('20'));
  });
  it('serializes competing admissions with an independent claim revision and current effects', () => {
    admit();
    expect(() => admit('b'.repeat(64))).toThrow(/revision|conflict/i);
    let seen: unknown;
    expect(() =>
      store.liquidity.admitTransferProposal(
        {
          actorId,
          budgetId,
          plan: { ...plan('b'.repeat(64)), snapshotId: 'new-snapshot', claimSetRevision: '1' },
          expectedClaimSetRevision: '1',
          idempotencyKey: 'second',
          now,
        },
        (context) => {
          seen = context.claimSet;
          return { valid: false, reason: 'source_insufficient' };
        },
      ),
    ).toThrow(/source_insufficient/);
    expect(seen).toMatchObject({
      revision: '1',
      bundles: [{ creationSnapshotId: 'snapshot', effects: [{ resourceId: 'source' }] }],
    });
    expect(store.liquidity.getClaimSet({ actorId, budgetId, now }).revision).toBe('1');
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
        actorId,
        budgetId,
        proposalId: p.id,
        payloadHash: p.payloadHash,
        expectedVersion: 3,
        idempotencyKey: 'observe',
        now,
      };
      const first = store.liquidity.verifyTransferSettlement(input, () => observed);
      expect(first.state.phase).toBe('initiated');
      expect(store.liquidity.getClaimSet({ actorId, budgetId, now }).bundles[0]?.state).toBe(
        'initiated',
      );
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
      expect(store.liquidity.getClaimSet({ actorId, budgetId, now }).bundles).toEqual([]);
    },
  );
  it('replays transitions exactly and consumes evidence exclusively across proposals', async () => {
    const p = admit();
    await initiate(p.id);
    const input = {
      actorId,
      budgetId,
      proposalId: p.id,
      payloadHash: p.payloadHash,
      expectedVersion: 3,
      idempotencyKey: 'settle',
      now,
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
    const revision = store.liquidity.getClaimSet({ actorId, budgetId, now }).revision;
    const second = admit('b'.repeat(64), revision);
    store.liquidity.approveTransfer(
      {
        ...input,
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
    ).toThrow(/evidence|consumed/i);
  });
  it('retains initiated holds through expiry, cancellation and reconciliation-required outcomes', async () => {
    const p = admit();
    await initiate(p.id);
    const late = '2100-01-01T00:00:00.000Z';
    store.liquidity.expire({ actorId, budgetId, now: late });
    const current = store.liquidity.getTransferProposal({ actorId, budgetId, proposalId: p.id });
    expect(current.state).toMatchObject({ phase: 'initiated', outcome: 'expired' });
    expect(store.liquidity.getClaimSet({ actorId, budgetId, now: late }).bundles[0]?.state).toBe(
      'initiated',
    );
    store.liquidity.cancelTransfer({
      actorId,
      budgetId,
      proposalId: p.id,
      payloadHash: p.payloadHash,
      expectedVersion: current.version,
      idempotencyKey: 'cancel',
      now: late,
    });
    expect(store.liquidity.getClaimSet({ actorId, budgetId, now: late }).bundles[0]?.state).toBe(
      'initiated',
    );
  });
  it('edits sessions with CAS and invalidates linked approvals without erasing initiated claims', async () => {
    const session = store.liquidity.saveSpendSession(
      {
        actorId,
        budgetId,
        id: 'session',
        expectedVersion: 0,
        idempotencyKey: 'session-create',
        now,
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
      actorId,
      budgetId,
      id: session.id,
      expectedVersion: 1,
      idempotencyKey: 'session-edit',
      now,
      expiresAt,
      accountId: 'source',
      items: session.items,
    };
    store.liquidity.saveSpendSession(update, () => ({ valid: true }));
    expect(await store.findActiveApprovals(p.id)).toEqual([]);
    expect(
      store.liquidity.getTransferProposal({ actorId, budgetId, proposalId: p.id }).state.outcome,
    ).toBe('superseded');
    expect(() =>
      store.liquidity.saveSpendSession({ ...update, idempotencyKey: 'stale' }, () => ({
        valid: true,
      })),
    ).toThrow(/version|conflict/i);
    expect(store.liquidity.saveSpendSession(update, () => ({ valid: true })).version).toBe(2);
  });
});
