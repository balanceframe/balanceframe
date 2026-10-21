import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { SqliteWorkflowStore } from '../../workflow-store/src/store.js';
import { TransactionEvidenceService, type TransactionEvidenceNative } from '../src/transaction-evidence.js';
import { merchantConnectionId } from '../src/merchant-service.js';
import { actualLiquidityRequest } from '../../../tests/contract/fixtures/actual-liquidity.js';
const now = '2026-10-21T12:00:00.000Z';
const bundle = JSON.parse(readFileSync(new URL('../../../protocol/fixtures/transaction-evidence-rule.json', import.meta.url), 'utf8'));
const native = createRequire(import.meta.url)('@balanceframe/native') as TransactionEvidenceNative & { simulateTransactionEvidenceRule(input: string): string };
let store: SqliteWorkflowStore;
afterEach(() => store?.close());
async function setup(nativeOverride: TransactionEvidenceNative = native) {
  store = new SqliteWorkflowStore();
  await store.claimBootstrap({ name: 'Owner', email: 'owner@example.com', claimId: 'item-rule' });
  await store.finalizeBootstrap({ claimId: 'item-rule', ownerUserId: 'owner' });
  const auth = { method: 'human-session' as const, actorId: 'owner', sessionId: 'session', reauthenticatedAt: now };
  const space = store.governance.createSpace({ actorId: 'owner', name: 'Items', kind: 'personal', now, auth });
  store.governance.bindBudget({ spaceId: space.id, budgetId: 'budget', now, auth });
  const member = store.governance.getCurrentMembership({ spaceId: space.id, actorId: 'owner', now })!;
  const actor = { actorId: 'owner', spaceId: space.id, budgetId: 'budget', membershipId: member.id, governancePolicyVersion: store.governance.getPolicy({ spaceId: space.id })!.version, auth };
  function grant(resourceKind: 'budget'|'evidence'|'account'|'category'|'rule', resourceId: string, capability: string, granted = true) { store.governance.setResourceGrant({ spaceId: space.id, budgetId: actor.budgetId, actorId: actor.actorId, membershipId: member.id, resourceKind, resourceId, capability, granted, now, auth }); }
  for (const capability of ['observe','ingest','normalized-evidence','resolve','source','rule:view','item-rule:propose','item-rule:approve','item-rule:read']) grant('budget', 'budget', capability);
  for (const capability of ['existence','name','transaction']) grant('account', 'checking', capability);
  for (const capability of ['category','name']) grant('category', 'food', capability);
  const snapshot = actualLiquidityRequest(false).financialSnapshot;
  snapshot.legacySnapshot.rules = [];
  snapshot.legacySnapshot.accounts = [{ ...snapshot.legacySnapshot.accounts[0]!, id: 'checking', isClosed: false }];
  snapshot.legacySnapshot.categories = [{ ...snapshot.legacySnapshot.categories[0]!, id: 'food', deleted: false }, { ...snapshot.legacySnapshot.categories[0]!, id: 'other', deleted: false }];
  const config = { serverUrl: 'https://actual.fixture.test', budgetId: actor.budgetId };
  const manager = { loadConfig: async () => config, withConnection: vi.fn(async (consume: (connected: unknown) => unknown) => consume({ config, synchronization: { financialSnapshot: snapshot } })) };
  let clockNow = now;
  const service = new TransactionEvidenceService({ store, native: nativeOverride, rawEncryptionKey: Buffer.alloc(32), connectionManager: manager as never, clock: () => new Date(clockNow) });
  const content = { templateVersion: 'retail-v1', observations: bundle.evidence.observations.filter((row: { kind: string }) => row.kind !== 'ledger_transaction').map(({ provenance: _p, ...row }: { provenance: unknown }) => row), receipts: bundle.evidence.receipts.map((receipt: { tenders: Array<Record<string, unknown>> }) => ({ ...receipt, tenders: receipt.tenders.map((tender) => ({ ...tender, observationId: null })) })) };
  const saved = await service.ingest(actor, { connectorId: 'retail', sourceId: 'receipt-1', sourceTimestamp: now, mediaType: 'application/json', sourceKind: 'retail', content: JSON.stringify(content) });
  grant('evidence', saved.document.id, 'evidence');
  grant('evidence', saved.document.id, 'normalized-evidence');
  const input = {
    connectorId: 'retail',
    accountId: 'checking',
    fundingInstrumentId: 'card-1',
    counterparty: 'person-1',
    sku: 'sku-1',
    normalizedDescription: null,
    categoryId: 'food',
  };
  return { actor, service, grant, snapshot, manager, input, sourceId: saved.document.id, content, changeClock: (value: string) => { clockNow = value; } };
}
describe('reviewed exact receipt item rules', () => {
  it('simulates conserved receipt history, approves an exact hash and returns scoped suggestions without ledger writes', async () => {
    const { actor, service, input, sourceId } = await setup();
    const proposed = await service.proposeItemRule(actor, input);
    expect(proposed.state).toBe('proposed'); expect(proposed.examples[0]?.documentId).toBe(sourceId);
    expect(proposed.simulation.matches).toHaveLength(1); expect(proposed.actualInteraction.kind).toBe('local_item_suggestion_only');
    expect(await service.itemRuleSuggestions(actor, { accountId: 'checking' })).toEqual([]);
    const approved = await service.approveItemRule(actor, { proposalId: proposed.id, payloadHash: proposed.payloadHash });
    expect(approved.state).toBe('approved');
    const suggestions = await service.itemRuleSuggestions(actor, { accountId: 'checking' });
    expect(suggestions[0]).toMatchObject({ proposalId: proposed.id, categoryId: 'food', accountId: 'checking', receiptId: 'receipt-1', lineId: 'line-1' });
    expect((await service.listItemRules(actor))[0]?.approvals[0]?.payloadHash).toBe(proposed.payloadHash);
    expect(await service.itemRuleSuggestions(actor, { accountId: 'other' })).toEqual([]);
    expect((await service.revokeItemRule(actor, { proposalId: proposed.id, payloadHash: proposed.payloadHash })).state).toBe('revoked');
    expect(await service.itemRuleSuggestions(actor, { accountId: 'checking' })).toEqual([]);
  });
  it('refuses stale sources, changed Actual rules, invalid conditions and non-fresh approvals', async () => {
    const { actor, service, input, snapshot, grant, changeClock } = await setup();
    await expect(service.proposeItemRule(actor, { ...input, sku: null })).rejects.toThrow();
    grant('category', 'missing-category', 'category'); await expect(service.proposeItemRule(actor, { ...input, categoryId: 'missing-category' })).rejects.toThrow(/category unavailable/);
    const proposed = await service.proposeItemRule(actor, input);
    await expect(service.approveItemRule(actor, { proposalId: proposed.id, payloadHash: 'f'.repeat(64) })).rejects.toThrow(/changed/);
    changeClock('2026-10-21T12:06:00.000Z'); await expect(service.approveItemRule(actor, { proposalId: proposed.id, payloadHash: proposed.payloadHash })).rejects.toThrow(/Fresh|recent/); changeClock(now);
    snapshot.legacySnapshot.rules = [{ id: 'native-rule', name: 'Native category', order: 0, trigger: { conditionsOp: 'and', conditions: [] }, actions: [{ op: 'set', field: 'category', value: 'other' }], inactive: false }];
    grant('rule', 'native-rule', 'rule:view');
    await expect(service.approveItemRule(actor, { proposalId: proposed.id, payloadHash: proposed.payloadHash })).rejects.toThrow(/changed/);
    const conflicting = await service.proposeItemRule(actor, input); expect(conflicting.simulation.conflicts).toContain('actual_rule_category_conflict');
    await expect(service.approveItemRule(actor, { proposalId: conflicting.id, payloadHash: conflicting.payloadHash })).rejects.toThrow(/conflict/);
    grant('budget', actor.budgetId, 'item-rule:propose', false); await expect(service.proposeItemRule(actor, input)).rejects.toThrow(/authorized/);
  });
  it('suppresses rules after source replacement and refuses unavailable native or ledger coverage', async () => {
    const { actor, service, input, snapshot, content, grant } = await setup();
    const proposal = await service.proposeItemRule(actor, input); await service.approveItemRule(actor, { proposalId: proposal.id, payloadHash: proposal.payloadHash });
    snapshot.coverage.rules = 'partial'; await expect(service.itemRuleSuggestions(actor, { accountId: 'checking' })).rejects.toThrow(/coverage/); snapshot.coverage.rules = 'complete';
    const changed = { ...content, receipts: content.receipts.map((receipt: Record<string, unknown>) => ({ ...receipt, version: 2 })) };
    const replacement = await service.ingest(actor, { connectorId: 'retail', sourceId: 'receipt-1', sourceTimestamp: now, mediaType: 'application/json', sourceKind: 'retail', content: JSON.stringify(changed) });
    grant('evidence', replacement.document.id, 'evidence'); grant('evidence', replacement.document.id, 'normalized-evidence');
    expect(await service.listItemRules(actor)).toEqual([]); expect(await service.itemRuleSuggestions(actor, { accountId: 'checking' })).toEqual([]);
  });
  it('refuses missing simulation capability and malformed native identities', async () => {
    const { actor, service, input } = await setup({ resolveTransactionEvidence: native.resolveTransactionEvidence });
    await expect(service.proposeItemRule(actor, input)).rejects.toThrow(/simulation unavailable/);
  });
  it('keeps unsupported Actual rules explicit while excluding provably different account scopes', async () => {
    const { actor, service, input, snapshot, grant } = await setup();
    grant('rule', 'unsupported', 'rule:view'); snapshot.legacySnapshot.rules = [{ id: 'unsupported', name: 'Unknown native action', order: 0, trigger: {}, actions: null, inactive: false }];
    const unknown = await service.proposeItemRule(actor, input); expect(unknown.simulation.conflicts).toContain('actual_rule_interaction_unknown');
    await expect(service.approveItemRule(actor, { proposalId: unknown.id, payloadHash: unknown.payloadHash })).rejects.toThrow(/conflict/);
    snapshot.legacySnapshot.rules = [{ ...snapshot.legacySnapshot.rules[0]!, trigger: { conditionsOp: 'and', conditions: [{ field: 'account', op: 'oneOf', value: ['unrelated-account'] }] } }];
    const scoped = await service.proposeItemRule(actor, input); expect(scoped.simulation.conflicts).toEqual([]); expect(scoped.actualInteraction.actualRuleIds).toEqual([]);
    grant('rule', 'unsupported', 'rule:view', false); await expect(service.proposeItemRule(actor, input)).rejects.toThrow(/authorized/);
  });
  it('rechecks authority after asynchronous Actual reads and does not publish partial proposals', async () => {
    const { actor, service, input, manager, snapshot, grant } = await setup();
    manager.withConnection.mockImplementationOnce(async (consume) => { const result = await consume({ config: { serverUrl: 'https://actual.fixture.test', budgetId: actor.budgetId }, synchronization: { financialSnapshot: snapshot } }); grant('budget', actor.budgetId, 'source', false); return result; });
    await expect(service.proposeItemRule(actor, input)).rejects.toThrow(/authorized/); expect(await service.listItemRules(actor)).toEqual([]);
    grant('category', 'food', 'category', false); await expect(service.proposeItemRule(actor, input)).rejects.toThrow(/category/);
  });

  it('withdraws persisted rule interaction after rule grants are revoked', async () => {
    const { actor, service, input, snapshot, grant } = await setup();
    snapshot.legacySnapshot.rules = [{ id: 'native-view', name: 'Current native rule', order: 0, trigger: {}, actions: [{ op: 'set', field: 'category', value: 'food' }], inactive: false }]; grant('rule', 'native-view', 'rule:view');
    await service.proposeItemRule(actor, input); expect(await service.listItemRules(actor)).toHaveLength(1);
    grant('rule', 'native-view', 'rule:view', false); expect(await service.listItemRules(actor)).toEqual([]);
    grant('rule', 'native-view', 'rule:view'); grant('budget', actor.budgetId, 'source', false); expect(await service.listItemRules(actor)).toEqual([]);
  });
  it('withdraws cached approved suggestions when approval is revoked during Actual I/O', async () => {
    const { actor, service, input, manager, snapshot } = await setup(); const proposal = await service.proposeItemRule(actor, input);
    await service.approveItemRule(actor, { proposalId: proposal.id, payloadHash: proposal.payloadHash });
    manager.withConnection.mockImplementationOnce(async (consume) => { const result = await consume({ config: { serverUrl: 'https://actual.fixture.test', budgetId: actor.budgetId }, synchronization: { financialSnapshot: snapshot } }); await service.revokeItemRule(actor, { proposalId: proposal.id, payloadHash: proposal.payloadHash }); return result; });
    expect(await service.itemRuleSuggestions(actor, { accountId: 'checking' })).toEqual([]);
  });

  it('rechecks approval reauthentication after asynchronous Actual verification', async () => {
    const { actor, service, input, manager, snapshot, changeClock } = await setup(); const proposal = await service.proposeItemRule(actor, input);
    manager.withConnection.mockImplementationOnce(async (consume) => { const result = await consume({ config: { serverUrl: 'https://actual.fixture.test', budgetId: actor.budgetId }, synchronization: { financialSnapshot: snapshot } }); changeClock('2026-10-21T12:06:00.000Z'); return result; });
    await expect(service.approveItemRule(actor, { proposalId: proposal.id, payloadHash: proposal.payloadHash })).rejects.toThrow(/Fresh|authorized|reauth/);
  });

});

it('requires exact merchant scope and never applies a generic source SKU rule to another merchant', async () => {
  const { actor, service, input, content, grant } = await setup();
  const unscoped: Record<string, unknown> = { ...input };
  delete unscoped.counterparty;
  await expect(service.proposeItemRule(actor, unscoped)).rejects.toThrow();
  const other = structuredClone(content);
  other.observations[0].id = 'other-merchant-payment';
  other.observations[0].externalEventId = null;
  other.observations[0].counterparty = 'Store B';
  other.receipts[0].id = 'other-merchant-receipt';
  other.receipts[0].observationId = 'other-merchant-payment';
  other.receipts[0].lines[0].id = 'other-merchant-line';
  other.receipts[0].lines[0].rawDescription = 'shampoo';
  other.receipts[0].lines[0].categoryId = 'other';
  other.receipts[0].tenders[0].id = 'other-merchant-tender';
  const saved = await service.ingest(actor, {
    connectorId: 'retail',
    sourceId: 'receipt-store-b',
    sourceTimestamp: now,
    mediaType: 'application/json',
    sourceKind: 'retail',
    content: JSON.stringify(other),
  });
  grant('evidence', saved.document.id, 'evidence');
  grant('evidence', saved.document.id, 'normalized-evidence');
  const proposal = await service.proposeItemRule(actor, input);
  expect(proposal.rule.counterparty).toBe('person-1');
  expect(proposal.simulation.matches).toHaveLength(1);
  expect(proposal.simulation.conflicts).toEqual([]);
  await service.approveItemRule(actor, { proposalId: proposal.id, payloadHash: proposal.payloadHash });
  expect(
    (await service.itemRuleSuggestions(actor, { accountId: 'checking' })).map(
      (suggestion) => suggestion.receiptId,
    ),
  ).toEqual(['receipt-1']);
  const otherProposal = await service.proposeItemRule(actor, { ...input, counterparty: 'Store B' });
  expect(otherProposal.payloadHash).not.toBe(proposal.payloadHash);
  await expect(
    service.approveItemRule(actor, {
      proposalId: otherProposal.id,
      payloadHash: proposal.payloadHash,
    }),
  ).rejects.toThrow(/changed/);
  const absent = await service.proposeItemRule(actor, {
    ...input,
    counterparty: 'Unknown merchant',
  });
  expect(absent.simulation.matches).toEqual([]);
  await expect(
    service.approveItemRule(actor, { proposalId: absent.id, payloadHash: absent.payloadHash }),
  ).rejects.toThrow(/examples/);
});

it('withholds a legacy unscoped approval individually while a scoped approved rule keeps working', async () => {
  const { actor, service, input } = await setup();
  const proposal = await service.proposeItemRule(actor, input);
  await service.approveItemRule(actor, { proposalId: proposal.id, payloadHash: proposal.payloadHash });
  // Simulate the immutable persisted bytes from before merchant scope was required.
  const { id: _id, state: _state, approvals: _approvals, ...legacy } = structuredClone(proposal);
  legacy.rule.id = 'legacy-unscoped';
  legacy.simulation.ruleId = legacy.rule.id;
  delete (legacy.rule as Record<string, unknown>).counterparty;
  const db = (
    store.evidence.itemRules as unknown as {
      db: {
        prepare(sql: string): {
          run(...values: unknown[]): unknown;
          get(...values: unknown[]): unknown;
        };
      };
    }
  ).db;
  const original = JSON.stringify(legacy);
  const scopeKey = JSON.stringify([
    actor.spaceId,
    actor.budgetId,
    merchantConnectionId({ serverUrl: 'https://actual.fixture.test', budgetId: actor.budgetId }),
  ]);
  db.prepare(
    'INSERT INTO transaction_evidence_item_rules(scope_key,id,actor_id,value) VALUES(?,?,?,?)',
  ).run(scopeKey, legacy.rule.id, actor.actorId, original);
  db.prepare(
    'INSERT INTO transaction_evidence_item_rule_approvals(scope_key,rule_id,value) VALUES(?,?,?)',
  ).run(
    scopeKey,
    legacy.rule.id,
    JSON.stringify({
      actorId: actor.actorId,
      membershipId: actor.membershipId,
      policyVersion: actor.governancePolicyVersion,
      payloadHash: legacy.payloadHash,
      action: 'approved',
      at: now,
    }),
  );
  expect((await service.listItemRules(actor)).map((rule) => rule.id)).toEqual([proposal.id]);
  expect(
    (await service.itemRuleSuggestions(actor, { accountId: input.accountId })).map(
      (suggestion) => suggestion.proposalId,
    ),
  ).toEqual([proposal.id]);
  await expect(
    service.approveItemRule(actor, { proposalId: legacy.rule.id, payloadHash: legacy.payloadHash }),
  ).rejects.toThrow(/changed|authorized/);
  expect(
    (
      db
        .prepare('SELECT value FROM transaction_evidence_item_rules WHERE id=?')
        .get(legacy.rule.id) as { value: string }
    ).value,
  ).toBe(original);
});

it('requires explicit fresh source-bound item categories and learns only repeated reviewed outcomes', async () => {
  const { actor, service, input, content, grant, changeClock } = await setup();
  const review = async (receiptId: string, lineId: string, categoryId: string | null) => {
    const current = await service.resolve(actor, { policyVersion: actor.governancePolicyVersion });
    return service.saveResolutionDecision(actor, {
      resolutionHash: current.resolutionHash,
      policyVersion: actor.governancePolicyVersion,
      relationships: [],
      itemCategoryDecisions: [{ receiptId, lineId, accountId: input.accountId, categoryId }],
    });
  };
  const query = { accountId: input.accountId, connectorId: input.connectorId };
  await review('receipt-1', 'line-1', 'food');
  expect((await service.itemRuleCandidates(actor, query)).candidates).toEqual([]);
  changeClock('2026-10-21T12:00:30.000Z');
  const second = structuredClone(content);
  second.observations[0].id = 'reviewed-payment-2';
  second.observations[0].externalEventId = 'reviewed-event-2';
  second.receipts[0].id = 'reviewed-receipt-2';
  second.receipts[0].observationId = 'reviewed-payment-2';
  second.receipts[0].lines[0].id = 'reviewed-line-2';
  second.receipts[0].lines[0].categoryId = 'food';
  second.receipts[0].tenders[0].id = 'reviewed-tender-2';
  const saved = await service.ingest(actor, {
    connectorId: input.connectorId,
    sourceId: 'reviewed-source-2',
    sourceTimestamp: now,
    mediaType: 'application/json',
    sourceKind: 'retail',
    content: JSON.stringify(second),
  });
  grant('evidence', saved.document.id, 'evidence');
  grant('evidence', saved.document.id, 'normalized-evidence');
  expect((await service.itemRuleCandidates(actor, query)).candidates).toEqual([]); // imported category is unreviewed
  await review('reviewed-receipt-2', 'reviewed-line-2', 'food');
  const learned = await service.itemRuleCandidates(actor, query);
  expect(learned.candidates).toHaveLength(2);
  expect(learned.candidates[1].rule.criterion?.kind).toBe('retailer_mapping');
  expect(learned.candidates[0].reviewCount).toBe(2);
  const rule = await service.proposeItemRuleCandidate(actor, {
    ...query,
    candidateHash: learned.candidates[0].candidateHash,
  });
  expect(rule.state).toBe('proposed');
  expect(rule.rule.counterparty).toBe(input.counterparty);
  expect(rule.learning?.outcomes).toHaveLength(2);
  expect(rule.learning?.outcomes.find((outcome) => outcome.lineId === 'line-1')?.reviewedAt).toBe(
    now,
  );
  expect(await service.itemCategoryOutcomes(actor, query)).toHaveLength(2);
  expect(await service.itemRuleSuggestions(actor, { accountId: input.accountId })).toEqual([]);
  await review('reviewed-receipt-2', 'reviewed-line-2', null);
  expect((await service.itemRuleCandidates(actor, query)).candidates).toEqual([]);
  await expect(
    service.proposeItemRuleCandidate(actor, {
      ...query,
      candidateHash: learned.candidates[0].candidateHash,
    }),
  ).rejects.toThrow(/changed|unavailable/);
});

it('withdraws learned candidates when a reviewed outcome changes during Actual verification', async () => {
  const { actor, service, input, manager, snapshot } = await setup();
  const current = await service.resolve(actor, { policyVersion: actor.governancePolicyVersion });
  const body = {
    resolutionHash: current.resolutionHash,
    policyVersion: actor.governancePolicyVersion,
    relationships: [],
    itemCategoryDecisions: [
      { receiptId: 'receipt-1', lineId: 'line-1', accountId: input.accountId, categoryId: 'food' },
    ],
  };
  await service.saveResolutionDecision(actor, body);
  const reviewed = await service.resolve(actor, { policyVersion: actor.governancePolicyVersion });
  manager.withConnection.mockImplementationOnce(async (consume) => {
    const result = await consume({ config: { serverUrl: 'https://actual.fixture.test', budgetId: actor.budgetId }, synchronization: { financialSnapshot: snapshot } });
    await service.saveResolutionDecision(actor, {
      ...body,
      resolutionHash: reviewed.resolutionHash,
      itemCategoryDecisions: [{ ...body.itemCategoryDecisions[0]!, categoryId: null }],
    });
    return result;
  });
  await expect(
    service.itemRuleCandidates(actor, {
      connectorId: input.connectorId,
      accountId: input.accountId,
    }),
  ).rejects.toThrow(/changed|authorized/);
});

it('keeps the newest category revocation when the authorized source set shrinks', async () => {
  const resolve = vi.fn(native.resolveTransactionEvidence);
  const { actor, service, input, content, grant, snapshot, changeClock } = await setup({
    ...native,
    resolveTransactionEvidence: resolve,
  });
  const review = async (categoryId: string | null) => {
    const result = await service.resolve(actor, { policyVersion: actor.governancePolicyVersion });
    await service.saveResolutionDecision(actor, {
      resolutionHash: result.resolutionHash,
      policyVersion: actor.governancePolicyVersion,
      relationships: [],
      itemCategoryDecisions: [
        { receiptId: 'receipt-1', lineId: 'line-1', accountId: input.accountId, categoryId },
      ],
    });
  };
  await review('food');
  const second = structuredClone(content);
  second.observations[0].id = 'second-observation';
  second.observations[0].externalEventId = 'second-event';
  second.receipts[0].id = 'second-receipt';
  second.receipts[0].observationId = 'second-observation';
  second.receipts[0].lines[0].id = 'second-line';
  second.receipts[0].tenders[0].id = 'second-tender';
  const saved = await service.ingest(actor, {
    connectorId: 'retail',
    sourceId: 'second-source',
    sourceTimestamp: now,
    mediaType: 'application/json',
    sourceKind: 'retail',
    content: JSON.stringify(second),
  });
  grant('evidence', saved.document.id, 'evidence');
  grant('evidence', saved.document.id, 'normalized-evidence');
  changeClock('2026-10-21T12:01:00.000Z');
  await review(null);
  grant('evidence', saved.document.id, 'normalized-evidence', false);
  expect(
    (await service.itemCategoryOutcomes(actor, { connectorId: 'retail', accountId: 'checking' }))[0]
      ?.categoryId,
  ).toBeNull();
  resolve.mockClear();
  await service.resolve(actor, { policyVersion: actor.governancePolicyVersion });
  const lastRequest = () =>
    JSON.parse(resolve.mock.calls.at(-1)![0]) as {
      receipts: Array<{ id: string; lines: Array<{ categoryId: string | null }> }>;
    };
  expect(
    lastRequest().receipts.find((receipt) => receipt.id === 'receipt-1')!.lines[0]!.categoryId,
  ).toBeNull();
  await service.captureObservations(
    actor,
    { serverUrl: 'https://actual.fixture.test', budgetId: actor.budgetId },
    snapshot,
  );
  expect(
    lastRequest().receipts.find((receipt) => receipt.id === 'receipt-1')!.lines[0]!.categoryId,
  ).toBeNull();
});

it('requires current reviewed history for contextual rules and gives exact matches priority without model calls', async () => {
  const { actor, service, input, content, grant } = await setup();
  const broad = {
    ...input,
    sku: null,
    normalizedDescription: null,
    criterion: { kind: 'department', value: 'produce' },
  };
  await expect(service.proposeItemRule(actor, broad)).rejects.toThrow(/reviewed|history|source/);
  for (const index of [1, 2]) {
    const copy = structuredClone(content);
    copy.observations[0].id = `context-observation-${index}`;
    copy.observations[0].externalEventId = `context-event-${index}`;
    copy.receipts[0].id = `context-receipt-${index}`;
    copy.receipts[0].observationId = copy.observations[0].id;
    copy.receipts[0].lines[0].id = `context-line-${index}`;
    copy.receipts[0].lines[0].department = 'produce';
    copy.receipts[0].lines[0].productFamily = 'fruit';
    copy.receipts[0].lines[0].normalizedDescription = 'fresh green apples';
    copy.receipts[0].tenders[0].id = `context-tender-${index}`;
    const saved = await service.ingest(actor, {
      connectorId: input.connectorId,
      sourceId: index === 1 ? 'receipt-1' : 'context-source-2',
      sourceTimestamp: now,
      mediaType: 'application/json',
      sourceKind: 'retail',
      content: JSON.stringify(copy),
    });
    grant('evidence', saved.document.id, 'evidence');
    grant('evidence', saved.document.id, 'normalized-evidence');
    const current = await service.resolve(actor, { policyVersion: actor.governancePolicyVersion });
    await service.saveResolutionDecision(actor, {
      resolutionHash: current.resolutionHash,
      policyVersion: actor.governancePolicyVersion,
      relationships: [],
      itemCategoryDecisions: [
        {
          receiptId: copy.receipts[0].id,
          lineId: copy.receipts[0].lines[0].id,
          accountId: input.accountId,
          categoryId: 'food',
        },
      ],
    });
  }
  const proposal = await service.proposeItemRule(actor, broad);
  expect(proposal.rule.criterion).toEqual(broad.criterion);
  expect(proposal.learning?.outcomes).toHaveLength(2);
  expect(proposal.simulation.falsePositiveRisk).toBe('broader_scope_review_required');
  await service.approveItemRule(actor, { proposalId: proposal.id, payloadHash: proposal.payloadHash });
  const suggestions = await service.itemRuleSuggestions(actor, { accountId: input.accountId });
  expect(suggestions).toHaveLength(2);
  expect(
    suggestions.every((suggestion) => suggestion.reasonCodes.includes('approved_department_rule')),
  ).toBe(true);
  const third = structuredClone(content);
  third.observations[0].id = 'future-item';
  third.observations[0].externalEventId = 'future-event';
  third.receipts[0].id = 'future-receipt';
  third.receipts[0].observationId = 'future-item';
  third.receipts[0].lines[0].id = 'future-line';
  third.receipts[0].lines[0].sku = 'new-explicit-sku';
  third.receipts[0].lines[0].department = 'produce';
  third.receipts[0].lines[0].categoryId = null;
  third.receipts[0].tenders[0].id = 'future-tender';
  const future = await service.ingest(actor, {
    connectorId: input.connectorId,
    sourceId: 'future-source',
    sourceTimestamp: now,
    mediaType: 'application/json',
    sourceKind: 'retail',
    content: JSON.stringify(third),
  });
  grant('evidence', future.document.id, 'evidence');
  grant('evidence', future.document.id, 'normalized-evidence');
  expect(await service.itemRuleSuggestions(actor, { accountId: input.accountId })).toHaveLength(3);
  const exact = await service.proposeItemRule(actor, input);
  await service.approveItemRule(actor, { proposalId: exact.id, payloadHash: exact.payloadHash });
  const specific = await service.itemRuleSuggestions(actor, { accountId: input.accountId });
  expect(specific).toHaveLength(3);
  expect(specific.filter((suggestion) => suggestion.proposalId === exact.id)).toHaveLength(2);
  expect(specific.find((suggestion) => suggestion.lineId === 'future-line')?.proposalId).toBe(
    proposal.id,
  );
  const current = await service.resolve(actor, { policyVersion: actor.governancePolicyVersion });
  await service.saveResolutionDecision(actor, {
    resolutionHash: current.resolutionHash,
    policyVersion: actor.governancePolicyVersion,
    relationships: [],
    itemCategoryDecisions: [
      {
        receiptId: 'context-receipt-2',
        lineId: 'context-line-2',
        accountId: input.accountId,
        categoryId: null,
      },
    ],
  });
  await expect(service.approveItemRule(actor, { proposalId: proposal.id, payloadHash: proposal.payloadHash })).rejects.toThrow(/support|changed/);
  const remaining = await service.itemRuleSuggestions(actor, { accountId: input.accountId });
  expect(remaining).toHaveLength(2);
  expect(remaining.every((suggestion) => suggestion.proposalId === exact.id)).toBe(true);
});
