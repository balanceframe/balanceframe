import {
  DeriveEvidenceAllocationPlanRequestSchema,
  TransactionEvidenceRequestSchema,
  ReceiptEvidenceSchema,
} from '@balanceframe/protocol-generated/validators';
import type { ReceiptEvidence } from '@balanceframe/protocol-generated';
import type { ResourceKind, ResourceCapability } from '@balanceframe/workflow-store';
import type { EvidenceScenarioSetup } from './evidence-scenario-support.js';
import { evidenceFixture, evidenceGrant, evidencePost, evidenceResult, evidenceString } from './evidence-scenario-support.js';

type ObjectValue = Record<string, unknown>;
const readRights = ['evidence', 'normalized-evidence', 'resolve', 'source', 'full-read', 'raw-document', 'delete'] as const;
function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as ObjectValue;
}
function first<T>(values: readonly T[], label: string): T {
  if (!values[0]) throw new Error(`${label} must not be empty`);
  return values[0];
}
const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
function seedId(values: Readonly<Record<string, string>>, id: string): string {
  return evidenceString(values[id], `Seeded ${id}`);
}
function receiptFixture(): ReceiptEvidence {
  return structuredClone(first(TransactionEvidenceRequestSchema.parse(evidenceFixture('transaction-evidence-receipt')).receipts, 'canonical receipts'));
}
function manualReceipt(amount = '1200'): Omit<ReceiptEvidence, 'id' | 'observationId' | 'version' | 'supersedesId' | 'fulfillmentGroupId'> {
  const { id: _id, observationId: _observation, version: _version, supersedesId: _supersedes, fulfillmentGroupId: _fulfillment, ...receipt } = receiptFixture();
  if (amount !== '1200') {
    receipt.total = usd(amount);
    receipt.tax = usd('0'); receipt.discount = usd('0');
    receipt.lines = receipt.lines.map((line) => ({ ...line, quantityMicros: 1_000_000, unitGross: usd(amount), gross: usd(amount), net: usd(amount), tax: usd('0'), discount: usd('0') }));
    if (amount === '700') {
      receipt.tax = usd('100');
      receipt.lines = receipt.lines.map((line) => ({ ...line, unitGross: usd('600'), gross: usd('600'), tax: usd('100') }));
    }
  }
  receipt.lines = receipt.lines.map((line) => ({ ...line, categoryId: null, memberId: null, returnOfLineId: null, evidenceStrength: 0 }));
  receipt.tenders = receipt.tenders.map((tender) => ({ ...tender, amount: usd(amount), observationId: null }));
  return receipt;
}
async function ingest(ctx: EvidenceScenarioSetup, body: ObjectValue): Promise<{ documentId: string; receipt?: ReceiptEvidence }> {
  const imported = await evidencePost(ctx, '/api/evidence', body);
  const documentId = evidenceString(object(imported.document, 'Imported document').id, 'Imported document ID');
  await evidenceGrant(ctx, 'owner', 'evidence', documentId, readRights);
  const owner = ctx.clients.owner;
  if (!owner) throw new Error('Receipt scenario owner client unavailable');
  const detail = evidenceResult(await owner.get(`/api/evidence/${encodeURIComponent(documentId)}`), 'Imported receipt detail');
  const document = object(detail.document, 'Readable imported document');
  if (document.id !== documentId) throw new Error('Receipt import identity changed');
  const extraction = object(document.extraction, 'Imported extraction');
  const receipts = ReceiptEvidenceSchema.array().parse(extraction.receipts ?? []);
  return { documentId, ...(receipts[0] ? { receipt: receipts[0] } : {}) };
}
function receiptIds(prefix: string, imported: Awaited<ReturnType<typeof ingest>>): Record<string, string> {
  if (!imported.receipt) throw new Error(`${prefix} receipt unavailable after import`);
  return {
    [`${prefix}DocumentId`]: imported.documentId,
    [`${prefix}ReceiptId`]: imported.receipt.id,
    [`${prefix}LineId`]: first(imported.receipt.lines, `${prefix} receipt lines`).id,
    [`${prefix}ObservationId`]: imported.receipt.observationId,
  };
}
function binaryImport(ctx: EvidenceScenarioSetup, name: string, mediaType: 'image/jpeg' | 'application/pdf', amount = '1200', kind: 'purchase' | 'refund' = 'purchase'): ObjectValue {
  const assets = object(evidenceFixture('scenarios/evidence-receipt-assets'), 'Receipt assets');
  return {
    connectorId: 'scenario-receipts', sourceId: `${name}.${mediaType === 'image/jpeg' ? 'jpg' : 'pdf'}`,
    sourceTimestamp: ctx.scenario.anchor, sourceKind: 'retail', mediaType,
    content: evidenceString(mediaType === 'image/jpeg' ? assets.jpegBase64 : assets[`${name}PdfBase64`] ?? assets.pdfBase64, 'Receipt source bytes'),
    contentEncoding: 'base64', visibility: 'private',
    userExtraction: {
      kind, date: ctx.scenario.anchor.slice(0, 10), total: usd(amount), merchant: 'Market Basket',
      fundingInstrumentId: seedId(ctx.seeded.accountIds, 'acct-checking'), receipt: manualReceipt(amount),
    },
  };
}
async function intake(ctx: EvidenceScenarioSetup): Promise<Record<string, string>> {
  const photo = await ingest(ctx, binaryImport(ctx, 'purchase', 'image/jpeg'));
  const pdfInput = binaryImport(ctx, 'manual-invoice', 'application/pdf');
  const pdf = await ingest(ctx, pdfInput);
  const { userExtraction: _manual, ...unparsedInput } = binaryImport(ctx, 'unparsed-invoice', 'application/pdf');
  const unparsed = await ingest(ctx, unparsedInput);
  const mismatchInput = binaryImport(ctx, 'mismatched-items', 'image/jpeg');
  const extraction = object(mismatchInput.userExtraction, 'Mismatched extraction');
  const receipt = object(extraction.receipt, 'Mismatched receipt');
  const lines = receipt.lines as ObjectValue[];
  first(lines, 'Mismatched lines').net = usd('1199');
  const mismatch = await ingest(ctx, mismatchInput);
  return { ...receiptIds('photo', photo), ...receiptIds('pdf', pdf), unparsedDocumentId: unparsed.documentId, ...receiptIds('mismatch', mismatch) };
}
async function plural(ctx: EvidenceScenarioSetup): Promise<Record<string, string>> {
  const targetOneId = seedId(ctx.seeded.transactionIds, 'txn-evidence-700');
  const targetTwoId = seedId(ctx.seeded.transactionIds, 'txn-evidence-500');
  const owner = ctx.clients.owner, persona = ctx.personas.owner;
  if (!owner || !persona) throw new Error('Plural receipt owner unavailable');
  const policyPath = `/api/spaces/${persona.spaceId}/policy`;
  const current = object(evidenceResult(await owner.get(policyPath), 'Receipt governance policy').policy, 'Receipt policy');
  await owner.reauthenticate(persona.password);
  evidenceResult(await owner.put(policyPath, {
    expectedVersion: evidenceString(current.version, 'Receipt policy version'),
    policy: {
      minimumApprovers: 2,
      ...(current.approvalThresholds === undefined ? {} : { approvalThresholds: current.approvalThresholds }),
      ...(current.operationApprovers === undefined ? {} : { operationApprovers: current.operationApprovers }),
      assistanceMaximum: 'execute_approved_actions',
    },
  }), 'Receipt independent approval policy');
  for (const transactionId of [targetOneId, targetTwoId])
    await evidenceGrant(ctx, 'owner', 'transaction', transactionId, ['transaction.view', 'transaction']);
  await evidenceGrant(ctx, 'owner', 'account', seedId(ctx.seeded.accountIds, 'acct-checking'), ['transaction']);
  const fixture = DeriveEvidenceAllocationPlanRequestSchema.parse(evidenceFixture('evidence-allocation-plan'));
  const receipt = structuredClone(first(fixture.evidence.receipts, 'Matrix receipts'));
  const purchase = fixture.evidence.observations.find((observation) => observation.kind === 'receipt');
  if (!purchase) throw new Error('Canonical matrix purchase unavailable');
  const { provenance: _provenance, ...source } = purchase;
  const base = first(receipt.lines, 'Matrix lines');
  receipt.lines = [1, 2].map((number) => ({ ...structuredClone(base), id: `line-${number}`, sku: `synthetic-sku-${number}`, rawDescription: number === 1 ? 'Synthetic groceries' : 'Synthetic household item', quantityMicros: 1_000_000, unitGross: usd('600'), gross: usd('600'), net: usd('600'), evidenceStrength: 0, categoryId: null }));
  receipt.tenders = receipt.tenders.map((tender) => ({ ...tender, observationId: null }));
  const imported = await ingest(ctx, {
    connectorId: 'scenario-receipts', sourceId: 'plural-receipt', sourceTimestamp: ctx.scenario.anchor,
    sourceKind: 'retail', mediaType: 'application/json', visibility: 'shared',
    content: JSON.stringify({ templateVersion: 'retail-v1', observations: [{ ...source, date: ctx.scenario.anchor.slice(0, 10), counterparty: 'Market Basket', fundingInstrumentId: seedId(ctx.seeded.accountIds, 'acct-checking'), reliability: 0 }], receipts: [receipt] }),
  });
  const resources = [
    { kind: 'budget' as const, id: ctx.seeded.budgetId },
    { kind: 'account' as const, id: seedId(ctx.seeded.accountIds, 'acct-checking') },
    ...['cat-groceries', 'cat-household'].map((id) => ({ kind: 'category' as const, id: seedId(ctx.seeded.categoryIds, id) })),
    ...[targetOneId, targetTwoId].flatMap((id) => [{ kind: 'transaction' as const, id }, { kind: 'ledger_effect' as const, id }]),
    { kind: 'evidence' as const, id: imported.documentId },
  ];
  for (const resource of resources)
    await evidenceGrant(ctx, 'owner', resource.kind, resource.id, ['ledger_projection:propose', 'ledger_projection:execute']);
  const sourceRights: Partial<Record<ResourceKind, readonly ResourceCapability[]>> = {
    account: ['existence', 'history', 'name', 'source', 'full-read'],
    category: ['existence', 'name', 'source', 'category', 'full-read'],
    transaction: ['transaction.view', 'history', 'source', 'full-read'],
    rule: ['rule:view', 'source', 'full-read'],
  };
  for (const personaId of ['owner', 'coapprover', 'approver']) {
    await evidenceGrant(ctx, personaId, 'budget', ctx.seeded.budgetId, ['observe', 'source', 'normalized-evidence']);
    for (const resource of ctx.seeded.readResources) {
      const rights = sourceRights[resource.resourceKind];
      if (!rights) throw new Error('Unsupported native receipt source kind');
      await evidenceGrant(ctx, personaId, resource.resourceKind, resource.resourceId, rights);
    }
    await evidenceGrant(ctx, personaId, 'evidence', imported.documentId, ['evidence', 'normalized-evidence', 'source', 'full-read']);
    for (const target of [targetOneId, targetTwoId]) await evidenceGrant(ctx, personaId, 'ledger_effect', target, ['source', 'full-read']);
    if (personaId !== 'owner') {
      await evidenceGrant(ctx, personaId, 'budget', ctx.seeded.budgetId, ['resolve']);
      await evidenceGrant(ctx, personaId, 'evidence', imported.documentId, ['resolve']);
      await evidenceGrant(ctx, personaId, 'account', seedId(ctx.seeded.accountIds, 'acct-checking'), ['transaction']);
      for (const target of [targetOneId, targetTwoId]) await evidenceGrant(ctx, personaId, 'transaction', target, ['transaction']);
      for (const resource of resources)
        await evidenceGrant(ctx, personaId, resource.kind, resource.id, ['ledger_projection:approve']);
    }
  }
  return { documentId: imported.documentId, receiptId: receipt.id, lineOneId: receipt.lines[0]!.id, lineTwoId: receipt.lines[1]!.id, targetOneId, targetTwoId };
}
async function lifecycle(ctx: EvidenceScenarioSetup): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const [name, amount, kind] of [
    ['purchase', '1200', 'purchase'], ['refund', '600', 'refund'], ['excessRefund', '700', 'refund'],
    ['replacement', '1200', 'purchase'], ['unrelated', '1200', 'purchase'],
  ] as const) Object.assign(output, receiptIds(name, await ingest(ctx, binaryImport(ctx, name, kind === 'refund' ? 'application/pdf' : 'image/jpeg', amount, kind))));
  const fixture = TransactionEvidenceRequestSchema.parse(evidenceFixture('transaction-evidence-receipt'));
  const { provenance: _proof, ...source } = first(fixture.observations, 'Order source');
  const order = await ingest(ctx, {
    connectorId: 'scenario-receipts', sourceId: 'order', sourceTimestamp: ctx.scenario.anchor,
    sourceKind: 'retail', mediaType: 'application/json', visibility: 'private',
    content: JSON.stringify({ templateVersion: 'retail-v1', observations: [{ ...source, id: 'scenario-order', kind: 'order', status: 'pending', eventType: 'purchase', date: ctx.scenario.anchor.slice(0, 10), counterparty: 'Market Basket', ledgerTransactionId: null, reliability: 0 }], receipts: [] }),
  });
  return { ...output, orderDocumentId: order.documentId, orderObservationId: 'scenario-order' };
}
/** Import canonical-derived receipts and exact fictional persona grants through authenticated Source. */
export async function initializeReceiptEvidence(options: EvidenceScenarioSetup): Promise<Readonly<Record<string, string>>> {
  switch (options.scenario.id) {
    case 'evidence-receipt-intake': return intake(options);
    case 'evidence-plural-allocation': return plural(options);
    case 'evidence-return-lifecycle': return lifecycle(options);
    default: return {};
  }
}
