/** Persistence contracts that remain independent of generic proposal authorization. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fixture from '../../../protocol/fixtures/representative.json';
import { deriveProposalAuthorizationFacts, deriveProposalDisclosureTotals } from '../src/proposal.js';
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

describe('proposal disclosure Money manifest', () => {
  const money = (minorUnits: string, currency = 'USD') => ({ minorUnits, currency });
  const transaction = (id = 'tx_000', minorUnits = '-1500', currency = 'USD') => ({
    ...fixture.transactions[0]!, id, amount: money(minorUnits, currency), subtransactions: [],
  });
  const example = (id = 'tx_000', minorUnits = '-1500', currency = 'USD') => ({
    txId: id, payee: 'Whole Foods', amount: money(minorUnits, currency),
    currentCategory: 'cat_1', wouldChange: true,
  });
  const composite = () => ({
    operations: [], reallocations: [], transferRecommendations: [], ledgerProjections: [], evidenceReferences: [],
  });
  const payload = { kind: 'create_rule', composite: composite() };
  const totals = (preconditions: unknown, value: unknown = payload, projection: 'preconditions'|'envelope' = 'envelope') =>
    deriveProposalDisclosureTotals('create_rule', value, preconditions, projection);

  it('counts exact emitted canonical fixture slots, independently of projection', () => {
    const preconditions = {
      sourceAccounts: [fixture.accounts[0]],
      sourceTransactions: [transaction()],
      reviewedSimulation: { examples: [example()] },
      transaction: transaction(),
    };
    const value = { ...payload, composite: { ...composite(), operations: [{
      operation: 'create_rule', direction: 'outgoing', amount: money('1500'),
    }] } };
    expect(totals(preconditions, value, 'preconditions')).toEqual({
      operationCount: 5, grossOutgoing: { USD: 4500n },
    });
    expect(totals(preconditions, value)).toEqual({
      operationCount: 6, grossOutgoing: { USD: 6000n },
    });
  });

  it('counts split parents but charges outgoing only for leaves, including repeated full transactions', () => {
    const split = { ...transaction('parent', '-1500'), subtransactions: [
      transaction('leaf-a', '-1000'), transaction('leaf-b', '-500'),
    ] };
    expect(totals({ sourceTransactions: [split], transaction: split,
      reviewedSimulation: { examples: [example('leaf-a', '-1000'), example('leaf-a', '-1000')] } })).toEqual({
      operationCount: 8, grossOutgoing: { USD: 5000n },
    });
  });

  it('counts negative balances without inventing outgoing and never nets income across currencies', () => {
    expect(totals({
      sourceAccounts: [{ ...fixture.accounts[0], clearedBalance: money('-50'), importedBalance: money('-60') }],
      sourceTransactions: [transaction('usd', '-70'), transaction('income', '9000'), transaction('eur', '-30', 'EUR')],
      reviewedSimulation: { projectedBalance: money('-400') },
    })).toEqual({ operationCount: 6, grossOutgoing: { USD: 70n, EUR: 30n } });
  });

  it('charges positive absolute categorization amounts using their explicit direction', () => {
    const value = { kind: 'set_category', composite: { ...composite(), operations: [
      { operation: 'set_category', transactionId: 'tx', direction: 'outgoing', amount: money('70') },
      { operation: 'set_category', direction: 'incoming', amount: money('9000') },
    ], ledgerProjections: [{ transactionId: 'tx', amount: money('70') }] } };
    expect(deriveProposalDisclosureTotals('set_category', value, {
      transaction: { id: 'tx', direction: 'outgoing', amount: money('70') },
    }, 'envelope')).toEqual({ operationCount: 4, grossOutgoing: { USD: 210n } });
  });

  it('charges every emitted composite effect and evidence amount without deduplication', () => {
    const value = { ...payload, composite: {
      operations: [{ operation: 'create_rule', direction: 'outgoing', amount: money('10') }],
      reallocations: [{ sourceCategoryId: 'a', destinationCategoryId: 'b', amount: money('20') }],
      transferRecommendations: [{
        minimumAmount: money('5'),
        legs: [{ amount: money('30'), sourceBefore: { recordedBalance: money('-90'),
          signedHeadroom: money('-50'), backingCapacity: money('40') }, sourceAfter: money('-120') }],
        reservations: [{ kind: 'account_debit', amount: money('30') }],
        backingAfter: { lines: [{ amount: money('40') }] },
        scenario: { kind: 'reallocation', moves: [{ amount: money('15') }] },
      }],
      ledgerProjections: [{ direction: 'outgoing', amount: money('50') }],
      evidenceReferences: [{ kind: 'receipt', amount: money('60') }, { kind: 'receipt' }],
    } };
    expect(totals({}, value)).toEqual({ operationCount: 13, grossOutgoing: { USD: 215n } });
  });

  it('returns zero for null optional derived Money and empty financial populations', () => {
    expect(totals({ sourceAccounts: [], sourceTransactions: [],
      reviewedSimulation: { examples: [], projectedBalance: null } })).toEqual({
      operationCount: 0, grossOutgoing: {},
    });
    expect(totals({ sourceTransactions: [transaction('zero', '0')] })).toEqual({
      operationCount: 1, grossOutgoing: {},
    });
    expect(totals({}, { ...payload, composite: { ...composite(), operations: [{
      operation: 'create_rule', direction: 'outgoing', amount: money('0'),
    }] } })).toEqual({ operationCount: 1, grossOutgoing: { USD: 0n } });
  });

  it('accepts signed MIN for a balance but fails closed on its outgoing absolute value and aggregate overflow', () => {
    expect(totals({ sourceAccounts: [{ ...fixture.accounts[0],
      clearedBalance: money('-9223372036854775808'), importedBalance: money('0') }] }))
      .toEqual({ operationCount: 2, grossOutgoing: {} });
    expect(() => totals({ sourceTransactions: [transaction('min', '-9223372036854775808')] })).toThrow();
    expect(() => totals({ sourceTransactions: [
      transaction('max', '-9223372036854775807'), transaction('one', '-1'),
    ] })).toThrow();
    expect(totals({ sourceTransactions: [transaction('max', '-9223372036854775807')] }))
      .toEqual({ operationCount: 1, grossOutgoing: { USD: 9223372036854775807n } });
    expect(totals({ sourceTransactions: [
      transaction('usd-max', '-9223372036854775807'), transaction('eur-max', '-9223372036854775807', 'EUR'),
    ] })).toEqual({ operationCount: 2, grossOutgoing: {
      USD: 9223372036854775807n, EUR: 9223372036854775807n,
    } });
  });

  it.each([
    money('01'), money('-0'), money('+1'), money('9223372036854775808'),
    money('1', 'usd'), { minorUnits: 1, currency: 'USD' }, { minorUnits: '1' },
    { ...money('1'), extra: true }, null,
  ])('rejects malformed required Money: %j', (amount) => {
    expect(() => totals({ sourceTransactions: [{ ...transaction(), amount }] })).toThrow();
  });

  it.each([
    { sourceAccounts: null }, { sourceTransactions: {} },
    null, [], 'not-an-envelope',
    { sourceTransactions: [{ ...transaction(), subtransactions: null }] },
    { sourceAccounts: [{ ...fixture.accounts[0], importedBalance: undefined }] },
    { sourceTransactions: [transaction(), transaction()] },
    { reviewedSimulation: { examples: null } },
    { reviewedSimulation: { examples: [example('unknown')] } },
    { sourceTransactions: [transaction()], reviewedSimulation: { examples: [example('tx_000', '-1501')] } },
    { sourceTransactions: [transaction()], reviewedSimulation: { examples: [example('tx_000', '-1500', 'EUR')] } },
    { sourceTransactions: [transaction()], reviewedSimulation: { examples: [{ ...example(), amount: undefined }] } },
    { surprise: money('-1') }, { surprise: { amount: money('1') } },
    { sourceAccounts: [{ ...fixture.accounts[0], extraBalance: money('-1') }] },
    { sourceTransactions: [{ ...transaction(), extraAmount: money('-1') }] },
    { transaction: { amount: money('1'), direction: 'sideways' } },
  ])('fails closed on unknown or malformed financial roles: %j', (preconditions) => {
    expect(() => totals(preconditions)).toThrow();
  });

  it('does not read hidden payload Money for a preconditions-only projection', () => {
    expect(totals({}, { kind: 'create_rule', surprise: money('-1') }, 'preconditions'))
      .toEqual({ operationCount: 0, grossOutgoing: {} });
    expect(() => totals({}, { kind: 'create_rule', surprise: money('-1') })).toThrow();
  });

  it('fails closed on Money predicates not supported by the actual native rule representation', () => {
    expect(() => totals({ nativeImpact: { rules: [{ id: 'r', trigger: {
      type: 'amount_less_than', value: money('-50'),
    }, actions: [] }] } })).toThrow();
    expect(() => totals({ rule: { trigger: [{ field: 'amount', op: 'is', value: money('-50') }] } })).toThrow();
    expect(totals({ nativeImpact: { rules: [{ trigger: { type: 'amount_less_than', value: -50 }, actions: [] }] } }))
      .toEqual({ operationCount: 0, grossOutgoing: {} });
  });

  it.each([
    { ...payload, composite: { ...composite(), operations: [{ amount: money('1') }] } },
    { ...payload, composite: { ...composite(), reallocations: [{ amount: money('-1') }] } },
    { ...payload, composite: { ...composite(), operations: [{ operation: 'create_rule', direction: 'outgoing' }] } },
    { ...payload, composite: { ...composite(), operations: [{ operation: 'create_rule', direction: 'sideways', amount: money('1') }] } },
    { ...payload, composite: { ...composite(), operations: [{ operation: 'create_rule', direction: 'incoming', amount: money('-1') }] } },
    { ...payload, composite: { ...composite(), ledgerProjections: [{ amount: money('1') }] } },
    { ...payload, composite: { ...composite(), evidenceReferences: [{ kind: 'unknown', amount: money('1') }] } },
    { ...payload, composite: { ...composite(), evidenceReferences: [{ kind: 'receipt', amount: money('-1') }] } },
    { ...payload, composite: { ...composite(), transferRecommendations: [{ legs: null }] } },
  ])('rejects malformed executable financial roles: %j', (value) => {
    expect(() => totals({}, value)).toThrow();
  });

  it('supports flat root transaction Money in both disclosure projections without dropping other fields', () => {
    const preconditions = { transactionId: 'tx-root', accountId: 'account-root',
      direction: 'outgoing', amount: money('20'),
      presentation: { message: 'Reviewed flat root envelope' },
    };
    const value = { kind: 'set_category', transactionId: 'tx-root', categoryId: 'cat-target',
      composite: { ...composite(), operations: [{
        operation: 'set_category', transactionId: 'tx-root', accountId: 'account-root',
        categoryId: 'cat-target', direction: 'outgoing', amount: money('20'),
      }] },
    };
    const rootOnly = { transactionId: 'tx-root', accountId: 'account-root', direction: 'outgoing', amount: money('20') };
    expect(deriveProposalDisclosureTotals('set_category', value, rootOnly, 'preconditions'))
      .toEqual({ operationCount: 1, grossOutgoing: { USD: 20n } });
    expect(deriveProposalDisclosureTotals('set_category', value, rootOnly, 'envelope'))
      .toEqual({ operationCount: 2, grossOutgoing: { USD: 40n } });
    expect(deriveProposalDisclosureTotals('set_category', value, preconditions, 'preconditions'))
      .toEqual({ operationCount: 1, grossOutgoing: { USD: 20n } });
    expect(deriveProposalDisclosureTotals('set_category', value, preconditions, 'envelope'))
      .toEqual({ operationCount: 2, grossOutgoing: { USD: 40n } });
    expect(() => deriveProposalDisclosureTotals('set_category', value,
      { ...preconditions, surprise: money('-1') }, 'preconditions')).toThrow();
  });

  it.each([
    ['incoming', '20', {}],
    ['incoming', '9223372036854775807', {}],
    ['outgoing', '0', { USD: 0n }],
    ['outgoing', '9223372036854775807', { USD: 9223372036854775807n }],
  ] as const)('preserves normalized flat root %s amount %s', (direction, minorUnits, grossOutgoing) => {
    expect(deriveProposalDisclosureTotals('set_category', { kind: 'set_category' },
      { transactionId: 'tx-root', accountId: 'account-root', direction, amount: money(minorUnits) },
      'preconditions')).toEqual({ operationCount: 1, grossOutgoing });
  });

  it.each(['incoming', 'outgoing'] as const)('rejects signed MIN in normalized flat root %s Money', (direction) => {
    expect(() => deriveProposalDisclosureTotals('set_category', { kind: 'set_category' },
      { transactionId: 'tx-root', accountId: 'account-root', direction, amount: money('-9223372036854775808') },
      'preconditions')).toThrow();
  });

  it('rejects nonselected flat root Money when authorization-selected nested transaction facts win', () => {
    const preconditions = {
      transactionId: 'tx-root', accountId: 'account-root', direction: 'outgoing', amount: money('20'),
      transaction: { id: 'tx-selected', accountId: 'account-selected', direction: 'incoming', amount: money('30') },
      actualTransaction: { id: 'tx-actual', accountId: 'account-actual', direction: 'outgoing', amount: money('40') },
      transactionFacts: { id: 'tx-facts', accountId: 'account-facts', direction: 'outgoing', amount: money('50') },
    };
    const value = { kind: 'set_category', transactionId: 'tx-selected', categoryId: 'cat-target',
      composite: { ...composite(), ledgerProjections: [{
        transactionId: 'tx-selected', accountId: 'account-selected', categoryId: 'cat-target', amount: money('30'),
      }] },
    };
    expect(deriveProposalAuthorizationFacts('set_category', value, preconditions).operations)
      .toMatchObject([
        { operation: 'set_category', direction: 'incoming', amount: money('30') },
        { operation: 'ledger_projection', direction: 'incoming', amount: money('30') },
      ]);
    expect(() => deriveProposalDisclosureTotals('set_category', value, preconditions, 'preconditions'))
      .toThrow('Unknown proposal disclosure financial amount role');
    expect(() => deriveProposalDisclosureTotals('set_category', value, preconditions, 'envelope'))
      .toThrow('Unknown proposal disclosure financial amount role');
  });

  it.each([
    ['transaction', {
      transaction: { id: 'tx-selected', accountId: 'account-selected', direction: 'incoming', amount: money('30') },
      actualTransaction: { id: 'tx-selected', accountId: 'account-selected', direction: 'incoming', amount: money('30') },
      transactionFacts: { id: 'tx-selected', accountId: 'account-selected', direction: 'incoming', amount: money('30') },
    }, 3],
    ['actualTransaction', {
      actualTransaction: { id: 'tx-selected', accountId: 'account-selected', direction: 'incoming', amount: money('30') },
      transactionFacts: { id: 'tx-selected', accountId: 'account-selected', direction: 'incoming', amount: money('30') },
    }, 2],
    ['transactionFacts', {
      transactionFacts: { id: 'tx-selected', accountId: 'account-selected', direction: 'incoming', amount: money('30') },
    }, 1],
  ] as const)('uses authorization-selected nested fallback %s before nonfinancial flat root metadata', (_field, nested, count) => {
    const preconditions = { transactionId: 'tx-root', accountId: 'account-root',
      direction: 'outgoing', presentation: { message: 'Root metadata, no root Money' }, ...nested,
    };
    const value = { kind: 'set_category', transactionId: 'tx-selected', categoryId: 'cat-target',
      composite: { ...composite(), ledgerProjections: [{
        transactionId: 'tx-selected', accountId: 'account-selected', categoryId: 'cat-target', amount: money('30'),
      }] },
    };
    expect(deriveProposalAuthorizationFacts('set_category', value, preconditions).operations[0])
      .toMatchObject({ direction: 'incoming', amount: money('30') });
    expect(deriveProposalDisclosureTotals('set_category', value, preconditions, 'preconditions'))
      .toEqual({ operationCount: count, grossOutgoing: {} });
    expect(deriveProposalDisclosureTotals('set_category', value, preconditions, 'envelope'))
      .toEqual({ operationCount: count + 1, grossOutgoing: {} });
  });
});
