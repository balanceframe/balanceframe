import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fixture from '../../../protocol/fixtures/transaction-evidence.json';
import result from '../../../protocol/fixtures/transaction-evidence-result.json';
import { WalletStatementService, qualifiedWalletId } from '../src/wallet-statement.js';
const now = '2026-10-21T12:00:00.000Z';
const actor = {
  actorId: 'owner',
  spaceId: 'space',
  budgetId: 'budget',
  membershipId: 'period',
  governancePolicyVersion: 'policy',
  auth: { method: 'human-session', actorId: 'owner', sessionId: 'session', reauthenticatedAt: now },
} as const;
const scope = { spaceId: 'space', budgetId: 'budget', connectionId: 'connection' };
const bytes = Buffer.from('statement original');
const document = {
  id: 'statement',
  scope,
  connectorId: 'wallet',
  sourceId: 'delivery-1',
  sourceTimestamp: now,
  receivedAt: now,
  mediaType: 'application/pdf',
  parserVersion: 'wallet-v1',
  privateActorId: 'owner',
  retentionUntil: '2026-10-22T12:00:00.000Z',
  parseStatus: 'unsupported_template',
  contentHash: createHash('sha256').update(bytes).digest('hex'),
  supersedesId: null,
  quality: [],
  extraction: {},
} as const;
const selector = {
  statementDocumentId: 'statement',
  wallet: { kind: 'new', label: 'My wallet', currency: 'USD' },
  startDate: '2026-10-01',
  endDate: '2026-10-20',
  openingBalance: { minorUnits: '100', currency: 'USD' },
  closingBalance: { minorUnits: '100', currency: 'USD' },
};
function setup() {
  let allowed = true,
    fold = 'a'.repeat(64);
  const attest = vi.fn(),
    revoke = vi.fn();
  const request = {
    ...structuredClone(fixture),
    policyVersion: 'policy',
    observations: [],
    wallets: [],
    relationships: [],
    receipts: [],
  };
  const previewNative = vi.fn((text: string) => {
    const input = JSON.parse(text);
    return JSON.stringify({
      contractVersion: '1',
      walletId: input.walletId,
      currency: 'USD',
      startDate: input.startDate,
      endDate: input.endDate,
      activityManifest: [],
      activityManifestHash: 'b'.repeat(64),
      netChange: { minorUnits: '0', currency: 'USD' },
      inflows: { minorUnits: '0', currency: 'USD' },
      outflows: { minorUnits: '0', currency: 'USD' },
      excludedObservationIds: [],
      reasonCodes: [],
    });
  });
  const host = {
    store: {
      evidence: {
        walletStatements: { state: () => ({ foldHash: fold, proofs: [] }), attest, revoke },
      },
    },
    native: {
      deriveWalletStatementPreview: previewNative,
      resolveTransactionEvidence: () => JSON.stringify({ ...result, policyVersion: 'policy' }),
    },
    now: () => now,
    key: Buffer.alloc(32),
    capture: async () => ({
      scope,
      documents: [document],
      request: structuredClone(request),
      authorize: () => allowed,
    }),
    access: () => ({ scope, actorId: 'owner', now, authorize: () => allowed }),
    readOriginal: vi.fn(async () => bytes),
    fresh: vi.fn(),
  };
  const service = new WalletStatementService(host as never);
  return {
    service,
    host,
    attest,
    revoke,
    deny: () => {
      allowed = false;
    },
    changeFold: () => {
      fold = 'c'.repeat(64);
    },
  };
}
it('binds explicitly reviewed local claims to exact original bytes, identity, coverage, native manifest and server authority', async () => {
  const { service, attest } = setup();
  const preview = await service.preview(actor, selector);
  expect(preview.proof.authorityKind).toBe('human_attested_statement');
  expect(preview.proof.statement).toEqual({
    documentId: 'statement',
    contentHash: document.contentHash,
    parserVersion: 'wallet-v1',
  });
  expect(preview.proof.actorId).toBe('owner');
  await service.attest(actor, {
    ...selector,
    previewHash: preview.previewHash,
    expectedProofFoldHash: preview.proofFoldHash,
    originalAcknowledged: true,
    completeActivityAcknowledged: true,
  });
  expect(attest).toHaveBeenCalledOnce();
  const proof = attest.mock.calls[0]![1].proof;
  expect(proof.walletId).toBe(qualifiedWalletId(scope, document, 'My wallet'));
  expect(proof.openingBalance).toEqual(selector.openingBalance);
  for (const extra of [
    { actorId: 'forged' },
    { authorityKind: 'provider_authenticated' },
    { activityManifest: [] },
  ])
    await expect(service.preview(actor, { ...selector, ...extra })).rejects.toThrow();
});
it('requires explicit completeness/original confirmation and rejects changed preview, raw expiry and revoked authority after an await', async () => {
  const { service, host, attest, deny } = setup();
  const preview = await service.preview(actor, selector);
  const body = {
    ...selector,
    previewHash: preview.previewHash,
    expectedProofFoldHash: preview.proofFoldHash,
    originalAcknowledged: true,
    completeActivityAcknowledged: true,
  };
  await expect(service.attest(actor, { ...body, originalAcknowledged: false })).rejects.toThrow();
  await expect(service.attest(actor, { ...body, previewHash: 'f'.repeat(64) })).rejects.toThrow(
    /changed/,
  );
  host.readOriginal.mockImplementationOnce(async () => {
    deny();
    return bytes;
  });
  await expect(service.preview(actor, selector)).rejects.toThrow(/author/);
  expect(attest).not.toHaveBeenCalled();
});
it('keeps private-owner wallet labels separate and revokes without requiring original content', async () => {
  expect(qualifiedWalletId(scope, document, 'My wallet')).not.toBe(
    qualifiedWalletId(scope, { ...document, privateActorId: 'peer' }, 'My wallet'),
  );
  const { service, revoke, host } = setup();
  await service.revoke(actor, { proofId: 'proof', expectedProofFoldHash: 'a'.repeat(64) });
  expect(revoke).toHaveBeenCalledOnce();
  expect(host.readOriginal).not.toHaveBeenCalled();
});
