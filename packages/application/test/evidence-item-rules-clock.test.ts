import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteWorkflowStore } from '../../workflow-store/src/store.js';
import { TransactionEvidenceRequestSchema } from '@balanceframe/protocol-generated/validators';
import { ConnectionManager } from '../src/connection-manager.js';
import { TransactionEvidenceService, type TransactionEvidenceNative } from '../src/transaction-evidence.js';
import { actualLiquidityRequest } from '../../../tests/contract/fixtures/actual-liquidity.js';
import fixture from '../../../protocol/fixtures/transaction-evidence-rule.json';

const NOW = '2026-10-21T12:00:00.000Z';
const native = createRequire(import.meta.url)('@balanceframe/native') as TransactionEvidenceNative;
let store: SqliteWorkflowStore;
afterEach(() => store?.close());

async function setup() {
  store = new SqliteWorkflowStore();
  await store.claimBootstrap({ name: 'Owner', email: 'clock-owner@example.test', claimId: 'rule-clock' });
  await store.finalizeBootstrap({ claimId: 'rule-clock', ownerUserId: 'owner' });
  const auth = { method: 'human-session' as const, actorId: 'owner', sessionId: 'rule-clock-session', reauthenticatedAt: NOW };
  const space = store.governance.createSpace({ actorId: 'owner', name: 'Rule clock', kind: 'personal', now: NOW, auth });
  store.governance.bindBudget({ spaceId: space.id, budgetId: 'budget', now: NOW, auth });
  const membership = store.governance.getCurrentMembership({ spaceId: space.id, actorId: 'owner', now: NOW });
  const policy = store.governance.getPolicy({ spaceId: space.id });
  if (!membership || !policy) throw new Error('Fixture owner membership and policy are required');
  const actor = { actorId: 'owner', spaceId: space.id, budgetId: 'budget', membershipId: membership.id, governancePolicyVersion: policy.version, auth };
  function grant(resourceKind: 'budget' | 'evidence' | 'account' | 'category', resourceId: string, capability: string, granted = true) {
    store.governance.setResourceGrant({ spaceId: space.id, budgetId: actor.budgetId, actorId: actor.actorId, membershipId: membership!.id, resourceKind, resourceId, capability, granted, now: NOW, auth });
  }
  for (const capability of ['observe', 'ingest', 'normalized-evidence', 'resolve', 'source', 'rule:view', 'item-rule:propose', 'item-rule:approve', 'item-rule:read']) grant('budget', 'budget', capability);
  for (const capability of ['existence', 'name', 'transaction']) grant('account', 'checking', capability);
  for (const capability of ['category', 'name']) grant('category', 'food', capability);
  const snapshot = actualLiquidityRequest(false).financialSnapshot;
  snapshot.legacySnapshot.rules = [];
  snapshot.legacySnapshot.accounts = [{ ...snapshot.legacySnapshot.accounts[0]!, id: 'checking', isClosed: false }];
  snapshot.legacySnapshot.categories = [{ ...snapshot.legacySnapshot.categories[0]!, id: 'food', deleted: false }];
  const config = { version: 1, serverUrl: 'https://actual.fixture.test', budgetId: actor.budgetId, budgetName: 'Clock fixture', groupId: 'clock-group' };
  const budget = { id: actor.budgetId, name: config.budgetName, groupId: config.groupId, encrypted: false };
  let duringActualRead = () => {};
  const connectionManager = new ConnectionManager({
    credentialStore: {
      load: async () => ({ serverUrl: config.serverUrl, secretKey: 'local-test-only' }),
      store: async () => {},
    },
    connectorFactory: async () => ({
      connect: async () => [budget],
      selectBudget: async () => budget,
      synchronize: async () => {
        duringActualRead();
        return { financialSnapshot: snapshot };
      },
      disconnect: async () => {},
    }),
    readFile: async () => JSON.stringify(config),
  });
  let tick = Date.parse(NOW);
  let advancing = false;
  const service = new TransactionEvidenceService({
    store,
    native,
    connectionManager,
    rawEncryptionKey: Buffer.alloc(32),
    clock: () => new Date(advancing ? tick++ : tick),
  });
  const evidence = TransactionEvidenceRequestSchema.parse(fixture.evidence);
  const content = {
    templateVersion: 'retail-v1',
    observations: evidence.observations.filter((row) => row.kind !== 'ledger_transaction').map(({ provenance: _provenance, ...row }) => row),
    receipts: evidence.receipts.map((receipt) => ({ ...receipt, tenders: receipt.tenders.map((tender) => ({ ...tender, observationId: null })) })),
  };
  const saved = await service.ingest(actor, { connectorId: 'retail', sourceId: 'receipt-1', sourceTimestamp: NOW, mediaType: 'application/json', sourceKind: 'retail', content: JSON.stringify(content) });
  grant('evidence', saved.document.id, 'evidence');
  grant('evidence', saved.document.id, 'normalized-evidence');
  advancing = true;
  return {
    actor,
    service,
    grant,
    revokeDuringRead: () => { duringActualRead = () => grant('budget', 'budget', 'source', false); },
    input: { connectorId: 'retail', accountId: 'checking', fundingInstrumentId: 'card-1', counterparty: 'person-1', sku: 'sku-1', normalizedDescription: null, categoryId: 'food' },
  };
}

describe('item-rule proposal clock', () => {
  it('persists and approves a source-bound proposal when every clock read advances a millisecond', async () => {
    const { actor, service, input } = await setup();
    const proposed = await service.proposeItemRule(actor, input);
    expect(proposed.state).toBe('proposed');
    expect(Date.parse(proposed.createdAt)).toBeGreaterThan(Date.parse(NOW));
    expect(Date.parse(proposed.expiresAt) - Date.parse(proposed.createdAt)).toBe(7 * 86400000);
    expect((await service.listItemRules(actor)).map((rule) => rule.payloadHash)).toEqual([proposed.payloadHash]);
    const approved = await service.approveItemRule(actor, { proposalId: proposed.id, payloadHash: proposed.payloadHash });
    expect(approved.state).toBe('approved');
    expect(approved.approvals[0]?.payloadHash).toBe(proposed.payloadHash);
  });

  it('still rejects current authority revoked during the asynchronous Actual read', async () => {
    const { actor, service, input, revokeDuringRead, grant } = await setup();
    revokeDuringRead();
    await expect(service.proposeItemRule(actor, input)).rejects.toThrow(/authorized/);
    grant('budget', 'budget', 'source');
    expect(await service.listItemRules(actor)).toEqual([]);
  });
});
