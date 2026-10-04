/** Persistence contracts that remain independent of generic proposal authorization. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrateProposalOrigins } from '../src/proposal-migration.js';
import { SqliteWorkflowStore } from '../src/store.js';
import type { AppendAuditInput, CreateIdempotencyInput } from '../src/types.js';

describe('workflow idempotency records', () => {
  let store: SqliteWorkflowStore;

  beforeEach(() => {
    store = new SqliteWorkflowStore(':memory:');
  });

  afterEach(() => store.close());

  it('creates a record and returns the existing owner on exact replay', async () => {
    const input: CreateIdempotencyInput = {
      idempotencyKey: 'execute:proposal-1',
      proposalId: 'proposal-1',
      operation: 'set_category',
      serialisedEffect: '{"categoryId":"food"}',
    };
    const first = await store.createIdempotencyRecord(input);
    const replay = await store.createIdempotencyRecord(input);

    expect(first.isOwner).toBe(true);
    expect(first.record).toMatchObject({
      idempotencyKey: input.idempotencyKey,
      proposalId: input.proposalId,
      operation: input.operation,
      completed: false,
      errorMessage: null,
    });
    expect(replay.isOwner).toBe(false);
    expect(replay.record.idempotencyKey).toBe(first.record.idempotencyKey);
    expect(replay.record.executedAt).toBe(first.record.executedAt);
  });

  it.each([
    { proposalId: 'proposal-2', operation: 'set_category' },
    { proposalId: 'proposal-1', operation: 'create_rule' },
  ])('rejects reuse of one key for changed execution identity: %j', async (change) => {
    const input: CreateIdempotencyInput = {
      idempotencyKey: 'execute:exact-identity',
      proposalId: 'proposal-1',
      operation: 'set_category',
      serialisedEffect: 'effect-a',
    };
    await store.createIdempotencyRecord(input);

    await expect(store.createIdempotencyRecord({ ...input, ...change }))
      .rejects.toThrow(/idempotency|replay/i);
  });

  it('serializes concurrent claims so only one caller owns the execution', async () => {
    const input: CreateIdempotencyInput = {
      idempotencyKey: 'execute:concurrent',
      proposalId: 'proposal-concurrent',
      operation: 'set_category',
      serialisedEffect: 'effect',
    };
    const claims = await Promise.all(
      Array.from({ length: 5 }, () => store.createIdempotencyRecord(input)),
    );

    expect(claims.filter((claim) => claim.isOwner)).toHaveLength(1);
    expect(claims.every((claim) => claim.record.idempotencyKey === input.idempotencyKey)).toBe(true);
  });

  it('retrieves records and completes both successful and failed writes', async () => {
    const success: CreateIdempotencyInput = {
      idempotencyKey: 'execute:success',
      proposalId: 'proposal-success',
      operation: 'set_category',
      serialisedEffect: 'success-effect',
    };
    await store.createIdempotencyRecord(success);
    expect(await store.getIdempotencyRecord(success.idempotencyKey))
      .toMatchObject({ idempotencyKey: success.idempotencyKey, completed: false });
    expect(await store.getIdempotencyRecord('execute:missing')).toBeNull();
    const verifiedResult = JSON.stringify({
      verified: true,
      transactionId: 'transaction-1',
      previousCategoryId: 'category-old',
      newCategoryId: 'category-new',
      planId: 'plan-1',
    });
    expect(await store.completeIdempotencyRecord(success.idempotencyKey, null, undefined, verifiedResult))
      .toMatchObject({
        completed: true,
        status: 'succeeded',
        errorMessage: null,
        serialisedResult: verifiedResult,
      });
    const repeated = await store.completeIdempotencyRecord(
      success.idempotencyKey,
      null,
      undefined,
      JSON.stringify({ verified: true, newCategoryId: 'different' }),
    );
    expect(repeated).toMatchObject({
      status: 'succeeded',
      serialisedResult: verifiedResult,
    });

    const failed: CreateIdempotencyInput = {
      ...success,
      idempotencyKey: 'execute:failed',
      proposalId: 'proposal-failed',
    };
    await store.createIdempotencyRecord(failed);
    expect(await store.completeIdempotencyRecord(
      failed.idempotencyKey,
      'write failed',
      false,
      verifiedResult,
    )).toMatchObject({
      completed: true,
      status: 'terminal_failed',
      errorMessage: 'write failed',
      serialisedResult: null,
    });
  });
});

describe('durable audit records', () => {
  let store: SqliteWorkflowStore;

  beforeEach(() => {
    store = new SqliteWorkflowStore(':memory:');
  });

  afterEach(() => store.close());

  function audit(overrides: Partial<AppendAuditInput> = {}): AppendAuditInput {
    return {
      classification: 'proposal_created',
      actorId: 'human-1',
      operation: 'set_category',
      budgetId: 'budget-1',
      backendIds: '[]',
      result: 'created',
      isError: false,
      ...overrides,
    };
  }

  it('preserves audit attribution and immutable event identity', async () => {
    const first = await store.appendAuditRecord(audit({
      classification: 'approval_granted',
      proposalId: 'proposal-1',
      payloadHash: 'a'.repeat(64),
      requestId: 'request-1',
      correlationId: 'correlation-1',
      result: 'granted',
    }));
    const second = await store.appendAuditRecord(audit({
      classification: 'execution_completed',
      proposalId: 'proposal-1',
      result: 'completed',
    }));

    expect(first).toMatchObject({
      classification: 'approval_granted',
      actorId: 'human-1',
      proposalId: 'proposal-1',
      payloadHash: 'a'.repeat(64),
      requestId: 'request-1',
      correlationId: 'correlation-1',
      isError: false,
    });
    expect(first.id).not.toBe(second.id);
  });

  it('queries audit records by classification and proposal', async () => {
    const unrelated = await store.appendAuditRecord(audit({
      classification: 'proposal_created',
      proposalId: 'proposal-other',
    }));
    const approval = await store.appendAuditRecord(audit({
      classification: 'approval_granted',
      actorId: 'approver-1',
      proposalId: 'proposal-1',
      result: 'granted',
    }));
    await store.appendAuditRecord(audit({
      classification: 'execution_completed',
      proposalId: 'proposal-1',
      result: 'completed',
    }));

    expect(await store.queryAuditRecords('approval_granted')).toEqual([approval]);
    expect(await store.queryAuditRecordsByProposal('proposal-1')).toHaveLength(2);
    expect(await store.queryAuditRecordsByProposal('proposal-other')).toEqual([unrelated]);
    expect(await store.queryAuditRecords('notification_created')).toEqual([]);
  });

  it('paginates ordered audit history without repeating the same record', async () => {
    for (let index = 0; index < 6; index++)
      await store.appendAuditRecord(audit({ result: `event-${index}` }));

    const firstPage = await store.queryAuditRecords(undefined, 3, 0);
    const secondPage = await store.queryAuditRecords(undefined, 3, 3);
    expect(firstPage).toHaveLength(3);
    expect(secondPage).toHaveLength(3);
    expect(secondPage.some(({ id }) => firstPage.some((first) => first.id === id))).toBe(false);
  });
});

describe('generic proposal provenance migration', () => {
  it('supersedes ambiguous legacy agent proposals while preserving human-origin proposals', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE action_proposals (
          id TEXT PRIMARY KEY,
          operation TEXT NOT NULL,
          space_id TEXT,
          requester_membership_id TEXT,
          governance_policy_version TEXT,
          actor_id TEXT NOT NULL,
          superseded_at TEXT
        );
        CREATE TABLE space_memberships (
          id TEXT PRIMARY KEY, space_id TEXT NOT NULL, actor_id TEXT NOT NULL
        );
        CREATE TABLE proposal_approvals (id TEXT PRIMARY KEY, status TEXT, superseded_at TEXT);
        CREATE TABLE idempotency_records (idempotency_key TEXT PRIMARY KEY);
        INSERT INTO space_memberships (id, space_id, actor_id) VALUES ('membership-human', 'space', 'human');
        INSERT INTO action_proposals
          (id, operation, space_id, requester_membership_id, governance_policy_version, actor_id)
        VALUES
          ('human-proposal', 'set_category', 'space', 'membership-human', 'policy', 'human'),
          ('legacy-agent-proposal', 'set_category', 'space', 'membership-human', 'policy', 'agent'),
          ('unlinked-agent-proposal', 'set_category', 'space', 'missing-membership', 'policy', 'agent-unlinked');
      `);

      migrateProposalOrigins(db);

      const proposals = db.prepare('SELECT id, superseded_at FROM action_proposals').all() as {
        id: string;
        superseded_at: string | null;
      }[];
      expect(proposals.find(({ id }) => id === 'human-proposal')?.superseded_at).toBeNull();
      expect(proposals.find(({ id }) => id === 'legacy-agent-proposal')?.superseded_at).not.toBeNull();
      expect(proposals.find(({ id }) => id === 'unlinked-agent-proposal')?.superseded_at).not.toBeNull();
      const columns = db.prepare('PRAGMA table_info(action_proposals)').all() as { name: string }[];
      expect(columns.map(({ name }) => name)).toEqual(expect.arrayContaining([
        'requester_delegation_id',
        'requester_delegation_version',
      ]));
    } finally {
      db.close();
    }
  });
});
