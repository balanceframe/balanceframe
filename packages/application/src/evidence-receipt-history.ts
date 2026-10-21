import type { EvidenceDocument } from '@balanceframe/workflow-store';
import {
  EvidenceObservationSchema,
  ReceiptEvidenceSchema,
} from '@balanceframe/protocol-generated/validators';
import type { ReceiptEvidence } from '@balanceframe/protocol-generated';

const receipts = (document: EvidenceDocument): ReceiptEvidence[] =>
  document.parseStatus === 'parsed'
    ? ReceiptEvidenceSchema.array().parse(document.extraction.receipts ?? [])
    : [];
const sameFamily = (left: EvidenceDocument, right: EvidenceDocument): boolean =>
  left.connectorId === right.connectorId &&
  left.sourceId === right.sourceId &&
  left.privateActorId === right.privateActorId &&
  left.scope.spaceId === right.scope.spaceId &&
  left.scope.budgetId === right.scope.budgetId &&
  left.scope.connectionId === right.scope.connectionId;

/** Load only required immutable same-family ancestors from already authorized documents, as history only. */
export function receiptHistoryDocuments(
  current: EvidenceDocument[],
  readable: EvidenceDocument[],
): EvidenceDocument[] {
  const available = new Map(readable.map((document) => [document.id, document]));
  const selected = new Map<string, { document: EvidenceDocument; receiptIds: Set<string> }>();
  const currentIds = new Set(current.map((document) => document.id));
  const queue = current.flatMap((document) =>
    receipts(document).map((receipt) => ({ document, receipt })),
  );
  const visited = new Set<string>();
  for (let index = 0; index < queue.length; index++) {
    if (queue.length > 10000) throw new Error('Receipt history limit exceeded');
    const { document, receipt } = queue[index]!;
    const key = JSON.stringify([document.id, receipt.id]);
    if (visited.has(key)) continue;
    visited.add(key);
    if (receipt.supersedesId === null) continue;
    const localPrior = receipts(document).find((prior) => prior.id === receipt.supersedesId);
    if (localPrior) {
      if (!currentIds.has(document.id)) {
        selected.get(document.id)!.receiptIds.add(localPrior.id);
        queue.push({ document, receipt: localPrior });
      }
      continue;
    }
    let ancestorId = document.supersedesId;
    const chain = new Set([document.id]);
    let predecessor: { document: EvidenceDocument; receipt: ReceiptEvidence } | undefined;
    while (ancestorId !== null) {
      if (chain.has(ancestorId) || chain.size > 1000)
        throw new Error('Invalid receipt history lineage');
      chain.add(ancestorId);
      const ancestor = available.get(ancestorId);
      if (!ancestor || ancestor.parseStatus !== 'parsed' || !sameFamily(document, ancestor))
        throw new Error('Authorized receipt history unavailable');
      const prior = receipts(ancestor).find((entry) => entry.id === receipt.supersedesId);
      if (prior) {
        predecessor = { document: ancestor, receipt: prior };
        break;
      }
      ancestorId = ancestor.supersedesId;
    }
    if (!predecessor) throw new Error('Authorized receipt history unavailable');
    const entry = selected.get(predecessor.document.id) ?? {
      document: predecessor.document,
      receiptIds: new Set<string>(),
    };
    entry.receiptIds.add(predecessor.receipt.id);
    selected.set(predecessor.document.id, entry);
    queue.push(predecessor);
  }
  return [...selected.values()]
    .sort((left, right) => left.document.id.localeCompare(right.document.id))
    .map(({ document, receiptIds }) => {
      const historical = receipts(document).filter((receipt) => receiptIds.has(receipt.id));
      const observationIds = new Set(
        historical.flatMap((receipt) => [
          receipt.observationId,
          ...receipt.tenders.flatMap((tender) =>
            tender.observationId ? [tender.observationId] : [],
          ),
        ]),
      );
      const observations = EvidenceObservationSchema.omit({ provenance: true })
        .array()
        .parse(document.extraction.observations);
      return {
        ...document,
        extraction: {
          ...document.extraction,
          receipts: historical,
          observations: observations
            .filter((observation) => observationIds.has(observation.id))
            .map((observation) => ({
              ...observation,
              status: 'superseded',
            })),
          relationships: [],
          wallets: [],
        },
      };
    });
}
