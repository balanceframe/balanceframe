import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { extractReceiptPhoto } from '../../../../apps/web/server/utils/receipt-ocr.js';
import { SCENARIO_CATALOG_VERSION } from '../../src/catalog.js';
import { createEvidenceFaultFixture } from './evidence-fault-fixture.js';

function reportFault(faultId: string): void {
  const { currentTestName, assertionCalls } = expect.getState();
  if (!currentTestName || assertionCalls < 1)
    throw new Error('Named behavioral assertions required');
  console.log(
    JSON.stringify({
      type: 'fault-verification',
      catalogVersion: SCENARIO_CATALOG_VERSION,
      faultId,
      anchor: '2026-10-21T12:00:00.000Z',
      status: 'passed',
      assertions: { name: currentTestName, count: assertionCalls },
      evidence: { backend: 'synthetic-evidence-service-fault', actualWrite: false },
    }),
  );
}

describe('synthetic evidence service faults (no network providers or Actual server)', () => {
  it.each(['absent', 'failing'] as const)(
    'photo-ocr-%s retains exact original and manual claims without ledger authority',
    async (mode) => {
      const fixture = await createEvidenceFaultFixture();
      try {
        const assets = JSON.parse(
          readFileSync(
            new URL(
              '../../../../protocol/fixtures/scenarios/evidence-receipt-assets.json',
              import.meta.url,
            ),
            'utf8',
          ),
        ) as { jpegBase64: string };
        const bytes = Buffer.from(assets.jpegBase64, 'base64');
        const input = { mediaType: 'image/jpeg' as const, contentBase64: bytes.toString('base64') };
        let requests = 0;
        const result = await extractReceiptPhoto(input, {
          ...(mode === 'failing' ? { endpoint: 'http://receipt-ocr/' } : {}),
          request: async () => {
            requests += 1;
            return new Response('', { status: 503 });
          },
        });
        expect(result).toEqual({
          state: 'unavailable',
          reason: mode === 'absent' ? 'not_configured' : 'unreachable',
        });
        expect(requests).toBe(mode === 'absent' ? 0 : 1);
        const imported = await fixture.evidence.ingest(fixture.actor, {
          connectorId: 'retail',
          sourceId: `manual-photo-${mode}`,
          sourceTimestamp: fixture.now(),
          sourceKind: 'retail',
          mediaType: input.mediaType,
          contentEncoding: 'base64',
          content: input.contentBase64,
          userExtraction: {
            date: '2026-10-15',
            total: { minorUnits: '1200', currency: 'USD' },
            merchant: 'Local shop',
            fundingInstrumentId: null,
          },
        });
        fixture.grantEvidence(imported.document.id);
        expect(imported.document.parseStatus).toBe('parsed');
        expect(await fixture.evidence.raw(fixture.actor, imported.document.id)).toEqual(bytes);
        expect(imported.document.contentHash).toBe(
          createHash('sha256').update(bytes).digest('hex'),
        );
        const resolution = await fixture.evidence.resolve(fixture.actor, {
          policyVersion: fixture.actor.governancePolicyVersion,
        });
        const document = await fixture.evidence.detail(fixture.actor, imported.document.id);
        expect(document?.extraction).toMatchObject({
          observations: [
            {
              date: '2026-10-15',
              amount: { minorUnits: '1200', currency: 'USD' },
              counterparty: 'Local shop',
              reviewedLedgerEffect: false,
              ledgerEffect: null,
              reliability: 0,
            },
          ],
        });
        expect(resolution.events).toHaveLength(1);
        expect(
          resolution.events.every(
            (event) => !event.projectionObservation && !event.projectionObservations?.length,
          ),
        ).toBe(true);
        await expect(
          fixture.evidence.ingest(fixture.actor, {
            connectorId: 'retail',
            sourceId: `manual-photo-${mode}`,
            sourceTimestamp: fixture.now(),
            sourceKind: 'retail',
            mediaType: input.mediaType,
            contentEncoding: 'base64',
            content: input.contentBase64,
            userExtraction: {
              date: '2026-10-15',
              total: { minorUnits: '1201', currency: 'USD' },
              merchant: 'Changed',
              fundingInstrumentId: null,
            },
          }),
        ).rejects.toThrow(/immutable|conflict|normalization/i);
        expect(fixture.writes).toEqual([]);
        reportFault(`evidence-photo-ocr-${mode}-manual`);
      } finally {
        await fixture.close();
      }
    },
  );

  it('plural-amendment-lost-ack preserves exact approved parents and recovers read-only after durable reopen', async () => {
    const fixture = await createEvidenceFaultFixture();
    try {
      const matrix = await fixture.prepareMatrix();
      expect(matrix.action.kind).toBe('composite');
      expect(matrix.preview.projections).toHaveLength(2);
      expect(matrix.preview.review.cells).toHaveLength(4);
      const before = await fixture.captureParents();
      const proposed = await fixture.consequential.propose(fixture.actor, {
        action: matrix.action,
      });
      expect(fixture.writes).toEqual([]);
      await expect(fixture.consequential.execute(fixture.actor, proposed.id)).rejects.toThrow();
      const originalProposal = await fixture.store.getProposal(proposed.id);
      expect(proposed.requiredApprovers).toBe(1);
      await fixture.approve(proposed.id);
      fixture.loseAmendmentAcknowledgement();
      expect((await fixture.consequential.execute(fixture.actor, proposed.id)).phase).toBe(
        'review_required',
      );
      expect(fixture.writes).toHaveLength(2);
      const after = await fixture.captureParents();
      for (const [index, source] of after.entries()) {
        const {
          category: _bc,
          is_parent: _bp,
          is_child: _bi,
          subtransactions: _bs,
          error: _be,
          ...immutableBefore
        } = before[index]!.parent;
        const {
          category: _ac,
          is_parent: _ap,
          is_child: _ai,
          subtransactions: _as,
          error: _ae,
          ...immutableAfter
        } = source.parent;
        expect(immutableAfter).toEqual(immutableBefore);
      }
      expect(after.map((source) => source.transaction.id)).toEqual([
        'actual-bank-1',
        'actual-bank-2',
      ]);
      expect(after.map((source) => source.transaction.amount.minorUnits)).toEqual(['-700', '-500']);
      expect(after.map((source) => source.transaction.importedId)).toEqual([
        'synthetic-import-0',
        'synthetic-import-1',
      ]);
      expect(after.map((source) => source.children.map((child) => child.amount))).toEqual([
        [-400, -300],
        [-200, -300],
      ]);
      expect((await fixture.consequential.reconcile(fixture.actor, proposed.id)).phase).toBe(
        'review_required',
      );
      await fixture.reopenAfterExpiry(proposed.id);
      fixture.changeReadback(true);
      expect((await fixture.consequential.reconcile(fixture.actor, proposed.id)).phase).toBe(
        'review_required',
      );
      expect(fixture.writes).toHaveLength(2);
      fixture.changeReadback(false);
      const persisted = await fixture.store.getProposal(proposed.id);
      expect(persisted?.payloadHash).toBe(proposed.payloadHash);
      expect(persisted?.payload).toEqual(originalProposal?.payload);
      const recovered = await fixture.consequential.reconcile(fixture.actor, proposed.id);
      expect(
        recovered.phase,
        JSON.stringify((await fixture.store.getProposal(proposed.id))?.state),
      ).toBe('verified');
      expect((await fixture.consequential.execute(fixture.actor, proposed.id)).phase).toBe(
        'verified',
      );
      expect(await fixture.captureParents()).toEqual(after);
      expect(fixture.writes).toHaveLength(2);
      reportFault('evidence-plural-amendment-lost-ack');
    } finally {
      await fixture.close();
    }
  });

  it('wallet-opening-lost-ack recovers exact nonzero native equity without a duplicate account', async () => {
    const fixture = await createEvidenceFaultFixture();
    try {
      const action = await fixture.prepareWallet();
      const proposed = await fixture.consequential.propose(fixture.actor, { action });
      await fixture.approve(proposed.id);
      fixture.loseOpeningAcknowledgement();
      expect((await fixture.consequential.execute(fixture.actor, proposed.id)).phase).toBe(
        'review_required',
      );
      const after = await fixture.captureOpening();
      expect(after).toMatchObject({
        amount: { minorUnits: '1200', currency: 'USD' },
        date: '2026-10-01',
        startingBalance: true,
      });
      expect(fixture.accountCount()).toBe(2);
      expect(fixture.writes).toHaveLength(2);
      await fixture.reopenAfterExpiry(proposed.id);
      expect((await fixture.consequential.reconcile(fixture.actor, proposed.id)).phase).toBe(
        'verified',
      );
      expect((await fixture.consequential.execute(fixture.actor, proposed.id)).phase).toBe(
        'verified',
      );
      expect(await fixture.captureOpening()).toEqual(after);
      expect(fixture.accountCount()).toBe(2);
      expect(fixture.writes).toHaveLength(2);
      reportFault('evidence-wallet-opening-lost-ack');
    } finally {
      await fixture.close();
    }
  });

  it.each(['consent', 'source', 'policy', 'grant'] as const)(
    'receipt-inference-%s withholds a held late result and preserves manual fallback',
    async (mutation) => {
      const fixture = await createEvidenceFaultFixture({ inference: true });
      try {
        const selection = await fixture.prepareInference();
        expect(
          await fixture.evidence.receiptInferencePreview(fixture.actor, selection),
        ).toMatchObject({ state: 'manual' });
        await fixture.enableInference();
        const preview = await fixture.evidence.receiptInferencePreview(fixture.actor, selection);
        if (preview.state !== 'preview') throw new Error('Exact minimized preview required');
        expect(JSON.stringify(preview.payload)).not.toMatch(
          /checking|receipt-1|line-1|card-1|person-1|minorUnits|amount|rawDescription|food/,
        );
        expect(fixture.providerCalls()).toBe(0);
        await expect(
          fixture.evidence.receiptInferenceRun(fixture.actor, {
            previewId: preview.previewId,
            payloadHash: '0'.repeat(64),
          }),
        ).rejects.toThrow();
        expect(fixture.providerCalls()).toBe(0);
        const held = fixture.holdInference();
        const pending = fixture.evidence.receiptInferenceRun(fixture.actor, {
          previewId: preview.previewId,
          payloadHash: preview.payloadHash,
        });
        await held.dispatched;
        expect(fixture.dispatchedPayload()).toEqual(preview.payload);
        await fixture.revokeInference(mutation, preview);
        held.release();
        expect(await pending).toMatchObject({ state: 'manual' });
        await expect(
          fixture.evidence.receiptInferenceRun(fixture.actor, {
            previewId: preview.previewId,
            payloadHash: preview.payloadHash,
          }),
        ).rejects.toThrow();
        expect(fixture.providerCalls()).toBe(1);
        expect(fixture.externalCalls()).toBe(0);
        expect(fixture.writes).toEqual([]);
        reportFault(`evidence-receipt-inference-late-${mutation}`);
      } finally {
        await fixture.close();
      }
    },
  );
});
