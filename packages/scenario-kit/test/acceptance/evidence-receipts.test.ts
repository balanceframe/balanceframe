import { downloadBudget, getAccountBalance, getTransactions, init, shutdown } from '@actual-app/api';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GovernanceResourceKind } from '@balanceframe/workflow-store';
import type { LoadedScenario } from '../../src/loader.js';
import { evidenceFixture } from '../../src/evidence-scenario-support.js';
import { scenarioRequest, withScenario } from './support.js';

type ObjectValue = Record<string, unknown>;
type Envelope<T> = { status: string; result: T };
type Receipt = { id: string; fulfillmentGroupId: string | null; lines: Array<{ id: string; memberId: string | null; returnOfLineId: string | null }> };
type Context = { resolutionHash: string; receipts: Array<{ documentId: string; receipt: Receipt; valid: boolean }>; annotations: unknown[]; members: Array<{ actorId: string; membershipId: string }> };
type Resolution = { resolutionHash: string; receipts: Array<{ receiptId: string; valid: boolean; reasonCodes?: string[] }>; events: Array<{ id: string; projectionObservation?: unknown; projectionObservations?: unknown[] }> };
type Grant = { resourceKind: GovernanceResourceKind; resourceId: string; capability: string };
type PublicProposal = { payloadHash: string; requiredApprovers: number; canApprove: boolean; canExecute: boolean; payload: { plan: { action: { kind: string; actions: Array<{ kind: string }> }; allocationReviews?: unknown[] } } };
const timeout = 240_000;
const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
function result<T>(response: { status: number; body: unknown }, label: string): T {
  expect(response.status, `${label}: ${JSON.stringify(response.body)}`).toBe(200);
  const envelope = response.body as Envelope<T>;
  expect(envelope.status, label).toBe('ok');
  expect(envelope.result, label).toBeDefined();
  return envelope.result;
}
async function request<T>(handle: LoadedScenario, path: string, body?: unknown, personaId = 'owner'): Promise<T> {
  return result<T>(await scenarioRequest(handle, path, { personaId, ...(body === undefined ? {} : { method: 'POST', body }) }), path);
}
function ids(handle: LoadedScenario): Readonly<Record<string, string>> {
  if (!handle.initialized.evidence) throw new Error('Receipt scenario evidence was not initialized');
  return handle.initialized.evidence;
}
async function grant(handle: LoadedScenario, personaId: string, value: Grant, granted = true): Promise<void> {
  const persona = handle.initialized.personas[personaId];
  if (!persona) throw new Error(`Missing persona ${personaId}`);
  result(await scenarioRequest(handle, `/api/spaces/${handle.initialized.spaceId}/grants`, {
    method: 'PUT', body: { membershipId: persona.membershipId, resourceKind: value.resourceKind, resourceId: value.resourceId, capability: value.capability, granted },
  }), `${personaId} exact ${value.capability} grant`);
}
async function snapshot(handle: LoadedScenario): Promise<{ rows: ObjectValue[]; balance: number }> {
  const dataDir = mkdtempSync(join(handle.processes.root, 'receipt-acceptance-'));
  let active = false;
  try {
    await init({ serverURL: handle.processes.actualUrl, password: handle.processes.actualSecretKey, dataDir }); active = true;
    await downloadBudget(handle.seeded.groupId);
    const accountId = handle.seeded.accountIds['acct-checking']!;
    return { rows: await getTransactions(accountId, '1900-01-01', '2999-12-31') as unknown as ObjectValue[], balance: await getAccountBalance(accountId) };
  } finally { try { if (active) await shutdown(); } finally { rmSync(dataDir, { recursive: true, force: true }); } }
}
function receipt(context: Context, id: string): Receipt {
  const selected = context.receipts.find((entry) => entry.receipt.id === id);
  if (!selected) throw new Error(`Current receipt ${id} unavailable`);
  return selected.receipt;
}
async function review(handle: LoadedScenario, decisions: unknown[]): Promise<Resolution> {
  const current = await request<Resolution>(handle, '/api/evidence/resolve', {});
  return request<Resolution>(handle, '/api/evidence/receipt-review', { resolutionHash: current.resolutionHash, decisions });
}
describe('receipt evidence executable scenarios', () => {
  it('evidence-receipt-intake', { timeout }, async () => {
    await withScenario('evidence-receipt-intake', async (handle) => {
      const evidence = ids(handle), before = await snapshot(handle);
      const documents = await request<{ documents: Array<{ id: string; mediaType: string; parseStatus: string; quality: string[]; extraction: { observations?: Array<{ reliability: number; reviewedLedgerEffect?: boolean }>; receipts?: unknown[] } }> }>(handle, '/api/evidence');
      expect(documents.documents).toHaveLength(4);
      for (const documentId of [evidence.photoDocumentId, evidence.pdfDocumentId]) {
        const document = documents.documents.find((entry) => entry.id === documentId)!;
        expect(document.parseStatus).toBe('parsed');
        expect(document.quality).toContain('normalized_not_verified');
        expect(document.extraction.observations).toMatchObject([{ reliability: 0, reviewedLedgerEffect: false }]);
      }
      expect(documents.documents.find((entry) => entry.id === evidence.unparsedDocumentId)).toMatchObject({ parseStatus: 'unsupported_template', quality: ['document_extraction_unavailable'] });
      const assets = evidenceFixture('scenarios/evidence-receipt-assets') as { jpegBase64: string };
      expect(await request(handle, '/api/evidence/extract-photo', { mediaType: 'image/jpeg', contentBase64: assets.jpegBase64 })).toEqual({ state: 'unavailable', reason: 'not_configured' });
      const resolved = await request<Resolution>(handle, '/api/evidence/resolve', {});
      expect(resolved.receipts.find((entry) => entry.receiptId === evidence.photoReceiptId)?.valid).toBe(true);
      expect(resolved.receipts.find((entry) => entry.receiptId === evidence.mismatchReceiptId)?.valid).toBe(false);
      const wrong = await scenarioRequest(handle, `/api/evidence/${encodeURIComponent(evidence.photoDocumentId!)}`, { personaId: 'restricted' });
      expect(wrong.status === 403 || wrong.status === 409 || (wrong.body as Envelope<{ document: unknown }>).result?.document === null).toBe(true);
      const raw = await request<{ contentBase64: string }>(handle, `/api/evidence/${encodeURIComponent(evidence.photoDocumentId!)}/raw`);
      expect(raw.contentBase64).toBe(assets.jpegBase64);
      expect(await snapshot(handle)).toEqual(before);
    }, { branches: ['manual-photo-pdf-unverified', 'ocr-absent-manual-fallback', 'receipt-total-mismatch', 'receipt-source-scope-denied'] });
  });
  it('evidence-plural-allocation', { timeout }, async () => {
    await withScenario('evidence-plural-allocation', async (handle) => {
      const evidence = ids(handle), before = await snapshot(handle);
      const accountId = handle.seeded.accountIds['acct-checking']!;
      const categories = [handle.seeded.categoryIds['cat-groceries']!, handle.seeded.categoryIds['cat-household']!];
      const targets = [evidence.targetOneId!, evidence.targetTwoId!];
      const current = await request<Resolution>(handle, '/api/evidence/resolve', {});
      const selection = {
        resolutionHash: current.resolutionHash, targetTransactionIds: targets, receiptIds: [evidence.receiptId],
        lineCategories: [evidence.lineOneId, evidence.lineTwoId].map((lineId, i) => ({ receiptId: evidence.receiptId, lineId, accountId, categoryId: categories[i] })),
        cells: [
          { receiptId: evidence.receiptId, lineId: evidence.lineOneId, targetTransactionId: targets[0], amount: usd('400') },
          { receiptId: evidence.receiptId, lineId: evidence.lineOneId, targetTransactionId: targets[1], amount: usd('200') },
          { receiptId: evidence.receiptId, lineId: evidence.lineTwoId, targetTransactionId: targets[0], amount: usd('300') },
          { receiptId: evidence.receiptId, lineId: evidence.lineTwoId, targetTransactionId: targets[1], amount: usd('300') },
        ],
      };
      const preview = await request<{ allocationSetHash: string; projections: unknown[]; review: { cells: unknown[] } }>(handle, '/api/evidence/allocation-preview', selection);
      expect(preview.projections).toHaveLength(2); expect(preview.review.cells).toHaveLength(4);
      expect(await snapshot(handle)).toEqual(before);
      const stale = await scenarioRequest(handle, '/api/evidence/allocation', { method: 'POST', body: { ...selection, resolutionHash: '0'.repeat(64), allocationSetHash: preview.allocationSetHash } });
      expect(stale.status).toBe(409);
      await grant(handle, 'owner', { resourceKind: 'transaction', resourceId: targets[0]!, capability: 'source' }, false);
      const revokedSource = await scenarioRequest(handle, '/api/evidence/allocation-preview', { method: 'POST', body: selection });
      expect(revokedSource.status).toBe(409);
      await grant(handle, 'owner', { resourceKind: 'transaction', resourceId: targets[0]!, capability: 'source' });
      expect(await snapshot(handle)).toEqual(before);
      const wrong = await scenarioRequest(handle, '/api/evidence/allocation-preview', { method: 'POST', personaId: 'restricted', body: selection });
      expect(wrong.status).toBeGreaterThanOrEqual(400);
      await grant(handle, 'coapprover', { resourceKind: 'evidence', resourceId: evidence.documentId!, capability: 'normalized-evidence' }, false);
      for (const capability of ['evidence', 'normalized-evidence']) await grant(handle, 'coapprover', { resourceKind: 'evidence', resourceId: 'wrong-receipt-document', capability });
      const wrongDocument = await scenarioRequest<Envelope<{ document: unknown }>>(handle, `/api/evidence/${evidence.documentId}`, { personaId: 'coapprover' });
      expect(wrongDocument.status >= 400 || wrongDocument.body.result?.document === null).toBe(true);
      await grant(handle, 'coapprover', { resourceKind: 'evidence', resourceId: evidence.documentId!, capability: 'normalized-evidence' });
      const saved = await request<Resolution>(handle, '/api/evidence/allocation', { ...selection, allocationSetHash: preview.allocationSetHash });
      const event = saved.events.find((entry) => entry.projectionObservation || entry.projectionObservations?.length);
      expect(event).toBeDefined();
      const proposed = await request<{ proposalId: string }>(handle, '/api/evidence/proposal', { resolutionHash: saved.resolutionHash, eventId: event!.id, allocationSetHash: preview.allocationSetHash });
      const detail = await request<{ proposal: PublicProposal }>(handle, `/api/proposal/${proposed.proposalId}`);
      expect(detail.proposal.payload.plan.action).toMatchObject({ kind: 'composite', actions: [{ kind: 'evidence_amendment' }, { kind: 'evidence_amendment' }] });
      expect(detail.proposal.payload.plan.allocationReviews).toEqual([preview.review]);
      expect(detail.proposal.requiredApprovers).toBe(2);
      const noQuorum = await scenarioRequest(handle, `/api/proposal/${proposed.proposalId}/execute`, { method: 'POST', body: {} });
      expect(noQuorum.status).toBeGreaterThanOrEqual(400);
      const ownerApproval = await scenarioRequest(handle, `/api/proposal/${proposed.proposalId}/approve`, { method: 'POST', body: { payloadHash: detail.proposal.payloadHash } });
      expect(ownerApproval.status).toBeGreaterThanOrEqual(400);
      expect(new Set(['owner', 'coapprover', 'approver'].map((key) => handle.initialized.personas[key]!.actorId)).size).toBe(3);
      for (const persona of ['coapprover', 'approver']) {
        const membershipId = handle.initialized.personas[persona]!.membershipId;
        const currentGrants = await request<{ grants: Array<Grant & { membershipId: string; granted: boolean; revokedAt: string | null }> }>(handle, `/api/spaces/${handle.initialized.spaceId}/grants`);
        const reviewerGrants = currentGrants.grants.filter((entry) => entry.membershipId === membershipId && entry.granted && entry.revokedAt === null);
        expect(reviewerGrants.some((entry) => entry.resourceKind === 'budget' && entry.resourceId === handle.seeded.budgetId && entry.capability === 'full-read')).toBe(false);
        expect(reviewerGrants.some((entry) => entry.capability.endsWith(':execute'))).toBe(false);
        const independent = await request<Resolution>(handle, '/api/evidence/resolve', {}, persona);
        const independentSelection = { ...selection, resolutionHash: independent.resolutionHash };
        const independentPreview = await request<{ allocationSetHash: string; review: unknown }>(handle, '/api/evidence/allocation-preview', independentSelection, persona);
        expect(independentPreview.allocationSetHash).toBe(preview.allocationSetHash);
        expect(independentPreview.review).toEqual(preview.review);
        await request(handle, '/api/evidence/allocation', { ...independentSelection, allocationSetHash: independentPreview.allocationSetHash }, persona);
        const displayed = await request<{ proposal: PublicProposal }>(handle, `/api/proposal/${proposed.proposalId}`, undefined, persona);
        expect(displayed.proposal.payload.plan.allocationReviews).toEqual([independentPreview.review]);
        expect(displayed.proposal).toMatchObject({ payloadHash: detail.proposal.payloadHash, payload: detail.proposal.payload, canApprove: true, canExecute: false });
        const peerExecute = await scenarioRequest(handle, `/api/proposal/${proposed.proposalId}/execute`, { method: 'POST', personaId: persona, body: {} });
        expect(peerExecute.status).toBeGreaterThanOrEqual(400);
        await request(handle, `/api/proposal/${proposed.proposalId}/approve`, { payloadHash: displayed.proposal.payloadHash }, persona);
        if (persona === 'coapprover') {
          const oneApproval = await scenarioRequest(handle, `/api/proposal/${proposed.proposalId}/execute`, { method: 'POST', body: {} });
          expect(oneApproval.status).toBeGreaterThanOrEqual(400);
          expect(await snapshot(handle)).toEqual(before);
        }
      }
      const execution = await request<{ phase: string }>(handle, `/api/proposal/${proposed.proposalId}/execute`, {});
      expect(execution.phase).toBe('verified');
      const after = await snapshot(handle);
      expect(after.balance).toBe(before.balance); expect(after.rows).toHaveLength(before.rows.length);
      for (const [index, parentId] of targets.entries()) {
        const parent = after.rows.find((row) => row.id === parentId)!;
        const original = before.rows.find((row) => row.id === parentId)!;
        expect(parent).toMatchObject({ id: parentId, amount: index ? -500 : -700, account: accountId, imported_id: original.imported_id });
        const children = parent.subtransactions as ObjectValue[];
        expect(children).toHaveLength(2);
        expect(children.map((child) => ({ category: child.category, amount: child.amount })).sort((a, b) => String(a.category).localeCompare(String(b.category)))).toEqual([
          { category: categories[0], amount: index ? -200 : -400 }, { category: categories[1], amount: -300 },
        ].sort((a, b) => a.category.localeCompare(b.category)));
      }
      expect((await request<{ phase: string }>(handle, `/api/proposal/${proposed.proposalId}/execute`, {})).phase).toBe('verified');
      expect(await snapshot(handle)).toEqual(after);
      const doc = await request<{ document: { connectorId: string; sourceId: string; sourceTimestamp: string } }>(handle, `/api/evidence/${evidence.documentId}`);
      const raw = await request<{ contentBase64: string }>(handle, `/api/evidence/${evidence.documentId}/raw`);
      const duplicate = await request<{ duplicate: boolean; document: { id: string } }>(handle, '/api/evidence', { connectorId: doc.document.connectorId, sourceId: doc.document.sourceId, sourceTimestamp: doc.document.sourceTimestamp, sourceKind: 'retail', mediaType: 'application/json', visibility: 'shared', content: Buffer.from(raw.contentBase64, 'base64').toString('utf8') });
      expect(duplicate).toMatchObject({ duplicate: true, document: { id: evidence.documentId } });
      expect(await snapshot(handle)).toEqual(after);
    }, { branches: ['plural-matrix-conservation', 'plural-independent-approval', 'plural-stale-and-wrong-grant-denied', 'plural-native-reread-replay'] });
  });
  it('evidence-return-lifecycle', { timeout }, async () => {
    await withScenario('evidence-return-lifecycle', async (handle) => {
      const evidence = ids(handle), before = await snapshot(handle);
      const attributed = handle.initialized.personas.coapprover!;
      const original = { documentId: evidence.purchaseDocumentId, receiptId: evidence.purchaseReceiptId, lineId: evidence.purchaseLineId };
      const initial = await request<Context>(handle, '/api/evidence/receipt-review');
      const invalidMember = await scenarioRequest(handle, '/api/evidence/receipt-review', { method: 'POST', body: { resolutionHash: initial.resolutionHash, decisions: [{ kind: 'member', receiptId: evidence.purchaseReceiptId, lineId: evidence.purchaseLineId, membershipId: 'unknown-membership-period' }] } });
      expect(invalidMember.status).toBe(409);
      const backdated = await scenarioRequest(handle, '/api/evidence/receipt-review', { method: 'POST', body: { resolutionHash: initial.resolutionHash, decisions: [{ kind: 'member', receiptId: evidence.purchaseReceiptId, lineId: evidence.purchaseLineId, membershipId: attributed.membershipId, reviewedAt: '1900-01-01T00:00:00.000Z' }] } });
      expect(backdated.status).toBe(400);
      expect(receipt(await request<Context>(handle, '/api/evidence/receipt-review'), evidence.purchaseReceiptId!).lines[0]!.memberId).toBeNull();
      await review(handle, [
        { kind: 'return', receiptId: evidence.refundReceiptId, lineId: evidence.refundLineId, original },
        { kind: 'member', receiptId: evidence.purchaseReceiptId, lineId: evidence.purchaseLineId, membershipId: attributed.membershipId },
        { kind: 'fulfillment', receiptId: evidence.purchaseReceiptId, order: { documentId: evidence.orderDocumentId, observationId: evidence.orderObservationId } },
      ]);
      let context = await request<Context>(handle, '/api/evidence/receipt-review');
      expect(receipt(context, evidence.refundReceiptId!).lines[0]!.returnOfLineId).toBe(evidence.purchaseLineId);
      expect(receipt(context, evidence.purchaseReceiptId!).lines[0]!.memberId).toBe(attributed.actorId);
      expect(receipt(context, evidence.purchaseReceiptId!).fulfillmentGroupId).toMatch(/^fulfillment:/);
      await request(handle, `/api/spaces/${handle.initialized.spaceId}/memberships/${attributed.membershipId}/revoke`, {});
      context = await request<Context>(handle, '/api/evidence/receipt-review');
      expect(receipt(context, evidence.purchaseReceiptId!).lines[0]!.memberId).toBe(attributed.actorId);
      expect(context.members.some((member) => member.membershipId === attributed.membershipId)).toBe(false);
      const staleMember = await scenarioRequest(handle, '/api/evidence/receipt-review', { method: 'POST', body: { resolutionHash: context.resolutionHash, decisions: [{ kind: 'member', receiptId: evidence.unrelatedReceiptId, lineId: evidence.unrelatedLineId, membershipId: attributed.membershipId }] } });
      expect(staleMember.status).toBe(409);
      const formerMember = await scenarioRequest(handle, '/api/evidence', { personaId: 'coapprover' });
      expect(formerMember.status).toBe(403);
      const overlinked = await review(handle, [{ kind: 'return', receiptId: evidence.excessRefundReceiptId, lineId: evidence.excessRefundLineId, original }]);
      expect(overlinked.receipts.filter((entry) => [evidence.refundReceiptId, evidence.excessRefundReceiptId].includes(entry.receiptId)).some((entry) => !entry.valid)).toBe(true);
      await review(handle, [
        { kind: 'return', receiptId: evidence.excessRefundReceiptId, lineId: evidence.excessRefundLineId, original: null },
        { kind: 'member', receiptId: evidence.purchaseReceiptId, lineId: evidence.purchaseLineId, membershipId: null },
        { kind: 'fulfillment', receiptId: evidence.purchaseReceiptId, order: null },
      ]);
      context = await request<Context>(handle, '/api/evidence/receipt-review');
      expect(receipt(context, evidence.purchaseReceiptId!).lines[0]!.memberId).toBeNull();
      expect(receipt(context, evidence.purchaseReceiptId!).fulfillmentGroupId).toBeNull();
      expect(receipt(context, evidence.excessRefundReceiptId!).lines[0]!.returnOfLineId).toBeNull();
      expect(context.receipts.find((entry) => entry.receipt.id === evidence.refundReceiptId)?.valid).toBe(true);
      const resolution = await request<Resolution>(handle, '/api/evidence/resolve', {});
      const selection = { resolutionHash: resolution.resolutionHash, child: { documentId: evidence.replacementDocumentId, receiptId: evidence.replacementReceiptId }, predecessor: { documentId: evidence.purchaseDocumentId, receiptId: evidence.purchaseReceiptId } };
      const preview = await request<{ previewHash: string; foldHash: string; version: number }>(handle, '/api/evidence/receipt-versions/preview', selection);
      expect(preview.version).toBe(2);
      const staleVersion = await scenarioRequest(handle, '/api/evidence/receipt-versions/save', { method: 'POST', body: { ...selection, previewHash: '0'.repeat(64), expectedFoldHash: preview.foldHash, sameReceiptAcknowledged: true } });
      expect(staleVersion.status).toBe(409);
      expect((await request<{ links: unknown[] }>(handle, '/api/evidence/receipt-versions')).links).toEqual([]);
      await request(handle, '/api/evidence/receipt-versions/save', { ...selection, previewHash: preview.previewHash, expectedFoldHash: preview.foldHash, sameReceiptAcknowledged: true });
      let versions = await request<{ links: unknown[]; foldHash: string; blockedChildren: unknown[] }>(handle, '/api/evidence/receipt-versions');
      expect(versions.links).toHaveLength(1);
      await grant(handle, 'owner', { resourceKind: 'evidence', resourceId: evidence.purchaseDocumentId!, capability: 'normalized-evidence' }, false);
      versions = await request(handle, '/api/evidence/receipt-versions');
      expect(versions.blockedChildren).toHaveLength(1);
      const fenced = await request<Context>(handle, '/api/evidence/receipt-review');
      expect(fenced.receipts.some((entry) => entry.receipt.id === evidence.replacementReceiptId)).toBe(false);
      expect(fenced.receipts.some((entry) => entry.receipt.id === evidence.unrelatedReceiptId)).toBe(true);
      await grant(handle, 'owner', { resourceKind: 'evidence', resourceId: evidence.purchaseDocumentId!, capability: 'normalized-evidence' });
      versions = await request(handle, '/api/evidence/receipt-versions');
      await request(handle, '/api/evidence/receipt-versions/revoke', { childDocumentId: evidence.replacementDocumentId, childReceiptId: evidence.replacementReceiptId, expectedFoldHash: versions.foldHash });
      versions = await request(handle, '/api/evidence/receipt-versions');
      expect(versions.links).toHaveLength(0);
      expect(versions.blockedChildren).toEqual([]);
      context = await request<Context>(handle, '/api/evidence/receipt-review');
      expect(context.receipts.map((entry) => entry.receipt.id)).toEqual(expect.arrayContaining([evidence.purchaseReceiptId, evidence.replacementReceiptId, evidence.unrelatedReceiptId]));
      expect(await snapshot(handle)).toEqual(before);
    }, { branches: ['partial-return-capacity', 'member-fulfillment-clear', 'receipt-version-revoke', 'receipt-history-grant-fence'] });
  });
});
