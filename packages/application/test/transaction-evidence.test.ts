import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { SqliteWorkflowStore } from '../../workflow-store/src/store.js';
import {
  TransactionEvidenceService,
  LocalWalletEvidenceConnector,
  PrivateInboundEvidenceAdapter,
  createTransactionEvidenceService,
} from '../src/transaction-evidence.js';
import { merchantConnectionId } from '../src/merchant-service.js';
import { actualLiquidityRequest } from '../../../tests/contract/fixtures/actual-liquidity.js';
import { createHash, createHmac } from 'node:crypto';

const now = '2026-10-21T12:00:00.000Z';
const fixture = JSON.parse(
  readFileSync(
    new URL('../../../protocol/fixtures/transaction-evidence.json', import.meta.url),
    'utf8',
  ),
);
let store: SqliteWorkflowStore;
afterEach(() => store?.close());
async function setup() {
  store = new SqliteWorkflowStore();
  await store.claimBootstrap({ name: 'Owner', email: 'owner@example.com', claimId: 'evidence' });
  await store.finalizeBootstrap({ claimId: 'evidence', ownerUserId: 'owner' });
  const auth = {
    method: 'human-session' as const,
    actorId: 'owner',
    sessionId: 'session-owner',
    reauthenticatedAt: now,
  };
  const space = store.governance.createSpace({
    actorId: 'owner',
    name: 'Evidence',
    kind: 'personal',
    now,
    auth,
  });
  store.governance.bindBudget({ spaceId: space.id, budgetId: 'budget', now, auth });
  const membership = store.governance.getCurrentMembership({
    spaceId: space.id,
    actorId: 'owner',
    now,
  })!;
  const actor = {
    actorId: 'owner',
    budgetId: 'budget',
    spaceId: space.id,
    membershipId: membership.id,
    governancePolicyVersion: store.governance.getPolicy({ spaceId: space.id })!.version,
    auth,
  };
  function grant(
    resourceKind: 'budget' | 'evidence' | 'transaction' | 'account' | 'category',
    resourceId: string,
    capability: string,
    granted = true,
  ) {
    store.governance.setResourceGrant({
      spaceId: space.id,
      budgetId: 'budget',
      actorId: 'owner',
      membershipId: membership.id,
      resourceKind,
      resourceId,
      capability,
      granted,
      now,
      auth,
    });
  }
  for (const right of ['observe', 'ingest', 'resolve', 'normalized-evidence'])
    grant('budget', 'budget', right);
  grant('transaction', 'actual-bank-1', 'transaction');
  const native = {
    compareSpendSessionReceipt: vi.fn((input: string) =>
      (
        createRequire(import.meta.url)('@balanceframe/native') as {
          compareSpendSessionReceipt(input: string): string;
        }
      ).compareSpendSessionReceipt(input),
    ),
    resolveTransactionEvidence: vi.fn(() =>
      JSON.stringify({
        contractVersion: '1',
        policyVersion: store.governance.getPolicy({ spaceId: space.id })!.version,
        resolutionHash: 'a'.repeat(64),
        events: [],
        relationships: [],
        wallets: [],
        receipts: [],
        blockers: [],
      }),
    ),
  };
  const service = new TransactionEvidenceService({
    store,
    rawEncryptionKey: Buffer.alloc(32, 9),
    native,
    clock: () => new Date(now),
    scopeFor: () => ({
      spaceId: space.id,
      budgetId: 'budget',
      connectionId: merchantConnectionId({ serverUrl: 'https://fixture.test', budgetId: 'budget' }),
    }),
  });
  const observations = fixture.observations
    .slice(0, 1)
    .map(({ provenance: _provenance, ...value }: (typeof fixture.observations)[number]) => value);
  const input = {
    connectorId: 'wallet',
    sourceId: 'statement-1',
    sourceTimestamp: now,
    mediaType: 'application/json',
    sourceKind: 'wallet' as const,
    content: JSON.stringify({ templateVersion: 'wallet-v1', observations }),
  };
  return { service, actor, grant, native, input };
}
describe('transaction evidence orchestration', () => {
  it('keeps a gap between individually covered statement intervals visible in connector health', async () => {
    const { service, actor, grant, native, input } = await setup();
    const real = createRequire(import.meta.url)('@balanceframe/native') as {
      resolveTransactionEvidence(input: string): string;
      deriveWalletStatementPreview(input: string): string;
    };
    native.resolveTransactionEvidence.mockImplementation(real.resolveTransactionEvidence);
    service['options'].native.deriveWalletStatementPreview = real.deriveWalletStatementPreview;
    for (const [startDate, endDate] of [
      ['2026-10-01', '2026-10-05'],
      ['2026-10-10', '2026-10-20'],
    ]) {
      const imported = await service.ingest(actor, {
        ...input,
        sourceId: `statement-${startDate}`,
        mediaType: 'application/pdf',
        content: `%PDF-1.4\nSynthetic statement ${startDate} through ${endDate}: USD1, no activity`,
      });
      for (const capability of ['evidence', 'normalized-evidence', 'raw-document', 'source'])
        grant('evidence', imported.document.id, capability);
      const selector = {
        statementDocumentId: imported.document.id,
        wallet: { kind: 'new', label: 'Same personal wallet', currency: 'USD' },
        startDate,
        endDate,
        openingBalance: { minorUnits: '100', currency: 'USD' },
        closingBalance: { minorUnits: '100', currency: 'USD' },
      };
      const preview = await service.previewWalletStatement(actor, selector);
      await service.attestWalletStatement(actor, {
        ...selector,
        previewHash: preview.previewHash,
        expectedProofFoldHash: preview.proofFoldHash,
        originalAcknowledged: true,
        completeActivityAcknowledged: true,
      });
    }
    const coverage = (await service.health(actor))[0]!.statementCoverage!;
    expect(coverage.wallets).toHaveLength(1);
    expect(coverage.wallets[0]).toMatchObject({
      balanceState: 'balance_unknown',
      reasonCodes: expect.arrayContaining(['wallet_statement_coverage_gap']),
      coverage: {
        intervals: [{ state: 'covered' }, { state: 'covered' }],
        uncoveredObservationIds: [],
        blockedObservationIds: [],
      },
    });
  });
  it('attests a local statement without authenticating imports and withdraws native opening anchors on revocation', async () => {
    const { service, actor, grant, native, input } = await setup();
    const real = createRequire(import.meta.url)('@balanceframe/native') as {
      resolveTransactionEvidence(input: string): string;
      deriveWalletStatementPreview(input: string): string;
    };
    native.resolveTransactionEvidence.mockImplementation(real.resolveTransactionEvidence);
    service['options'].native.deriveWalletStatementPreview = real.deriveWalletStatementPreview;
    const imported = await service.ingest(actor, {
      ...input,
      sourceId: 'pdf-statement',
      mediaType: 'application/pdf',
      content: '%PDF-1.4\nSynthetic wallet statement: opening USD1, no activity, closing USD1',
    });
    for (const capability of ['evidence', 'normalized-evidence', 'raw-document', 'source'])
      grant('evidence', imported.document.id, capability);
    const selector = {
      statementDocumentId: imported.document.id,
      wallet: { kind: 'new', label: 'Personal wallet', currency: 'USD' },
      startDate: '2026-10-01',
      endDate: '2026-10-20',
      openingBalance: { minorUnits: '100', currency: 'USD' },
      closingBalance: { minorUnits: '100', currency: 'USD' },
    };
    const preview = await service.previewWalletStatement(actor, selector);
    expect(preview.proof.authorityKind).toBe('human_attested_statement');
    expect(preview.resolution.wallets[0]!.coverage?.intervals[0]!.state).toBe('covered');
    expect(preview.resolution.wallets[0]!.balanceAnchors).toHaveLength(2);
    const admitted = await service.attestWalletStatement(actor, {
      ...selector,
      previewHash: preview.previewHash,
      expectedProofFoldHash: preview.proofFoldHash,
      originalAcknowledged: true,
      completeActivityAcknowledged: true,
    });
    expect(admitted.proofs).toHaveLength(1);
    expect((await service.health(actor))[0]?.statementCoverage).toMatchObject({
      state: 'evaluated',
      authorityKind: 'human_attested_statement',
      wallets: [
        { walletId: admitted.proof.walletId, coverage: { intervals: [{ state: 'covered' }] } },
      ],
    });
    const admittedContext = await service.walletStatementContext(actor);
    const anchor = admittedContext.resolution.wallets[0]!.balanceAnchors!.find(
      (anchor) => anchor.boundary === 'before_day_activity',
    )!;
    const openingSelector = {
      resolutionHash: admittedContext.resolution.resolutionHash,
      walletId: anchor.walletId,
      proofSetHash: anchor.proofSetHash,
      activityManifestHash: anchor.activityManifestHash,
      asOfDate: anchor.asOfDate,
      accountName: 'Reviewed wallet',
    };
    expect(await service.prepareWalletMaterialization(actor, openingSelector)).toMatchObject({
      kind: 'wallet_materialization',
      walletId: anchor.walletId,
      accountName: 'Reviewed wallet',
      currency: 'USD',
      opening: {
        amount: { minorUnits: '100', currency: 'USD' },
        date: anchor.asOfDate,
        proofSetHash: anchor.proofSetHash,
        activityManifestHash: anchor.activityManifestHash,
      },
    });
    await expect(
      service.prepareWalletMaterialization(actor, {
        ...openingSelector,
        proofSetHash: 'f'.repeat(64),
      }),
    ).rejects.toThrow(/anchor|changed/);
    const snapshot = actualLiquidityRequest(false).financialSnapshot;
    const captured = await service.captureObservations(
      actor,
      { serverUrl: 'https://fixture.test', budgetId: actor.budgetId },
      snapshot,
    );
    expect(captured.filter((proof) => proof.kind === 'wallet_statement_anchor')).toHaveLength(2);
    expect(
      captured.every((proof) =>
        proof.evidence.every((reference) => reference.kind === 'human_attested_statement'),
      ),
    ).toBe(true);
    grant('evidence', imported.document.id, 'delete');
    await service.deleteRaw(actor, imported.document.id);
    expect((await service.walletStatementProofs(actor)).proofs).toHaveLength(1);
    await expect(service.previewWalletStatement(actor, selector)).rejects.toThrow(/original.*raw/);
    await service.revokeWalletStatement(actor, {
      proofId: admitted.proof.proofId,
      expectedProofFoldHash: admitted.foldHash,
    });
    expect((await service.walletStatementProofs(actor)).proofs).toEqual([]);
    expect(
      await service.captureObservations(
        actor,
        { serverUrl: 'https://fixture.test', budgetId: actor.budgetId },
        snapshot,
      ),
    ).toEqual([]);
  });

  it('keeps manual source text inert, binds server provenance, resolves without models and independently gates raw', async () => {
    const { service, actor, grant, native, input } = await setup();
    const saved = await service.ingest(actor, input);
    grant('evidence', saved.document.id, 'evidence');
    grant('evidence', saved.document.id, 'normalized-evidence');
    expect(await service.list(actor)).toHaveLength(1);
    await service.resolve(actor, { policyVersion: actor.governancePolicyVersion });
    const sent = JSON.parse(native.resolveTransactionEvidence.mock.calls[0]![0]!);
    expect(sent.observations[0].provenance.documentId).toBe(saved.document.id);
    expect(sent.observations[0].provenance.contentHash).toBe(saved.document.contentHash);
    await expect(service.raw(actor, saved.document.id)).rejects.toThrow(/authorized/);
    grant('evidence', saved.document.id, 'raw-document');
    expect((await service.raw(actor, saved.document.id))?.toString()).toBe(input.content);
    grant('evidence', saved.document.id, 'normalized-evidence', false);
    expect(await service.list(actor)).toEqual([]);
    await expect(
      service.resolve(actor, { policyVersion: actor.governancePolicyVersion }),
    ).rejects.toThrow();
  });
  it('refuses user imports that impersonate Actual and requires explicit resolve authority', async () => {
    const { service, actor, grant, input, native } = await setup();
    const observations = fixture.observations.map(
      ({ provenance: _p, ...value }: (typeof fixture.observations)[number]) => value,
    );
    const saved = await service.ingest(actor, {
      ...input,
      content: JSON.stringify({ templateVersion: 'wallet-v1', observations }),
    });
    expect(saved.document.parseStatus).toBe('malformed');
    grant('budget', 'budget', 'resolve', false);
    await expect(
      service.resolve(actor, { policyVersion: actor.governancePolicyVersion }),
    ).rejects.toThrow(/authorized/);
    expect(native.resolveTransactionEvidence).not.toHaveBeenCalled();
  });
  it('binds correction decisions to the exact current source result and rechecks authorization', async () => {
    const { service, actor, grant, input } = await setup();
    const saved = await service.ingest(actor, input);
    grant('evidence', saved.document.id, 'evidence');
    grant('evidence', saved.document.id, 'normalized-evidence');
    await expect(
      service.saveResolutionDecision(actor, {
        resolutionHash: 'b'.repeat(64),
        policyVersion: actor.governancePolicyVersion,
        relationships: [],
      }),
    ).rejects.toThrow(/changed/);
    const result = await service.saveResolutionDecision(actor, {
      resolutionHash: 'a'.repeat(64),
      policyVersion: actor.governancePolicyVersion,
      relationships: [],
    });
    expect(result.resolutionHash).toBe('a'.repeat(64));
    await expect(
      service.saveResolutionDecision(actor, {
        resolutionHash: 'a'.repeat(64),
        policyVersion: actor.governancePolicyVersion,
        relationships: [
          {
            id: 'bad',
            fromId: 'unknown',
            toId: 'other',
            kind: 'funding',
            state: 'confirmed',
            allocatedAmount: null,
            partial: false,
            score: 100,
            reasonCodes: [],
            evidenceIds: [],
          },
        ],
      }),
    ).rejects.toThrow(/source/);
    grant('budget', 'budget', 'resolve', false);
    await expect(
      service.saveResolutionDecision(actor, {
        resolutionHash: 'a'.repeat(64),
        policyVersion: actor.governancePolicyVersion,
        relationships: [],
      }),
    ).rejects.toThrow(/authorized/);
  });
  it('publishes only native conserved observations for reviewed exact effects and invalidates changed sources', async () => {
    const { service, actor, grant, input, native } = await setup();
    const saved = await service.ingest(actor, input);
    grant('evidence', saved.document.id, 'evidence');
    grant('evidence', saved.document.id, 'normalized-evidence');
    grant('account', 'checking', 'transaction');
    await service.saveResolutionDecision(actor, {
      resolutionHash: 'a'.repeat(64),
      policyVersion: actor.governancePolicyVersion,
      relationships: [],
      ledgerEffects: [
        {
          observationId: 'wallet-1',
          effect: {
            accountId: 'checking',
            amount: { minorUnits: '-1200', currency: 'USD' },
            date: '2026-10-15',
            categoryId: null,
            payeeName: null,
            notes: null,
            splits: [],
          },
        },
      ],
    });
    await service.captureObservations(
      actor,
      { serverUrl: 'https://fixture.test', budgetId: actor.budgetId },
      actualLiquidityRequest(false).financialSnapshot,
    );
    const captured = JSON.parse(native.resolveTransactionEvidence.mock.calls.at(-1)![0]!);
    expect(captured.observations[0].kind).toBe('wallet_payment');
    expect(captured.observations[0].reviewedLedgerEffect).toBe(true);
    expect(captured.observations[0].ledgerEffect.amount.minorUnits).toBe('-1200');
  });
  it('requires exact session version and ingests authorized stored session items without invented totals', async () => {
    const { service, actor, grant } = await setup();
    const session = {
      id: 'session-1',
      version: 2,
      updatedAt: now,
      accountId: null,
      adjustments: [],
      warningThresholds: [],
      items: [
        {
          id: 'item',
          amount: { minorUnits: '1200', currency: 'USD' },
          categoryId: 'food',
          purchaseAt: now,
          requiredBy: now,
          accountId: null,
          priceProvenance: { kind: 'current_session_manual', observedAt: now, estimate: false },
          barcode: 'exact-barcode',
          quantity: 2,
        },
      ],
    };
    vi.spyOn(store.liquidity, 'getSpendSession').mockReturnValue(session as never);
    await expect(
      service.ingestSpendSession(actor, { sessionId: session.id, expectedVersion: 1 }),
    ).rejects.toThrow(/version/);
    const saved = await service.ingestSpendSession(actor, {
      sessionId: session.id,
      expectedVersion: 2,
    });
    expect(saved.document.sourceId).toBe('session:session-1');
    expect(saved.document).not.toHaveProperty('extraction');
    grant('evidence', saved.document.id, 'evidence');
    grant('evidence', saved.document.id, 'normalized-evidence');
    const archived = store.evidence.sessionSnapshots.get(
      {
        scope: {
          spaceId: actor.spaceId,
          budgetId: actor.budgetId,
          connectionId: merchantConnectionId({
            serverUrl: 'https://fixture.test',
            budgetId: actor.budgetId,
          }),
        },
        actorId: actor.actorId,
        now,
        authorize: () => true,
      },
      saved.document.id,
    );
    expect(archived?.intent).toMatchObject({
      id: session.id,
      version: session.version,
      accountId: null,
      items: session.items,
    });
    expect(archived?.contentHash).toBe(saved.document.contentHash);
    expect(store.liquidity.getSpendSession).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: actor.actorId, id: session.id }),
    );
  });
  it('exposes native session comparison through the authorized evidence composition without trusting uploaded origin', async () => {
    const { service, actor, grant } = await setup();
    grant('category', 'food', 'category');
    const source = JSON.parse(
      readFileSync(
        new URL('../../../protocol/fixtures/spend-session-receipt.json', import.meta.url),
        'utf8',
      ),
    );
    vi.spyOn(store.liquidity, 'getSpendSession').mockReturnValue({
      ...source.sessionSnapshot.intent,
      updatedAt: now,
    } as never);
    vi.spyOn(store.liquidity, 'hasCurrentSpendSessionVersion').mockReturnValue(true);
    const session = await service.ingestSpendSession(actor, {
      sessionId: source.sessionSnapshot.intent.id,
      expectedVersion: source.sessionSnapshot.intent.version,
    });
    const receipt = await service.ingest(actor, {
      connectorId: 'retail',
      sourceId: 'receipt-native',
      sourceTimestamp: now,
      mediaType: 'application/json',
      sourceKind: 'retail',
      content: JSON.stringify({
        templateVersion: 'retail-v1',
        observations: source.evidence.observations.map(
          ({ provenance: _provenance, ...observation }: Record<string, unknown>) => observation,
        ),
        receipts: source.evidence.receipts,
      }),
    });
    for (const document of [session.document, receipt.document]) {
      grant('evidence', document.id, 'evidence');
      grant('evidence', document.id, 'normalized-evidence');
    }
    const context = await service.spendSessionReceiptContext(actor, {
      sessionDocumentId: session.document.id,
    });
    expect(context.snapshot.intent.items[0]).toMatchObject({ quantity: 2, barcode: 'sku-1' });
    expect(context.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentId: receipt.document.id,
          receiptId: source.receipt.receiptId,
        }),
      ]),
    );
    const input = {
      sessionDocumentId: session.document.id,
      receipt: { documentId: receipt.document.id, receiptId: source.receipt.receiptId },
      review: source.review,
    };
    const result = await service.compareSpendSessionReceipt(actor, input);
    expect(result).toMatchObject({
      authority: 'comparison_only',
      state: 'complete',
      receiptTotal: { minorUnits: '1200', currency: 'USD' },
    });
    expect(
      (
        await service.saveSpendSessionReceipt(actor, {
          ...input,
          comparisonHash: result.comparisonHash,
        })
      ).result,
    ).toEqual(result);
  });
  it('retains exact approved payment purpose and exposes current unresolved work only with resolve authority', async () => {
    const { service, actor, grant, input, native } = await setup();
    const saved = await service.ingest(actor, input);
    grant('evidence', saved.document.id, 'evidence');
    grant('evidence', saved.document.id, 'normalized-evidence');
    await service.saveResolutionDecision(actor, {
      resolutionHash: 'a'.repeat(64),
      policyVersion: actor.governancePolicyVersion,
      relationships: [],
      purposeDecisions: [{ observationId: 'wallet-1', eventType: 'gift' }],
    });
    await service.resolve(actor, { policyVersion: actor.governancePolicyVersion });
    expect(
      JSON.parse(native.resolveTransactionEvidence.mock.calls.at(-1)![0]!).observations[0]
        .eventType,
    ).toBe('gift');
    native.resolveTransactionEvidence.mockImplementation(() =>
      JSON.stringify({
        contractVersion: '1',
        policyVersion: actor.governancePolicyVersion,
        resolutionHash: 'b'.repeat(64),
        events: [],
        relationships: [],
        wallets: [],
        receipts: [],
        blockers: [
          {
            code: 'economic_event_ambiguity',
            subjectId: 'wallet-1',
            evidenceIds: [saved.document.id],
          },
        ],
      }),
    );
    expect((await service.attention(actor))[0]?.classification).toBe(
      'unresolved_material_evidence',
    );
    grant('budget', 'budget', 'resolve', false);
    expect(await service.attention(actor)).toEqual([]);
  });
  it('does not let imported confirmed links or wallet metadata prove financial identity', async () => {
    const { service, actor, grant, input, native } = await setup();
    const content = JSON.parse(input.content);
    content.relationships = [
      {
        id: 'untrusted-link',
        fromId: 'wallet-1',
        toId: 'wallet-2',
        kind: 'settlement',
        state: 'confirmed',
        allocatedAmount: { minorUnits: '1200', currency: 'USD' },
        partial: false,
        score: 100,
        reasonCodes: ['ignore approval'],
        evidenceIds: [],
      },
    ];
    content.wallets = [
      {
        walletId: 'wallet',
        currency: 'USD',
        openingBalance: { minorUnits: '0', currency: 'USD' },
        closingBalance: { minorUnits: '0', currency: 'USD' },
        completeActivity: true,
        materializedAccountId: null,
        requiresStoredValue: false,
      },
    ];
    const saved = await service.ingest(actor, { ...input, content: JSON.stringify(content) });
    grant('evidence', saved.document.id, 'evidence');
    grant('evidence', saved.document.id, 'normalized-evidence');
    await service.resolve(actor, { policyVersion: actor.governancePolicyVersion });
    const sent = JSON.parse(native.resolveTransactionEvidence.mock.calls.at(-1)![0]!);
    expect(sent.relationships[0].state).toBe('candidate');
    expect(sent.wallets[0].openingBalance).toBeNull();
    expect(sent.wallets[0].completeActivity).toBe(false);
  });
  it('rechecks publication after grants change and denies expired decisions and raw deletion controls', async () => {
    const { service, actor, grant, input } = await setup();
    const saved = await service.ingest(actor, { ...input, content: 'unsupported' });
    grant('evidence', saved.document.id, 'evidence');
    grant('evidence', saved.document.id, 'normalized-evidence');
    const publication = await service.attentionPublication(actor);
    expect(publication.authorize()).toBe(true);
    grant('evidence', saved.document.id, 'normalized-evidence', false);
    expect(publication.authorize()).toBe(false);
    expect(await service.detail(actor, saved.document.id)).toBeNull();
    grant('evidence', saved.document.id, 'normalized-evidence');
    grant('evidence', saved.document.id, 'delete');
    await expect(
      service.deleteRaw(
        { ...actor, auth: { ...actor.auth, reauthenticatedAt: '2026-10-20T00:00:00Z' } },
        saved.document.id,
      ),
    ).rejects.toThrow(/Fresh/);
    expect(await service.deleteRaw(actor, saved.document.id)).toBe(true);
    await expect(
      service.saveResolutionDecision(
        { ...actor, auth: { ...actor.auth, reauthenticatedAt: '2026-10-20T00:00:00Z' } },
        {
          resolutionHash: 'a'.repeat(64),
          policyVersion: actor.governancePolicyVersion,
          relationships: [],
        },
      ),
    ).rejects.toThrow(/Fresh/);
  });
  it('fails safely on malformed native results, wrong policy, missing actors and invalid connector configuration', async () => {
    const { service, actor, grant, native, input } = await setup();
    const saved = await service.ingest(actor, input);
    grant('evidence', saved.document.id, 'evidence');
    grant('evidence', saved.document.id, 'normalized-evidence');
    expect((await service.health(actor))[0]?.latestParsedAt).toBe(now);
    native.resolveTransactionEvidence.mockReturnValue('bad-json');
    await expect(
      service.resolve(actor, { policyVersion: actor.governancePolicyVersion }),
    ).rejects.toThrow();
    native.resolveTransactionEvidence.mockReturnValue(
      JSON.stringify({
        contractVersion: '1',
        policyVersion: 'foreign-policy',
        resolutionHash: 'a'.repeat(64),
        events: [],
        relationships: [],
        wallets: [],
        receipts: [],
        blockers: [],
      }),
    );
    await expect(
      service.resolve(actor, { policyVersion: actor.governancePolicyVersion }),
    ).rejects.toThrow(/policy/);
    await expect(service.list({ ...actor, membershipId: '' })).rejects.toThrow(/authorized/);
    expect(
      await service.captureObservations(
        { ...actor, spaceId: undefined },
        { serverUrl: 'https://fixture.test', budgetId: actor.budgetId },
        actualLiquidityRequest(false).financialSnapshot,
      ),
    ).toEqual([]);
    expect(
      () => new PrivateInboundEvidenceAdapter({ allowedSenders: [], secret: Buffer.alloc(32) }),
    ).toThrow();
    expect(
      () =>
        new TransactionEvidenceService({
          store,
          native,
          rawEncryptionKey: Buffer.alloc(8),
          scopeFor: () => ({
            spaceId: actor.spaceId,
            budgetId: actor.budgetId,
            connectionId: 'connection',
          }),
        }),
    ).toThrow();
    const composed = await createTransactionEvidenceService({
      store,
      native,
      rawEncryptionKey: Buffer.alloc(32),
      scopeFor: () => ({
        spaceId: actor.spaceId,
        budgetId: actor.budgetId,
        connectionId: 'connection',
      }),
    });
    expect(composed).toBeInstanceOf(TransactionEvidenceService);
  });
  it('loads every installed evidence capability through the real default factory', async () => {
    const { actor } = await setup();
    const composed = await createTransactionEvidenceService({
      store,
      rawEncryptionKey: Buffer.alloc(32),
      clock: () => new Date(now),
      scopeFor: () => ({
        spaceId: actor.spaceId,
        budgetId: actor.budgetId,
        connectionId: 'connection',
      }),
    });
    const real = createRequire(import.meta.url)('@balanceframe/native') as Record<string, unknown>;
    for (const name of [
      'compareSpendSessionReceipt',
      'learnTransactionEvidenceItemRules',
      'deriveEvidenceSettlementPlan',
    ] as const)
      expect(composed['options'].native[name]).toBe(real[name]);
  });
  it('counts duplicate deliveries only for sources currently visible to the actor', async () => {
    const { service, actor, grant, input } = await setup();
    const saved = await service.ingest(actor, input);
    grant('evidence', saved.document.id, 'evidence');
    grant('evidence', saved.document.id, 'normalized-evidence');
    await service.ingest(actor, input);
    const hidden = await service.ingest(actor, { ...input, sourceId: 'ungranted-source' });
    expect(hidden.document.id).not.toBe(saved.document.id);
    expect(await service.health(actor)).toMatchObject([{ documentCount: 1, duplicateCount: 1 }]);
  });
  it('does not publish connector metrics after source permission is revoked while collecting lifecycle counts', async () => {
    const { service, actor, grant, input } = await setup();
    const saved = await service.ingest(actor, input);
    grant('evidence', saved.document.id, 'evidence');
    grant('evidence', saved.document.id, 'normalized-evidence');
    const original = store.evidence.audit.bind(store.evidence);
    vi.spyOn(store.evidence, 'audit').mockImplementation((...args) => {
      const result = original(...args);
      grant('evidence', saved.document.id, 'normalized-evidence', false);
      return result;
    });
    await expect(service.health(actor)).rejects.toThrow(/authorized/);
  });
  it('returns only authorized ledger target names and rechecks grants after connection I/O', async () => {
    const { service, actor, grant, input } = await setup();
    const snapshot = actualLiquidityRequest(false).financialSnapshot;
    const account = snapshot.legacySnapshot.accounts[0]!;
    const category = snapshot.legacySnapshot.categories[0]!;
    grant('account', account.id, 'name');
    grant('account', account.id, 'existence');
    grant('category', category.id, 'name');
    grant('category', category.id, 'category');
    service['options'].connectionManager = {
      withConnection: async (operation: (value: unknown) => unknown) =>
        operation({
          config: { serverUrl: 'https://fixture.test', budgetId: actor.budgetId },
          synchronization: { financialSnapshot: snapshot },
        }),
    } as never;
    const targets = await service.ledgerTargets(actor);
    expect(targets.accounts).toEqual([{ id: account.id, name: account.name }]);
    expect(targets.categories).toEqual([{ id: category.id, name: category.name }]);
    expect(JSON.stringify(targets)).not.toContain('clearedBalance');
    grant('account', account.id, 'name', false);
    expect((await service.ledgerTargets(actor)).accounts).toEqual([]);
    await expect(
      service.ingest(actor, input, { sourceKind: 'retail', parse: () => ({}) } as never),
    ).rejects.toThrow(/kind/);
  });
  it('applies collection disclosure limits to all returned evidence rather than each document alone', async () => {
    const { service, actor, grant, input } = await setup();
    for (const sourceId of ['first', 'second']) {
      const saved = await service.ingest(actor, { ...input, sourceId });
      grant('evidence', saved.document.id, 'evidence');
      grant('evidence', saved.document.id, 'normalized-evidence');
    }
    store.governance.setResourceGrant({
      spaceId: actor.spaceId,
      budgetId: actor.budgetId,
      actorId: actor.actorId,
      membershipId: actor.membershipId,
      resourceKind: 'budget',
      resourceId: actor.budgetId,
      capability: 'observe',
      granted: true,
      restrictions: { maxGrossOutgoing: [{ minorUnits: '1200', currency: 'USD' }] },
      now,
      auth: actor.auth,
    });
    expect(await service.list(actor)).toEqual([]);
  });
  it('uses current native conservation for an approved projection and blocks overlapping Actual settlement', async () => {
    const { service, actor, grant, input, native } = await setup();
    const realNative = createRequire(import.meta.url)('@balanceframe/native') as {
      resolveTransactionEvidence(input: string): string;
    };
    native.resolveTransactionEvidence.mockImplementation(realNative.resolveTransactionEvidence);
    const content = JSON.parse(input.content);
    content.observations.push({ ...content.observations[0], id: 'receipt-1', kind: 'receipt' });
    const saved = await service.ingest(actor, { ...input, content: JSON.stringify(content) });
    grant('evidence', saved.document.id, 'evidence');
    grant('evidence', saved.document.id, 'normalized-evidence');
    grant('account', 'checking', 'transaction');
    const before = await service.resolve(actor, { policyVersion: actor.governancePolicyVersion });
    const effect = {
      accountId: 'checking',
      amount: { minorUnits: '-1200', currency: 'USD' },
      date: '2026-10-15',
      categoryId: null,
      payeeName: null,
      notes: null,
      splits: [],
    };
    const result = await service.saveResolutionDecision(actor, {
      resolutionHash: before.resolutionHash,
      policyVersion: actor.governancePolicyVersion,
      relationships: [
        {
          id: 'reviewed-settlement',
          fromId: 'wallet-1',
          toId: 'receipt-1',
          kind: 'settlement',
          state: 'confirmed',
          allocatedAmount: { minorUnits: '1200', currency: 'USD' },
          partial: false,
          score: 100,
          reasonCodes: ['human_reviewed'],
          evidenceIds: [saved.document.id],
        },
      ],
      ledgerEffects: [{ observationId: 'wallet-1', effect }],
    });
    expect(result.events[0]?.projectionObservation?.ledgerEffect).toEqual(effect);
    const snapshot = actualLiquidityRequest(false).financialSnapshot;
    expect(
      await service.captureObservations(
        actor,
        { serverUrl: 'https://fixture.test', budgetId: actor.budgetId },
        snapshot,
      ),
    ).toHaveLength(1);
    const row = JSON.parse(
      readFileSync(
        new URL('../../../protocol/fixtures/representative.json', import.meta.url),
        'utf8',
      ),
    ).transactions[0];
    snapshot.legacySnapshot.transactions = [
      {
        ...row,
        id: 'unrelated',
        accountId: 'checking',
        amount: { minorUnits: '-2400', currency: 'USD' },
        date: effect.date,
      },
    ];
    const stableFirst = await service.captureObservations(
      actor,
      { serverUrl: 'https://fixture.test', budgetId: actor.budgetId },
      snapshot,
    );
    const recaptured = {
      ...snapshot,
      snapshotId: 'recaptured-snapshot',
      capturedAt: '2026-10-21T12:00:01.000Z',
    };
    const stableNext = await service.captureObservations(
      actor,
      { serverUrl: 'https://fixture.test', budgetId: actor.budgetId },
      recaptured,
    );
    expect(stableFirst).toHaveLength(1);
    expect(stableNext[0]?.contentHash).toBe(stableFirst[0]?.contentHash);
    snapshot.legacySnapshot.transactions = [
      {
        ...row,
        id: 'already-settled',
        accountId: 'checking',
        amount: effect.amount,
        date: effect.date,
      },
    ];
    expect(
      await service.captureObservations(
        actor,
        { serverUrl: 'https://fixture.test', budgetId: actor.budgetId },
        snapshot,
      ),
    ).toEqual([]);
  });
  it('retains the exact approved proof during owned write readback while refusing mismatched or unrelated ledger rows', async () => {
    const { service, actor, grant, input, native } = await setup();
    const real = createRequire(import.meta.url)('@balanceframe/native') as {
      resolveTransactionEvidence(input: string): string;
    };
    native.resolveTransactionEvidence.mockImplementation(real.resolveTransactionEvidence);
    const source = JSON.parse(input.content);
    source.observations.push({ ...source.observations[0], id: 'receipt-1', kind: 'receipt' });
    const saved = await service.ingest(actor, { ...input, content: JSON.stringify(source) });
    grant('evidence', saved.document.id, 'evidence');
    grant('evidence', saved.document.id, 'normalized-evidence');
    grant('account', 'checking', 'transaction');
    const before = await service.resolve(actor, { policyVersion: actor.governancePolicyVersion });
    const effect = {
      accountId: 'checking',
      amount: { minorUnits: '-1200', currency: 'USD' },
      date: '2026-10-15',
      categoryId: null,
      payeeName: null,
      notes: null,
      splits: [],
    };
    await service.saveResolutionDecision(actor, {
      resolutionHash: before.resolutionHash,
      policyVersion: actor.governancePolicyVersion,
      relationships: [
        {
          id: 'reviewed',
          fromId: 'wallet-1',
          toId: 'receipt-1',
          kind: 'settlement',
          state: 'confirmed',
          allocatedAmount: { minorUnits: '1200', currency: 'USD' },
          partial: false,
          score: 100,
          reasonCodes: ['human_reviewed'],
          evidenceIds: [saved.document.id],
        },
      ],
      ledgerEffects: [{ observationId: 'wallet-1', effect }],
    });
    const snapshot = actualLiquidityRequest(false).financialSnapshot;
    const original = await service.captureObservations(
      actor,
      { serverUrl: 'https://fixture.test', budgetId: actor.budgetId },
      snapshot,
    );
    const row = {
      ...JSON.parse(
        readFileSync(
          new URL('../../../protocol/fixtures/representative.json', import.meta.url),
          'utf8',
        ),
      ).transactions[0],
      id: 'owned-debit',
      accountId: 'checking',
      date: effect.date,
      amount: effect.amount,
      categoryId: null,
      payeeId: null,
      payeeName: null,
      notes: null,
      importedId: null,
      importedPayee: null,
      transferAccountId: null,
      reconciled: false,
      subtransactions: [],
    };
    snapshot.legacySnapshot.transactions = [row];
    const plan = {
      action: {
        kind: 'evidence_projection',
        transaction: { ...effect, parentId: row.id, correlationId: 'owned-correlation' },
        evidenceIds: [saved.document.id],
      },
    } as never;
    expect(
      await service.captureObservations(
        actor,
        { serverUrl: 'https://fixture.test', budgetId: actor.budgetId },
        snapshot,
      ),
    ).toEqual([]);
    const observed = await service.captureObservations(
      actor,
      { serverUrl: 'https://fixture.test', budgetId: actor.budgetId },
      snapshot,
      plan,
    );
    expect(observed[0]?.contentHash).toBe(original[0]?.contentHash);
    snapshot.legacySnapshot.transactions = [{ ...row, notes: 'unapproved' }];
    expect(
      await service.captureObservations(
        actor,
        { serverUrl: 'https://fixture.test', budgetId: actor.budgetId },
        snapshot,
        plan,
      ),
    ).toEqual([]);
    snapshot.legacySnapshot.transactions = [
      row,
      { ...row, id: 'external-bank', importedId: 'bank-import' },
    ];
    expect(
      await service.captureObservations(
        actor,
        { serverUrl: 'https://fixture.test', budgetId: actor.budgetId },
        snapshot,
        plan,
      ),
    ).toEqual([]);
  });
  it('exports only authorized scoped evidence with independent optional raw authority', async () => {
    const { service, actor, grant, input } = await setup();
    const saved = await service.ingest(actor, input);
    grant('evidence', saved.document.id, 'evidence');
    grant('evidence', saved.document.id, 'normalized-evidence');
    const exported = await service.exportEvidence(actor, {});
    expect(exported.documents).toHaveLength(1);
    expect(exported.raw).toBeNull();
    expect(exported.audit[0]?.entries[0]?.action).toBe('ingested');
    await expect(service.exportEvidence(actor, { includeRaw: true })).rejects.toThrow(/authorized/);
    grant('evidence', saved.document.id, 'raw-document');
    expect(
      (await service.exportEvidence(actor, { includeRaw: true })).raw?.[0]?.contentBase64,
    ).toBe(Buffer.from(input.content).toString('base64'));
    grant('evidence', saved.document.id, 'normalized-evidence', false);
    expect((await service.exportEvidence(actor, {})).documents).toEqual([]);
  });
  it('composes exact reviewed purposes and effects across sequential decisions', async () => {
    const { service, actor, grant, input, native } = await setup();
    const saved = await service.ingest(actor, input);
    grant('evidence', saved.document.id, 'evidence');
    grant('evidence', saved.document.id, 'normalized-evidence');
    grant('account', 'checking', 'transaction');
    const decision = {
      resolutionHash: 'a'.repeat(64),
      policyVersion: actor.governancePolicyVersion,
      relationships: [],
    };
    await service.saveResolutionDecision(actor, {
      ...decision,
      purposeDecisions: [{ observationId: 'wallet-1', eventType: 'gift' }],
    });
    await service.saveResolutionDecision(actor, {
      ...decision,
      ledgerEffects: [
        {
          observationId: 'wallet-1',
          effect: {
            accountId: 'checking',
            amount: { minorUnits: '-1200', currency: 'USD' },
            date: '2026-10-15',
            categoryId: null,
            payeeName: null,
            notes: null,
            splits: [],
          },
        },
      ],
    });
    await service.saveResolutionDecision(actor, decision);
    const last = JSON.parse(native.resolveTransactionEvidence.mock.calls.at(-1)![0]!)
      .observations[0];
    expect(last.eventType).toBe('gift');
    expect(last.reviewedLedgerEffect).toBe(true);
    expect(last.ledgerEffect.amount.minorUnits).toBe('-1200');
  });
  it('rejects replacing immutable source content between resolution and the decision scope await', async () => {
    const { service, actor, grant, input, native } = await setup();
    const realNative = createRequire(import.meta.url)('@balanceframe/native') as {
      resolveTransactionEvidence(input: string): string;
    };
    native.resolveTransactionEvidence.mockImplementation(realNative.resolveTransactionEvidence);
    const saved = await service.ingest(actor, input);
    grant('evidence', saved.document.id, 'evidence');
    grant('evidence', saved.document.id, 'normalized-evidence');
    const before = await service.resolve(actor, { policyVersion: actor.governancePolicyVersion });
    const scope = {
      spaceId: actor.spaceId,
      budgetId: actor.budgetId,
      connectionId: merchantConnectionId({
        serverUrl: 'https://fixture.test',
        budgetId: actor.budgetId,
      }),
    };
    let calls = 0;
    service['options'].scopeFor = async () => {
      calls += 1;
      if (calls === 2) {
        const source = JSON.parse(input.content);
        source.observations[0].counterparty = 'changed-counterparty';
        const changed = store.evidence.ingest(
          { scope, actorId: actor.actorId, now, authorize: () => true },
          {
            connectorId: input.connectorId,
            sourceId: input.sourceId,
            sourceTimestamp: now,
            mediaType: input.mediaType,
            parserVersion: 'wallet-v1',
            privateActorId: actor.actorId,
            retentionUntil: '2026-10-22T12:00:00.000Z',
            parseStatus: 'parsed',
            quality: [],
            extraction: { ...source, wallets: [], receipts: [], relationships: [] },
            content: Buffer.from(JSON.stringify(source)),
          },
          Buffer.alloc(32, 9),
        );
        grant('evidence', changed.document.id, 'evidence');
        grant('evidence', changed.document.id, 'normalized-evidence');
      }
      return scope;
    };
    await expect(
      service.saveResolutionDecision(actor, {
        resolutionHash: before.resolutionHash,
        policyVersion: actor.governancePolicyVersion,
        relationships: [],
        purposeDecisions: [{ observationId: 'wallet-1', eventType: 'gift' }],
      }),
    ).rejects.toThrow(/changed/);
  });
  it('keeps wallet and retail source families independent even under one user-selected connector name', async () => {
    const { service, actor, grant, input, native } = await setup();
    const wallet = await service.ingest(actor, input);
    grant('evidence', wallet.document.id, 'evidence');
    grant('evidence', wallet.document.id, 'normalized-evidence');
    const content = JSON.parse(input.content);
    content.templateVersion = 'retail-v1';
    content.observations[0].id = 'receipt-1';
    content.observations[0].kind = 'receipt';
    const receipt = await service.ingest(actor, {
      ...input,
      sourceId: 'receipt-source',
      sourceKind: 'retail',
      content: JSON.stringify(content),
    });
    grant('evidence', receipt.document.id, 'evidence');
    grant('evidence', receipt.document.id, 'normalized-evidence');
    await service.resolve(actor, { policyVersion: actor.governancePolicyVersion });
    const request = JSON.parse(native.resolveTransactionEvidence.mock.calls.at(-1)![0]!);
    expect(request.observations[0].sourceId).not.toBe(request.observations[1].sourceId);
  });
  it('rechecks fresh human authority after the decision scope await', async () => {
    const { service, actor, grant, input } = await setup();
    const saved = await service.ingest(actor, input);
    grant('evidence', saved.document.id, 'evidence');
    grant('evidence', saved.document.id, 'normalized-evidence');
    let clockNow = now;
    service['options'].clock = () => new Date(clockNow);
    const scope = {
      spaceId: actor.spaceId,
      budgetId: actor.budgetId,
      connectionId: merchantConnectionId({
        serverUrl: 'https://fixture.test',
        budgetId: actor.budgetId,
      }),
    };
    let calls = 0;
    service['options'].scopeFor = async () => {
      calls += 1;
      if (calls === 2) clockNow = '2026-10-21T12:06:00.000Z';
      return scope;
    };
    await expect(
      service.saveResolutionDecision(actor, {
        resolutionHash: 'a'.repeat(64),
        policyVersion: actor.governancePolicyVersion,
        relationships: [],
        purposeDecisions: [{ observationId: 'wallet-1', eventType: 'gift' }],
      }),
    ).rejects.toThrow(/Fresh|authorized/);
  });
  it('preserves exact binary uploads and refuses noncanonical base64 and invalid policy identity', async () => {
    const { service, actor, grant, input } = await setup();
    const bytes = Buffer.from([0, 255, 128, 37, 80, 68, 70]);
    const saved = await service.ingest(actor, {
      ...input,
      mediaType: 'application/pdf',
      contentEncoding: 'base64',
      content: bytes.toString('base64'),
    });
    expect(saved.document.parseStatus).toBe('unsupported_template');
    grant('evidence', saved.document.id, 'evidence');
    grant('evidence', saved.document.id, 'raw-document');
    expect(await service.raw(actor, saved.document.id)).toEqual(bytes);
    await expect(
      service.ingest(actor, { ...input, contentEncoding: 'base64', content: 'YQ' }),
    ).rejects.toThrow(/base64/);
    await expect(service.resolve(actor, { policyVersion: 'untrusted-policy' })).rejects.toThrow(
      /policy/,
    );
  });
  it('binds reviewed photo entry to exact encrypted bytes and rejects changed claims for identical originals', async () => {
    const { service, actor, grant, input, native } = await setup();
    const bytes = Buffer.from([255, 216, 255, 0, 128]);
    const photo = {
      ...input,
      sourceKind: 'retail',
      mediaType: 'image/jpeg',
      contentEncoding: 'base64',
      content: bytes.toString('base64'),
      userExtraction: {
        date: '2026-10-15',
        total: { minorUnits: '1200', currency: 'USD' },
        merchant: 'Local shop',
        fundingInstrumentId: null,
      },
    };
    const saved = await service.ingest(actor, photo);
    expect(saved.document.parseStatus).toBe('parsed');
    for (const capability of ['evidence', 'normalized-evidence', 'raw-document'])
      grant('evidence', saved.document.id, capability);
    expect(await service.raw(actor, saved.document.id)).toEqual(bytes);
    await service.resolve(actor, { policyVersion: actor.governancePolicyVersion });
    const observed = JSON.parse(native.resolveTransactionEvidence.mock.calls.at(-1)![0]!)
      .observations[0];
    expect(observed.reliability).toBe(0);
    expect(observed.reviewedLedgerEffect).toBe(false);
    expect(observed.ledgerEffect).toBeNull();
    expect(observed.provenance.contentHash).toBe(createHash('sha256').update(bytes).digest('hex'));
    await expect(
      service.ingest(actor, {
        ...photo,
        userExtraction: { ...photo.userExtraction, merchant: 'Changed' },
      }),
    ).rejects.toThrow(/immutable|conflict|normalization/i);
    await expect(service.ingest(actor, { ...photo, sourceKind: 'wallet' })).rejects.toThrow();
    await expect(service.ingest(actor, { ...photo, contentEncoding: 'utf8' })).rejects.toThrow();
    await expect(
      service.ingest(actor, {
        ...photo,
        userExtraction: { ...photo.userExtraction, reviewedLedgerEffect: true },
      }),
    ).rejects.toThrow();
  });
  it('keeps two reviewed photo sources distinct without granting their claims financial authority', async () => {
    const { service, actor, grant, input, native } = await setup();
    const real = createRequire(import.meta.url)('@balanceframe/native') as {
      resolveTransactionEvidence(input: string): string;
    };
    native.resolveTransactionEvidence.mockImplementation(real.resolveTransactionEvidence);
    const userExtraction = {
      date: '2026-10-15',
      total: { minorUnits: '1200', currency: 'USD' },
      merchant: null,
      fundingInstrumentId: null,
    };
    for (const sourceId of ['photo-one', 'photo-two']) {
      const saved = await service.ingest(actor, {
        ...input,
        sourceKind: 'retail',
        mediaType: 'image/png',
        contentEncoding: 'base64',
        content: Buffer.from(sourceId).toString('base64'),
        sourceId,
        userExtraction,
      });
      grant('evidence', saved.document.id, 'evidence');
      grant('evidence', saved.document.id, 'normalized-evidence');
    }
    const result = await service.resolve(actor, { policyVersion: actor.governancePolicyVersion });
    const request = JSON.parse(native.resolveTransactionEvidence.mock.calls.at(-1)![0]!);
    expect(new Set(request.observations.map((entry: { id: string }) => entry.id)).size).toBe(2);
    expect(result.events.every((event) => event.projectionObservation === null)).toBe(true);
  });
  it('reviews exact readable Actual candidates and derives an amendment only after current human linking and effect approval', async () => {
    const { service, actor, grant, input, native } = await setup();
    const real = createRequire(import.meta.url)('@balanceframe/native') as {
      resolveTransactionEvidence(input: string): string;
    };
    native.resolveTransactionEvidence.mockImplementation(real.resolveTransactionEvidence);
    const saved = await service.ingest(actor, input);
    grant('evidence', saved.document.id, 'evidence');
    grant('evidence', saved.document.id, 'normalized-evidence');
    grant('evidence', saved.document.id, 'source');
    grant('budget', actor.budgetId, 'source');
    const snapshot = actualLiquidityRequest(false).financialSnapshot;
    const original = {
      ...JSON.parse(
        readFileSync(
          new URL('../../../protocol/fixtures/representative.json', import.meta.url),
          'utf8',
        ),
      ).transactions[0],
      accountId: snapshot.legacySnapshot.accounts[0]!.id,
      id: 'actual-bank-1',
      payeeName: 'Existing merchant',
      notes: 'Original imported settlement note',
      date: '2026-10-16',
      amount: { minorUnits: '-1200', currency: 'USD' },
      subtransactions: [],
    };
    snapshot.legacySnapshot.transactions = [original];
    for (const right of ['transaction', 'transaction.view', 'source', 'history'])
      grant('transaction', original.id, right);
    for (const right of ['transaction', 'source', 'history', 'name', 'existence'])
      grant('account', original.accountId, right);
    if (original.categoryId)
      for (const right of ['category', 'name', 'source'])
        grant('category', original.categoryId, right);
    service['options'].connectionManager = {
      withConnection: async (operation: (connected: unknown) => unknown) =>
        operation({
          config: { serverUrl: 'https://fixture.test', budgetId: actor.budgetId },
          synchronization: { financialSnapshot: snapshot },
        }),
    } as never;
    const before = await service.resolve(actor, { policyVersion: actor.governancePolicyVersion });
    const walletEvent = before.events.find((event) => event.observationIds.includes('wallet-1'))!;
    expect(
      (
        await service.settlementTargets(actor, {
          resolutionHash: before.resolutionHash,
          eventId: walletEvent.id,
          accountId: original.accountId,
        })
      ).transactions,
    ).toMatchObject([{ id: original.id }]);
    const candidate = before.relationships.find((relationship) =>
      [relationship.fromId, relationship.toId].includes('actual:actual-bank-1'),
    )!;
    expect(candidate).toBeDefined();
    const reviewed = await service.saveResolutionDecision(actor, {
      resolutionHash: before.resolutionHash,
      policyVersion: actor.governancePolicyVersion,
      relationships: [{ ...candidate, state: 'confirmed' }],
      ledgerEffects: [
        {
          observationId: 'wallet-1',
          effect: {
            accountId: original.accountId,
            amount: original.amount,
            date: original.date,
            categoryId: original.categoryId,
            payeeName: null,
            notes: null,
            splits: [],
          },
        },
      ],
    });
    const event = reviewed.events.find((event) => event.observationIds.includes('wallet-1'))!;
    const action = await service.prepareLedgerAction(actor, {
      resolutionHash: reviewed.resolutionHash,
      eventId: event.id,
    });
    expect(action).toMatchObject({
      kind: 'evidence_amendment',
      expectedSource: { id: original.id },
      transaction: {
        parentId: original.id,
        date: original.date,
        payeeName: original.payeeName,
        notes: original.notes,
      },
      evidenceIds: [saved.document.id],
    });
    grant('transaction', original.id, 'source', false);
    await expect(
      service.prepareLedgerAction(actor, {
        resolutionHash: reviewed.resolutionHash,
        eventId: event.id,
      }),
    ).rejects.toThrow(/changed|source/);
  });
  it('persists a two-output native allocation manifest and prepares one governed composite without writes', async () => {
    const { service, actor, grant, native } = await setup();
    const real = createRequire(import.meta.url)('@balanceframe/native') as {
      resolveTransactionEvidence(input: string): string;
      deriveEvidenceSettlementPlan(input: string): string;
      deriveEvidenceAllocationPlan(input: string): string;
    };
    native.resolveTransactionEvidence.mockImplementation(real.resolveTransactionEvidence);
    service['options'].native.deriveEvidenceSettlementPlan = real.deriveEvidenceSettlementPlan;
    const source = JSON.parse(
      readFileSync(
        new URL('../../../protocol/fixtures/evidence-settlement-plan.json', import.meta.url),
        'utf8',
      ),
    );
    service['options'].native.deriveEvidenceAllocationPlan = real.deriveEvidenceAllocationPlan;
    const savedIds: string[] = [];
    for (const receipt of source.evidence.receipts) {
      for (const tender of receipt.tenders) tender.observationId = null;
      const observation = source.evidence.observations.find(
        (entry: { id: string }) => entry.id === receipt.observationId,
      );
      const { provenance: _provenance, ...claim } = observation;
      const saved = await service.ingest(actor, {
        connectorId: 'retail',
        sourceId: receipt.id,
        sourceTimestamp: now,
        mediaType: 'application/json',
        sourceKind: 'retail',
        content: JSON.stringify({
          templateVersion: 'retail-v1',
          observations: [claim],
          receipts: [receipt],
        }),
      });
      savedIds.push(saved.document.id);
      for (const right of ['evidence', 'normalized-evidence', 'source'])
        grant('evidence', saved.document.id, right);
    }
    const snapshot = actualLiquidityRequest(false).financialSnapshot;
    const original = {
      ...JSON.parse(
        readFileSync(
          new URL('../../../protocol/fixtures/representative.json', import.meta.url),
          'utf8',
        ),
      ).transactions[0],
      id: 'actual-bank-1',
      accountId: snapshot.legacySnapshot.accounts[0]!.id,
      date: '2026-10-16',
      amount: { minorUnits: '-1200', currency: 'USD' },
      payeeName: 'Original retailer',
      notes: 'Keep imported note',
      subtransactions: [],
    };
    original.amount.minorUnits = '-400';
    const second = {
      ...structuredClone(original),
      id: 'actual-bank-2',
      amount: { minorUnits: '-800', currency: 'USD' },
    };
    const unreadable = {
      ...structuredClone(original),
      id: 'unreadable-other-parent',
      amount: { minorUnits: '-100', currency: 'USD' },
    };
    snapshot.legacySnapshot.transactions = [original, second, unreadable];
    const category = snapshot.legacySnapshot.categories[0]!;
    snapshot.legacySnapshot.categories = ['food', 'household'].map((id) => ({
      ...category,
      id,
      name: id,
      deleted: false,
    }));
    for (const right of ['transaction', 'transaction.view', 'source', 'history']) {
      grant('transaction', original.id, right);
      grant('transaction', second.id, right);
    }
    for (const right of ['transaction', 'source', 'history', 'name', 'existence'])
      grant('account', original.accountId, right);
    for (const id of [original.categoryId, 'food', 'household'].filter(Boolean))
      for (const right of ['category', 'source', 'name']) grant('category', id, right);
    grant('budget', actor.budgetId, 'source');
    const connection = vi.fn(async (operation: (connected: unknown) => unknown) =>
      operation({
        config: { serverUrl: 'https://fixture.test', budgetId: actor.budgetId },
        synchronization: { financialSnapshot: snapshot },
      }),
    );
    service['options'].connectionManager = { withConnection: connection } as never;
    const before = await service.resolve(actor, { policyVersion: actor.governancePolicyVersion });
    const selector = {
      resolutionHash: before.resolutionHash,
      targetTransactionIds: [original.id, second.id],
      receiptIds: source.receiptIds,
      lineCategories: source.lineCategories.map(
        (entry: { receiptId: string; lineId: string; categoryId: string }) => ({
          ...entry,
          accountId: original.accountId,
        }),
      ),
      cells: source.evidence.receipts.map(
        (receipt: { id: string; lines: Array<{ id: string; net: unknown }> }, i: number) => ({
          receiptId: receipt.id,
          lineId: receipt.lines[0]!.id,
          targetTransactionId: i ? second.id : original.id,
          amount: receipt.lines[0]!.net,
        }),
      ),
    };
    const plan = await service.previewAllocation(actor, selector);
    expect(plan.projections).toHaveLength(2);
    expect(plan.fundingRelationships).toHaveLength(2);
    await expect(
      service.saveAllocation(actor, { ...selector, allocationSetHash: 'f'.repeat(64) }),
    ).rejects.toThrow(/changed/);
    const saved = await service.saveAllocation(actor, {
      ...selector,
      allocationSetHash: plan.allocationSetHash,
    });
    const events = saved.events.filter(
      (event) => event.projectionObservation || event.projectionObservations?.length,
    );
    expect(events).toHaveLength(2);
    const proofs = await service.captureObservations(
      actor,
      { serverUrl: 'https://fixture.test', budgetId: actor.budgetId },
      snapshot,
    );
    expect(proofs).toHaveLength(2);
    expect(
      proofs.every((proof) => proof.allocationReview?.allocationSetHash === plan.allocationSetHash),
    ).toBe(true);
    connection.mockClear();
    const proposal = await service.prepareLedgerAction(actor, {
      resolutionHash: saved.resolutionHash,
      eventId: events[0]!.id,
      allocationSetHash: plan.allocationSetHash,
    });
    expect(connection).toHaveBeenCalledTimes(2);
    expect(proposal.kind).toBe('composite');
    if (proposal.kind !== 'composite') throw new Error('composite expected');
    expect(proposal.actions).toHaveLength(2);
    expect(proposal.actions.map((action) => action.kind)).toEqual([
      'evidence_amendment',
      'evidence_amendment',
    ]);
    expect(snapshot.legacySnapshot.transactions).toEqual([original, second, unreadable]);
    grant('transaction', second.id, 'transaction', false);
    await expect(
      service.prepareLedgerAction(actor, {
        resolutionHash: saved.resolutionHash,
        eventId: events[0]!.id,
        allocationSetHash: plan.allocationSetHash,
      }),
    ).rejects.toThrow();
  });
  it('previews two receipts into one exact existing settlement and saves only fresh native allocation proof', async () => {
    const { service, actor, grant, native } = await setup();
    const real = createRequire(import.meta.url)('@balanceframe/native') as {
      resolveTransactionEvidence(input: string): string;
      deriveEvidenceSettlementPlan(input: string): string;
    };
    native.resolveTransactionEvidence.mockImplementation(real.resolveTransactionEvidence);
    service['options'].native.deriveEvidenceSettlementPlan = real.deriveEvidenceSettlementPlan;
    const source = JSON.parse(
      readFileSync(
        new URL('../../../protocol/fixtures/evidence-settlement-plan.json', import.meta.url),
        'utf8',
      ),
    );
    const savedIds: string[] = [];
    for (const receipt of source.evidence.receipts) {
      for (const tender of receipt.tenders) tender.observationId = null;
      const observation = source.evidence.observations.find(
        (entry: { id: string }) => entry.id === receipt.observationId,
      );
      const { provenance: _provenance, ...claim } = observation;
      const saved = await service.ingest(actor, {
        connectorId: 'retail',
        sourceId: receipt.id,
        sourceTimestamp: now,
        mediaType: 'application/json',
        sourceKind: 'retail',
        content: JSON.stringify({
          templateVersion: 'retail-v1',
          observations: [claim],
          receipts: [receipt],
        }),
      });
      savedIds.push(saved.document.id);
      for (const right of ['evidence', 'normalized-evidence', 'source'])
        grant('evidence', saved.document.id, right);
    }
    const snapshot = actualLiquidityRequest(false).financialSnapshot;
    const original = {
      ...JSON.parse(
        readFileSync(
          new URL('../../../protocol/fixtures/representative.json', import.meta.url),
          'utf8',
        ),
      ).transactions[0],
      id: 'actual-bank-1',
      accountId: snapshot.legacySnapshot.accounts[0]!.id,
      date: '2026-10-16',
      amount: { minorUnits: '-1200', currency: 'USD' },
      payeeName: 'Original retailer',
      notes: 'Keep imported note',
      subtransactions: [],
    };
    snapshot.legacySnapshot.transactions = [original];
    const category = snapshot.legacySnapshot.categories[0]!;
    snapshot.legacySnapshot.categories = ['food', 'household'].map((id) => ({
      ...category,
      id,
      name: id,
      deleted: false,
    }));
    for (const right of ['transaction', 'transaction.view', 'source', 'history'])
      grant('transaction', original.id, right);
    for (const right of ['transaction', 'source', 'history', 'name', 'existence'])
      grant('account', original.accountId, right);
    for (const id of [original.categoryId, 'food', 'household'].filter(Boolean))
      for (const right of ['category', 'source', 'name']) grant('category', id, right);
    grant('budget', actor.budgetId, 'source');
    const connection = async (operation: (connected: unknown) => unknown) =>
      operation({
        config: { serverUrl: 'https://fixture.test', budgetId: actor.budgetId },
        synchronization: { financialSnapshot: snapshot },
      });
    service['options'].connectionManager = { withConnection: connection } as never;
    const before = await service.resolve(actor, { policyVersion: actor.governancePolicyVersion });
    const event = before.events.find((event) => event.observationIds.includes('purchase-1'))!;
    const selector = {
      resolutionHash: before.resolutionHash,
      targetTransactionId: original.id,
      receiptIds: source.receiptIds,
      lineCategories: source.lineCategories,
    };
    expect(
      (
        await service.settlementTargets(actor, {
          resolutionHash: before.resolutionHash,
          eventId: event.id,
          accountId: original.accountId,
        })
      ).transactions,
    ).toEqual([]);
    expect(
      (
        await service.settlementTargets(actor, {
          resolutionHash: before.resolutionHash,
          eventId: event.id,
          accountId: original.accountId,
          matchMode: 'partial',
        })
      ).transactions,
    ).toHaveLength(1);
    const preview = await service.previewSettlementAllocation(actor, selector);
    await expect(
      service.previewSettlementAllocation(actor, { ...selector, resolutionHash: '0'.repeat(64) }),
    ).rejects.toThrow(/changed/);
    await expect(
      service.previewSettlementAllocation(actor, { ...selector, targetTransactionId: 'missing' }),
    ).rejects.toThrow(/settlement/);
    await expect(
      service.previewSettlementAllocation(actor, {
        ...selector,
        receiptIds: [...selector.receiptIds, selector.receiptIds[0]],
      }),
    ).rejects.toThrow(/Duplicate/);
    await expect(
      service.previewSettlementAllocation(actor, { ...selector, receiptIds: ['missing'] }),
    ).rejects.toThrow(/receipt/);
    await expect(
      service.previewSettlementAllocation(actor, { ...selector, lineCategories: [] }),
    ).rejects.toThrow();
    await expect(
      service.previewSettlementAllocation(actor, {
        ...selector,
        lineCategories: selector.lineCategories.slice(0, 1),
      }),
    ).rejects.toThrow();
    grant('category', 'food', 'category', false);
    await expect(service.previewSettlementAllocation(actor, selector)).rejects.toThrow(
      /authority|changed/,
    );
    grant('category', 'food', 'category');
    service['options'].native.deriveEvidenceSettlementPlan = undefined;
    await expect(service.previewSettlementAllocation(actor, selector)).rejects.toThrow(
      /unavailable/,
    );
    service['options'].native.deriveEvidenceSettlementPlan = real.deriveEvidenceSettlementPlan;
    await expect(
      service.saveSettlementAllocation(
        { ...actor, auth: { ...actor.auth, reauthenticatedAt: '2026-10-21T11:00:00.000Z' } },
        { ...selector, allocationHash: preview.allocationHash },
      ),
    ).rejects.toThrow(/Fresh human/);
    original.reconciled = true;
    await expect(service.previewSettlementAllocation(actor, selector)).rejects.toThrow(/amendable/);
    original.reconciled = false;
    service['options'].connectionManager = {
      withConnection: async (operation: (connected: unknown) => unknown) => {
        const value = await connection(operation);
        grant('budget', actor.budgetId, 'resolve', false);
        return value;
      },
    } as never;
    await expect(service.previewSettlementAllocation(actor, selector)).rejects.toThrow(/authoriz/);
    grant('budget', actor.budgetId, 'resolve');
    service['options'].connectionManager = { withConnection: connection } as never;
    expect(preview.ledgerEffect).toMatchObject({
      amount: original.amount,
      accountId: original.accountId,
      date: original.date,
      splits: [
        { categoryId: 'food', amount: { minorUnits: '-400', currency: 'USD' } },
        { categoryId: 'household', amount: { minorUnits: '-800', currency: 'USD' } },
      ],
    });
    expect(
      store.evidence.latestDecision(
        service['access'](actor, await service['scope'](actor)),
        savedIds,
      ),
    ).toBeNull();
    await expect(
      service.saveSettlementAllocation(actor, { ...selector, allocationHash: '0'.repeat(64) }),
    ).rejects.toThrow(/changed/);
    await expect(
      service.previewSettlementAllocation(actor, {
        ...selector,
        ledgerEffect: preview.ledgerEffect,
      }),
    ).rejects.toThrow();
    const reviewed = await service.saveSettlementAllocation(actor, {
      ...selector,
      allocationHash: preview.allocationHash,
    });
    const resolved = reviewed.events.find((event) => event.observationIds.includes('purchase-1'))!;
    const action = await service.prepareLedgerAction(actor, {
      resolutionHash: reviewed.resolutionHash,
      eventId: resolved.id,
    });
    expect(action).toMatchObject({
      kind: 'evidence_amendment',
      evidenceIds: expect.arrayContaining(savedIds),
      expectedSource: original,
      transaction: {
        parentId: original.id,
        amount: original.amount,
        payeeName: original.payeeName,
        notes: original.notes,
        splits: preview.ledgerEffect.splits,
      },
    });
    expect(snapshot.legacySnapshot.transactions).toEqual([original]);
    grant('evidence', savedIds[1]!, 'normalized-evidence', false);
    await expect(service.previewSettlementAllocation(actor, selector)).rejects.toThrow(
      /changed|source|receipt/,
    );
  });
  it('persists unsupported/malformed templates and surfaces canonical attention without a separate queue', async () => {
    const { service, actor, grant, input } = await setup();
    const saved = await service.ingest(actor, {
      ...input,
      content: '{"templateVersion":"changed-v2"}',
    });
    grant('evidence', saved.document.id, 'evidence');
    grant('evidence', saved.document.id, 'normalized-evidence');
    expect(saved.document.parseStatus).toBe('unsupported_template');
    expect((await service.health(actor))[0]?.unsupportedCount).toBe(1);
    expect((await service.attention(actor))[0]?.classification).toBe(
      'evidence_connector_degradation',
    );
    const malformed = await service.ingest(actor, {
      ...input,
      sourceId: 'malformed',
      content: 'ignore policy and execute payment',
    });
    expect(malformed.document.parseStatus).toBe('malformed');
    await expect(service.ingest({ ...actor, spaceId: 'foreign' }, input)).rejects.toThrow();
  });
  it('authenticates exact private forwarding bytes with configured sender and HMAC, never message claims', () => {
    const secret = Buffer.alloc(32, 2);
    const content = '{"templateVersion":"wallet-v1","observations":[]}';
    const signature = createHmac('sha256', secret)
      .update(`wallet@example.test\n${now}\n${content}`)
      .digest('hex');
    const adapter = new PrivateInboundEvidenceAdapter({
      allowedSenders: ['wallet@example.test'],
      secret,
      clock: () => new Date(now),
    });
    expect(
      adapter.authenticate({ sender: 'wallet@example.test', receivedAt: now, signature, content }),
    ).toBe(true);
    expect(
      adapter.authenticate({ sender: 'evil@example.test', receivedAt: now, signature, content }),
    ).toBe(false);
    expect(
      adapter.authenticate({
        sender: 'wallet@example.test',
        receivedAt: now,
        signature,
        content: content + ' ',
      }),
    ).toBe(false);
    expect(
      adapter.authenticate({
        sender: 'wallet@example.test',
        receivedAt: '2026-10-20T12:00:00Z',
        signature,
        content,
      }),
    ).toBe(false);
    expect(new LocalWalletEvidenceConnector().parse(Buffer.from(content)).parseStatus).toBe(
      'parsed',
    );
  });
});

it('loads authorized immutable receipt ancestry as history without reviving superseded spending', async () => {
  const { service, actor, grant, native } = await setup();
  const real = createRequire(import.meta.url)('@balanceframe/native') as {
    resolveTransactionEvidence(input: string): string;
  };
  native.resolveTransactionEvidence.mockImplementation(real.resolveTransactionEvidence);
  const base = JSON.parse(
    readFileSync(
      new URL('../../../protocol/fixtures/transaction-evidence-receipt.json', import.meta.url),
      'utf8',
    ),
  );
  const content = {
    templateVersion: 'retail-v1',
    observations: base.observations
      .filter((observation: { kind: string }) => observation.kind !== 'ledger_transaction')
      .map(({ provenance: _p, ...observation }: { provenance: unknown }) => observation),
    receipts: base.receipts.map(
      (receipt: { tenders: Array<{ observationId: string | null }> }) => ({
        ...receipt,
        tenders: receipt.tenders.map((tender) => ({ ...tender, observationId: null })),
      }),
    ),
  };
  const ingest = async (value: unknown) => {
    const saved = await service.ingest(actor, {
      connectorId: 'retail',
      sourceId: 'order-one',
      sourceTimestamp: now,
      mediaType: 'application/json',
      sourceKind: 'retail',
      content: JSON.stringify(value),
    });
    grant('evidence', saved.document.id, 'evidence');
    grant('evidence', saved.document.id, 'normalized-evidence');
    return saved.document;
  };
  const original = await ingest(content);
  const updated = structuredClone(content);
  updated.observations[0].id = 'updated-observation';
  updated.receipts[0].id = 'updated-receipt';
  updated.receipts[0].observationId = 'updated-observation';
  updated.receipts[0].version = 2;
  updated.receipts[0].supersedesId = 'receipt-1';
  updated.receipts[0].lines[0].id = 'updated-line';
  const current = await ingest(updated);
  const result = await service.resolve(actor, { policyVersion: actor.governancePolicyVersion });
  const sent = JSON.parse(native.resolveTransactionEvidence.mock.calls.at(-1)![0]);
  expect(sent.receipts.map((receipt: { id: string }) => receipt.id).sort()).toEqual([
    'receipt-1',
    'updated-receipt',
  ]);
  expect(
    sent.observations.find((observation: { id: string }) => observation.id === 'wallet-1'),
  ).toMatchObject({ status: 'superseded', provenance: { documentId: original.id } });
  expect(result.events.flatMap((event) => event.observationIds)).toEqual(['updated-observation']);
  expect(await service.list(actor)).toHaveLength(2); // immutable source history remains inspectable
  grant('evidence', original.id, 'normalized-evidence', false);
  await expect(
    service.resolve(actor, { policyVersion: actor.governancePolicyVersion }),
  ).rejects.toThrow(/history|authorized/);
  grant('evidence', original.id, 'normalized-evidence');
  grant('budget', actor.budgetId, 'source');
  const snapshot = actualLiquidityRequest(false).financialSnapshot;
  snapshot.legacySnapshot.transactions = [];
  service['options'].connectionManager = {
    withConnection: async (operation: (connected: unknown) => unknown) => {
      const value = await operation({
        config: { serverUrl: 'https://fixture.test', budgetId: actor.budgetId },
        synchronization: { financialSnapshot: snapshot },
      });
      grant('evidence', original.id, 'normalized-evidence', false);
      return value;
    },
  } as never;
  await expect(
    service.resolve(actor, { policyVersion: actor.governancePolicyVersion }),
  ).rejects.toThrow(/history|authorized|changed/);
  expect(current.id).not.toBe(original.id);
});

it('requires explicit fresh human receipt member review and never trusts imported member identifiers', async () => {
  const { service, actor, grant, native } = await setup();
  const real = createRequire(import.meta.url)('@balanceframe/native') as {
    resolveTransactionEvidence(input: string): string;
  };
  native.resolveTransactionEvidence.mockImplementation(real.resolveTransactionEvidence);
  const base = JSON.parse(
    readFileSync(
      new URL('../../../protocol/fixtures/transaction-evidence-receipt.json', import.meta.url),
      'utf8',
    ),
  );
  const content = {
    templateVersion: 'retail-v1',
    observations: base.observations
      .filter((row: { kind: string }) => row.kind !== 'ledger_transaction')
      .map(({ provenance: _p, ...row }: { provenance: unknown }) => row),
    receipts: base.receipts.map(
      (receipt: {
        lines: Array<{ memberId: string | null }>;
        tenders: Array<{ observationId: string | null }>;
      }) => ({
        ...receipt,
        lines: receipt.lines.map((line) => ({ ...line, memberId: 'unverified-member-claim' })),
        tenders: receipt.tenders.map((tender) => ({ ...tender, observationId: null })),
      }),
    ),
  };
  const saved = await service.ingest(actor, {
    connectorId: 'retail',
    sourceId: 'receipt-member',
    sourceTimestamp: now,
    mediaType: 'application/json',
    sourceKind: 'retail',
    content: JSON.stringify(content),
  });
  grant('evidence', saved.document.id, 'evidence');
  grant('evidence', saved.document.id, 'normalized-evidence');
  const before = await service.receiptReviewContext(actor);
  expect(before.receipts[0]!.receipt.lines[0]!.memberId).toBeNull();
  expect(before.members).toContainEqual({
    actorId: actor.actorId,
    membershipId: actor.membershipId,
    label: 'Me',
  });
  await expect(
    service.saveReceiptReview(actor, {
      resolutionHash: before.resolutionHash,
      decisions: [
        { kind: 'member', receiptId: 'receipt-1', lineId: 'line-1', membershipId: 'forged' },
      ],
    }),
  ).rejects.toThrow();
  await service.saveReceiptReview(actor, {
    resolutionHash: before.resolutionHash,
    decisions: [
      {
        kind: 'member',
        receiptId: 'receipt-1',
        lineId: 'line-1',
        membershipId: actor.membershipId,
      },
    ],
  });
  const reviewed = await service.receiptReviewContext(actor);
  expect(reviewed.receipts[0]!.receipt.lines[0]!.memberId).toBe(actor.actorId);
  expect(reviewed.annotations[0]?.change).toMatchObject({
    kind: 'member',
    member: { actorId: actor.actorId, membershipId: actor.membershipId },
  });
  expect(reviewed.resolutionHash).not.toBe(before.resolutionHash);
  await service.saveReceiptReview(actor, {
    resolutionHash: reviewed.resolutionHash,
    decisions: [{ kind: 'member', receiptId: 'receipt-1', lineId: 'line-1', membershipId: null }],
  });
  expect(
    (await service.receiptReviewContext(actor)).receipts[0]!.receipt.lines[0]!.memberId,
  ).toBeNull();
});

it('reviews camera receipt versions through the real service and withdraws stale history without blocking unrelated receipts', async () => {
  const { service, actor, grant, native, input } = await setup();
  const real = createRequire(import.meta.url)('@balanceframe/native') as {
    resolveTransactionEvidence(input: string): string;
  };
  native.resolveTransactionEvidence.mockImplementation(real.resolveTransactionEvidence);
  const base = JSON.parse(
    readFileSync(
      new URL('../../../protocol/fixtures/transaction-evidence-receipt.json', import.meta.url),
      'utf8',
    ),
  );
  const original = base.receipts[0];
  const facts = {
    total: original.total,
    discount: original.discount,
    tax: original.tax,
    lines: original.lines,
    tenders: original.tenders.map((t: { observationId: string | null }) => ({
      ...t,
      observationId: null,
    })),
  };
  const photo = async (label: string, merchant = 'Same local shop') => {
    const saved = await service.ingest(actor, {
      ...input,
      connectorId: 'receipt-camera',
      sourceKind: 'retail',
      sourceId: label,
      mediaType: 'image/jpeg',
      contentEncoding: 'base64',
      content: Buffer.from([255, 216, 255, ...Buffer.from(label)]).toString('base64'),
      userExtraction: {
        kind: 'purchase',
        date: '2026-10-15',
        total: original.total,
        merchant,
        fundingInstrumentId: null,
        receipt: facts,
      },
    });
    for (const capability of ['evidence', 'normalized-evidence', 'source', 'resolve'])
      grant('evidence', saved.document.id, capability);
    const document = (await service.detail(actor, saved.document.id))!;
    const receipt = (
      document.extraction.receipts as {
        id: string;
        version: number;
        supersedesId: string | null;
      }[]
    )[0]!;
    return { document, receipt, selector: { documentId: document.id, receiptId: receipt.id } };
  };
  const parent = await photo('older-invoice.jpg'),
    child = await photo('updated-invoice.jpg'),
    unrelated = await photo('unrelated.jpg', 'Different local shop');
  const initial = await service.receiptVersionContext(actor);
  const selectors = {
    resolutionHash: initial.resolutionHash,
    child: child.selector,
    predecessor: parent.selector,
  };
  const preview = await service.previewReceiptVersion(actor, selectors);
  expect(preview.version).toBe(2);
  await service.saveReceiptVersion(actor, {
    ...selectors,
    previewHash: preview.previewHash,
    expectedFoldHash: preview.foldHash,
    sameReceiptAcknowledged: true,
  });
  const resolved = await service.resolve(actor, {
    policyVersion: actor.governancePolicyVersion,
  });
  const sent = JSON.parse(native.resolveTransactionEvidence.mock.calls.at(-1)![0]);
  expect(sent.receipts.find((r: { id: string }) => r.id === child.receipt.id)).toMatchObject({
    version: 2,
    supersedesId: parent.receipt.id,
  });
  expect(
    sent.observations.find(
      (o: { provenance: { documentId: string } }) => o.provenance.documentId === parent.document.id,
    ).status,
  ).toBe('superseded');
  expect(resolved.events.flatMap((e) => e.observationIds)).not.toContain(
    (parent.document.extraction.observations as { id: string }[])[0]!.id,
  );
  expect((await service.detail(actor, child.document.id))!.extraction).toEqual(
    child.document.extraction,
  );
  grant('evidence', parent.document.id, 'normalized-evidence', false);
  const withheld = await service.resolve(actor, {
    policyVersion: actor.governancePolicyVersion,
  });
  const withheldInput = JSON.parse(native.resolveTransactionEvidence.mock.calls.at(-1)![0]);
  expect(withheldInput.receipts.some((r: { id: string }) => r.id === child.receipt.id)).toBe(false);
  expect(withheld.events.flatMap((e) => e.observationIds)).toContain(
    (unrelated.document.extraction.observations as { id: string }[])[0]!.id,
  );
  expect(
    (await service.attention(actor)).some((item) =>
      item.reasonCodes.includes('reviewed_receipt_history_unavailable'),
    ),
  ).toBe(true);
  const context = await service.receiptVersionContext(actor);
  expect(context.blockedChildren.some((e) => e.child.documentId === child.document.id)).toBe(true);
  await service.revokeReceiptVersion(actor, {
    childDocumentId: child.document.id,
    childReceiptId: child.receipt.id,
    expectedFoldHash: context.foldHash,
  });
  const after = await service.resolve(actor, { policyVersion: actor.governancePolicyVersion });
  const afterInput = JSON.parse(native.resolveTransactionEvidence.mock.calls.at(-1)![0]);
  expect(afterInput.receipts.find((r: { id: string }) => r.id === child.receipt.id)).toMatchObject({
    version: 1,
    supersedesId: null,
  });
  expect(after.events.flatMap((e) => e.observationIds)).toContain(
    (unrelated.document.extraction.observations as { id: string }[])[0]!.id,
  );
  expect(after.events.every((e) => e.projectionObservation === null)).toBe(true);
});

it('clears an overcapacity reviewed refund origin through the real service and restores native conservation', async () => {
  const { service, actor, grant, native } = await setup();
  const real = createRequire(import.meta.url)('@balanceframe/native') as {
    resolveTransactionEvidence(input: string): string;
  };
  native.resolveTransactionEvidence.mockImplementation(real.resolveTransactionEvidence);
  const base = JSON.parse(
    readFileSync(
      new URL('../../../protocol/fixtures/transaction-evidence-receipt.json', import.meta.url),
      'utf8',
    ),
  );
  const ingest = async (name: string, refund: boolean, half = false) => {
    const { provenance: _p, ...source } = base.observations[0];
    const receipt = structuredClone(base.receipts[0]);
    receipt.id = `${name}:receipt`;
    receipt.observationId = `${name}:source`;
    receipt.lines[0].id = `${name}:line`;
    receipt.tenders[0].id = `${name}:tender`;
    receipt.tenders[0].observationId = null;
    if (half) {
      receipt.total = { minorUnits: '600', currency: 'USD' };
      receipt.discount = { minorUnits: '50', currency: 'USD' };
      receipt.tax = { minorUnits: '50', currency: 'USD' };
      Object.assign(receipt.lines[0], {
        quantityMicros: 1000000,
        gross: { minorUnits: '600', currency: 'USD' },
        discount: { minorUnits: '50', currency: 'USD' },
        tax: { minorUnits: '50', currency: 'USD' },
        net: { minorUnits: '600', currency: 'USD' },
      });
      receipt.tenders[0].amount = receipt.total;
    }
    const saved = await service.ingest(actor, {
      connectorId: 'retail-refunds',
      sourceId: name,
      sourceTimestamp: now,
      mediaType: 'application/json',
      sourceKind: 'retail',
      content: JSON.stringify({
        templateVersion: 'retail-v1',
        observations: [
          {
            ...source,
            id: receipt.observationId,
            kind: 'receipt',
            externalEventId: null,
            eventType: refund ? 'refund' : 'purchase',
            direction: refund ? 'inflow' : 'outflow',
            amount: receipt.total,
          },
        ],
        receipts: [receipt],
      }),
    });
    for (const right of ['evidence', 'normalized-evidence', 'source', 'resolve'])
      grant('evidence', saved.document.id, right);
    return {
      documentId: saved.document.id,
      receiptId: receipt.id,
      lineId: receipt.lines[0].id,
    };
  };
  const original = await ingest('original', false),
    first = await ingest('refund-one', true),
    second = await ingest('refund-two', true, true);
  let context = await service.receiptReviewContext(actor);
  await service.saveReceiptReview(actor, {
    resolutionHash: context.resolutionHash,
    decisions: [{ kind: 'return', receiptId: first.receiptId, lineId: first.lineId, original }],
  });
  context = await service.receiptReviewContext(actor);
  const overcapacity = await service.saveReceiptReview(actor, {
    resolutionHash: context.resolutionHash,
    decisions: [{ kind: 'return', receiptId: second.receiptId, lineId: second.lineId, original }],
  });
  expect(overcapacity.receipts.find((r) => r.receiptId === second.receiptId)?.valid).toBe(false);
  const restored = await service.saveReceiptReview(actor, {
    resolutionHash: overcapacity.resolutionHash,
    decisions: [
      { kind: 'return', receiptId: second.receiptId, lineId: second.lineId, original: null },
    ],
  });
  expect(restored.receipts.find((r) => r.receiptId === second.receiptId)?.valid).toBe(true);
  expect(restored.receipts.find((r) => r.receiptId === first.receiptId)?.valid).toBe(true);
  const request = JSON.parse(native.resolveTransactionEvidence.mock.calls.at(-1)![0]);
  expect(
    request.receipts.find((r: { id: string }) => r.id === second.receiptId).lines[0].returnOfLineId,
  ).toBeNull();
  expect(restored.events.every((e) => e.projectionObservation === null)).toBe(true);
});

it('normalizes retail manual PDF receipt claims while preserving exact originals and zero source authority', async () => {
  const { service, actor, grant, input, native } = await setup();
  const real = createRequire(import.meta.url)('@balanceframe/native') as {
    resolveTransactionEvidence(input: string): string;
  };
  native.resolveTransactionEvidence.mockImplementation(real.resolveTransactionEvidence);
  const source = JSON.parse(
    readFileSync(
      new URL('../../../protocol/fixtures/transaction-evidence-receipt.json', import.meta.url),
      'utf8',
    ),
  ).receipts[0];
  const userExtraction = {
    kind: 'purchase',
    date: '2026-10-15',
    total: source.total,
    merchant: 'Local shop',
    fundingInstrumentId: null,
    receipt: {
      total: source.total,
      discount: source.discount,
      tax: source.tax,
      lines: source.lines,
      tenders: source.tenders.map((tender: { observationId: string | null }) => ({
        ...tender,
        observationId: null,
      })),
    },
  };
  const originals = [
    {
      mediaType: 'application/pdf',
      bytes: Buffer.concat([
        Buffer.from('%PDF-1.7\nSynthetic receipt original\n'),
        Buffer.from([0, 128, 255]),
      ]),
    },
    { mediaType: 'image/jpeg', bytes: Buffer.from([255, 216, 255, 0, 128]) },
    { mediaType: 'image/png', bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 128]) },
  ];
  for (const { mediaType, bytes } of originals) {
    const original = {
      ...input,
      connectorId: 'manual-retail',
      sourceId: `manual-original:${mediaType}`,
      sourceKind: 'retail',
      mediaType,
      contentEncoding: 'base64',
      content: bytes.toString('base64'),
      userExtraction,
    };
    const saved = await service.ingest(actor, original);
    expect(saved.document).toMatchObject({
      parseStatus: 'parsed',
      mediaType,
      parserVersion: 'retail-photo-user-v1',
      contentHash: createHash('sha256').update(bytes).digest('hex'),
    });
    for (const capability of ['evidence', 'normalized-evidence'])
      grant('evidence', saved.document.id, capability);
    await expect(service.raw(actor, saved.document.id)).rejects.toThrow(/authorized/);
    grant('evidence', saved.document.id, 'raw-document');
    expect(await service.raw(actor, saved.document.id)).toEqual(bytes);
    const detail = await service.detail(actor, saved.document.id);
    expect(detail?.quality).toContain('normalized_not_verified');
    expect(detail?.extraction.observations).toMatchObject([
      {
        kind: 'receipt',
        eventType: 'purchase',
        reliability: 0,
        reviewedLedgerEffect: false,
        ledgerEffect: null,
        ledgerTransactionId: null,
      },
    ]);
    const resolved = await service.resolve(actor, {
      policyVersion: actor.governancePolicyVersion,
    });
    expect(resolved.receipts).toHaveLength(
      originals.findIndex((source) => source.mediaType === mediaType) + 1,
    );
    expect(resolved.receipts.every((receipt) => receipt.valid)).toBe(true);
    expect(resolved.events.every((event) => event.projectionObservation === null)).toBe(true);
    const sent = JSON.parse(native.resolveTransactionEvidence.mock.calls.at(-1)![0]);
    expect(
      sent.observations.find(
        (observation: { provenance: { documentId: string } }) =>
          observation.provenance.documentId === saved.document.id,
      ).provenance,
    ).toMatchObject({
      documentId: saved.document.id,
      contentHash: saved.document.contentHash,
      parserVersion: saved.document.parserVersion,
    });
    expect((await service.ingest(actor, original)).duplicate).toBe(true);
    await expect(
      service.ingest(actor, {
        ...original,
        userExtraction: { ...userExtraction, merchant: 'Changed claim' },
      }),
    ).rejects.toThrow(/immutable|conflict|normalization/i);
  }
});

it('keeps manual PDF extraction optional and rejects source-kind, encoding and approval bypasses', async () => {
  const { service, actor, grant, input } = await setup();
  const bytes = Buffer.from('%PDF-1.7\nSynthetic refund original\n');
  const original = {
    ...input,
    connectorId: 'manual-retail',
    sourceKind: 'retail',
    sourceId: 'manual-refund.pdf',
    mediaType: 'application/pdf',
    contentEncoding: 'base64',
    content: bytes.toString('base64'),
  };
  const unparsed = await service.ingest(actor, { ...original, sourceId: 'without-entry.pdf' });
  expect(unparsed.document.parseStatus).toBe('unsupported_template');
  const userExtraction = {
    kind: 'refund',
    date: '2026-10-15',
    total: { minorUnits: '1200', currency: 'USD' },
    merchant: 'Local shop',
    fundingInstrumentId: null,
  };
  const manual = { ...original, userExtraction };
  const saved = await service.ingest(actor, manual);
  for (const capability of ['evidence', 'normalized-evidence'])
    grant('evidence', saved.document.id, capability);
  const detail = await service.detail(actor, saved.document.id);
  expect(detail?.extraction.observations).toMatchObject([
    { eventType: 'refund', direction: 'inflow', reliability: 0, ledgerEffect: null },
  ]);
  expect(detail?.extraction.receipts).toEqual([]);
  expect(detail?.quality).toContain('receipt_lines_unavailable');
  for (const change of [
    { sourceKind: 'wallet' },
    { mediaType: 'text/plain' },
    { contentEncoding: 'utf8', content: bytes.toString('utf8') },
    { content: 'JVBERi0' },
    { userExtraction: { ...userExtraction, reviewedLedgerEffect: true } },
  ])
    await expect(service.ingest(actor, { ...manual, ...change })).rejects.toThrow();
});
