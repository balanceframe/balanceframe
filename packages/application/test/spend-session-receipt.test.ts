import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompareSpendSessionReceiptRequest } from '@balanceframe/protocol-generated';
import { canonicalProposalJson } from '../../workflow-store/src/proposal.js';
import { SqliteWorkflowStore } from '../../workflow-store/src/store.js';
import { SpendSessionReceiptService } from '../src/spend-session-receipt.js';
import type { MerchantActor } from '../src/merchant-service.js';

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../protocol/fixtures/spend-session-receipt.json', import.meta.url),
    'utf8',
  ),
) as CompareSpendSessionReceiptRequest;
const native = createRequire(import.meta.url)('@balanceframe/native') as {
  compareSpendSessionReceipt(input: string): string;
};
const now = '2026-10-21T12:00:00.000Z';
const scope = { spaceId: 'space', budgetId: 'budget', connectionId: 'connection' };
const actor: MerchantActor = {
  actorId: 'owner',
  budgetId: 'budget',
  spaceId: 'space',
  membershipId: 'member',
  governancePolicyVersion: 'evidence-policy-1',
  auth: { method: 'human-session', actorId: 'owner', sessionId: 'session', reauthenticatedAt: now },
};
let store: SqliteWorkflowStore;
afterEach(() => store?.close());
function setup() {
  store = new SqliteWorkflowStore();
  let allowed = true;
  const access = () => ({ scope, actorId: actor.actorId, now, authorize: () => allowed });
  const base = {
    sourceTimestamp: now,
    mediaType: 'application/json',
    privateActorId: actor.actorId,
    retentionUntil: '2026-10-22T12:00:00.000Z',
    parseStatus: 'parsed' as const,
    quality: ['test'],
    extraction: {
      templateVersion: 'retail-v1',
      observations: [],
      relationships: [],
      wallets: [],
      receipts: [],
    },
  };
  const saved = store.evidence.archiveSpendSession(
    access(),
    {
      ...base,
      connectorId: 'spend-session',
      sourceId: 'session:session-1',
      parserVersion: 'spend-session-snapshot-v1',
      content: Buffer.from(canonicalProposalJson(fixture.sessionSnapshot.intent)),
    },
    fixture.sessionSnapshot.intent,
    Buffer.alloc(32, 7),
  );
  const receipt = store.evidence.ingest(
    access(),
    {
      ...base,
      connectorId: 'retail',
      sourceId: 'receipt-one',
      parserVersion: 'retail-v1',
      content: Buffer.from('synthetic receipt'),
    },
    Buffer.alloc(32, 7),
  );
  const request = structuredClone(fixture.evidence);
  for (const observation of request.observations)
    observation.provenance.documentId = receipt.document.id;
  const version = vi.spyOn(store.liquidity, 'hasCurrentSpendSessionVersion').mockReturnValue(true);
  const completions = vi
    .spyOn(store.liquidity, 'listSessionCompletionProposals')
    .mockReturnValue([]);
  const capture = vi.fn(async () => ({
    scope,
    documents: [saved.document, receipt.document],
    request,
    authorize: () => allowed,
  }));
  const compare = vi.fn((input: string) => native.compareSpendSessionReceipt(input));
  const service = new SpendSessionReceiptService({
    store,
    native: { compareSpendSessionReceipt: compare },
    now: () => now,
    capture,
    access: () => access(),
  });
  const input = {
    sessionDocumentId: saved.document.id,
    receipt: { documentId: receipt.document.id, receiptId: fixture.receipt.receiptId },
    review: fixture.review,
  };
  return {
    service,
    saved,
    receipt,
    request,
    input,
    capture,
    compare,
    version,
    completions,
    access,
    deny: () => {
      allowed = false;
    },
  };
}
describe('archived saved-session receipt comparisons', () => {
  it('compares exact server snapshots and conserves receipt money without completing or writing a transaction', async () => {
    const f = setup();
    const result = await f.service.compare(actor, f.input);
    expect(result).toMatchObject({
      authority: 'comparison_only',
      sessionId: 'session-1',
      sessionVersion: 2,
      receiptTotal: { minorUnits: '1200', currency: 'USD' },
      state: 'complete',
    });
    expect(result.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'matched', quantityComparison: 'same' }),
        expect.objectContaining({ status: 'omitted' }),
      ]),
    );
    expect(result).not.toHaveProperty('ledgerEffect');
    const saved = await f.service.save(actor, {
      ...f.input,
      comparisonHash: result.comparisonHash,
    });
    expect(saved.result).toEqual(result);
    expect(
      (await f.service.context(actor, { sessionDocumentId: f.saved.document.id })).associations,
    ).toHaveLength(1);
    expect(f.version).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-1', expectedVersion: 2 }),
    );
  });
  it('rejects imported origin claims, stale versions, forged financial fields and stale previews', async () => {
    const f = setup();
    await expect(
      f.service.compare(actor, { ...f.input, sessionDocumentId: f.receipt.document.id }),
    ).rejects.toThrow(/snapshot/);
    await expect(
      f.service.compare(actor, { ...f.input, ledgerEffect: { amount: '1200' } }),
    ).rejects.toThrow();
    const preview = await f.service.compare(actor, f.input);
    f.request.receipts[0]!.lines[0]!.rawDescription = 'updated evidence';
    await expect(
      f.service.save(actor, { ...f.input, comparisonHash: preview.comparisonHash }),
    ).rejects.toThrow(/changed/);
    expect(
      store.evidence.sessionSnapshots.associations(
        f.access(),
        f.saved.document.id,
        { policyVersion: actor.governancePolicyVersion, membershipId: actor.membershipId },
        () => true,
      ),
    ).toEqual([]);
    f.version.mockReturnValue(false);
    await expect(f.service.compare(actor, f.input)).rejects.toThrow(/version|snapshot/);
  });
  it('requires fresh human approval and rechecks grants after asynchronous capture and native comparison', async () => {
    const f = setup();
    const result = await f.service.compare(actor, f.input);
    await expect(
      f.service.save({ ...actor, auth: { ...actor.auth, method: 'api-key' } } as MerchantActor, {
        ...f.input,
        comparisonHash: result.comparisonHash,
      }),
    ).rejects.toThrow(/human/);
    f.compare.mockImplementation((input) => {
      const result = native.compareSpendSessionReceipt(input);
      f.deny();
      return result;
    });
    await expect(f.service.compare(actor, f.input)).rejects.toThrow(/authorized|changed/);
    expect(
      store.evidence.sessionSnapshots.associations(
        f.access(),
        f.saved.document.id,
        { policyVersion: actor.governancePolicyVersion, membershipId: actor.membershipId },
        () => true,
      ),
    ).toEqual([]);
  });
});
