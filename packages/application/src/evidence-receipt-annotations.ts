import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  EvidenceReceiptAnnotation,
  LiquidityActor,
  SpaceMembership,
} from '@balanceframe/workflow-store';
import type {
  ReceiptEvidence,
  TransactionEvidenceRequest,
  TransactionEvidenceResult,
} from '@balanceframe/protocol-generated';
const id = z.string().trim().min(1).max(256);
const original = z.object({ documentId: id, receiptId: id, lineId: id }).strict();
/** Clients select relationships and membership periods; authority/provenance come from the server. */
export const receiptAnnotationInputSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('member'), receiptId: id, lineId: id, membershipId: id.nullable() })
    .strict(),
  z
    .object({ kind: z.literal('return'), receiptId: id, lineId: id, original: original.nullable() })
    .strict(),
  z
    .object({
      kind: z.literal('fulfillment'),
      receiptId: id,
      order: z.object({ documentId: id, observationId: id }).strict().nullable(),
    })
    .strict(),
]);
/** Bound one fresh human receipt review to its exact current native resolution. */
export const receiptReviewSaveSchema = z
  .object({
    resolutionHash: z.string().regex(/^[a-f0-9]{64}$/),
    decisions: z.array(receiptAnnotationInputSchema).min(1).max(10000),
  })
  .strict();
export type ReceiptAnnotationInput = z.infer<typeof receiptAnnotationInputSchema>;
type MemberVisible = (actorId: string) => boolean;
function membershipAt(member: SpaceMembership, spaceId: string, at: string): boolean {
  const instant = Date.parse(at);
  return (
    member.spaceId === spaceId &&
    Number.isFinite(instant) &&
    Date.parse(member.validFrom) <= instant &&
    (member.validUntil === null || instant < Date.parse(member.validUntil)) &&
    (member.revokedAt === null || instant < Date.parse(member.revokedAt))
  );
}
function currentReceipt(
  request: TransactionEvidenceRequest,
  receiptId: string,
): ReceiptEvidence | undefined {
  return request.receipts.find(
    (receipt) =>
      receipt.id === receiptId &&
      !request.receipts.some((newer) => newer.supersedesId === receipt.id) &&
      request.observations.some(
        (source) => source.id === receipt.observationId && source.status === 'completed',
      ),
  );
}
function sourceFor(request: TransactionEvidenceRequest, receipt: ReceiptEvidence) {
  const source = request.observations.find((source) => source.id === receipt.observationId);
  if (!source) throw new Error('Current receipt source required');
  return source;
}
function originalFor(request: TransactionEvidenceRequest, selector: z.infer<typeof original>) {
  const receipt = currentReceipt(request, selector.receiptId);
  const source = receipt && sourceFor(request, receipt);
  const line = receipt?.lines.find((line) => line.id === selector.lineId);
  if (
    !receipt ||
    !source ||
    !line ||
    source.provenance.documentId !== selector.documentId ||
    source.direction !== 'outflow' ||
    !['purchase', 'p2p_payment'].includes(source.eventType) ||
    ['order', 'spend_session_item', 'wallet_request'].includes(source.kind) ||
    line.returnOfLineId !== null
  )
    throw new Error('Current original purchase line required');
  return { receipt, source, line };
}
/** Bind explicit relationship choices to conserved current receipts and verified review identity. */
export function prepareReceiptAnnotations(
  input: ReceiptAnnotationInput[],
  request: TransactionEvidenceRequest,
  result: TransactionEvidenceResult,
  actor: LiquidityActor,
  now: string,
  memberships: SpaceMembership[],
  visible: MemberVisible,
): EvidenceReceiptAnnotation[] {
  if (!actor.membershipId || !actor.governancePolicyVersion || !actor.spaceId)
    throw new Error('Current human review scope required');
  const seen = new Set<string>();
  return input.map((value) => {
    const receipt = currentReceipt(request, value.receiptId);
    const removing =
      value.kind === 'member'
        ? value.membershipId === null
        : value.kind === 'return'
          ? value.original === null
          : value.order === null;
    if (
      !receipt ||
      (!removing && !result.receipts.some((entry) => entry.receiptId === receipt.id && entry.valid))
    )
      throw new Error('Conserved current receipt required');
    const source = sourceFor(request, receipt);
    const key = JSON.stringify([value.kind, receipt.id, 'lineId' in value ? value.lineId : null]);
    if (seen.has(key)) throw new Error('Duplicate receipt annotation');
    seen.add(key);
    const base = {
      ...source.provenance,
      receiptId: receipt.id,
      actorId: actor.actorId,
      membershipId: actor.membershipId!,
      policyVersion: actor.governancePolicyVersion!,
      reviewedAt: now,
    };
    const { sourceTimestamp: _timestamp, receivedAt: _received, ...provenance } = base;
    let change: EvidenceReceiptAnnotation['change'];
    if (value.kind === 'member') {
      if (!receipt.lines.some((line) => line.id === value.lineId))
        throw new Error('Current receipt line required');
      const member = memberships.find(
        (entry) => entry.id === value.membershipId && membershipAt(entry, actor.spaceId!, now),
      );
      if (value.membershipId !== null && (!member || !visible(member.actorId)))
        throw new Error('Current visible member required');
      change = {
        kind: 'member',
        lineId: value.lineId,
        member: member ? { actorId: member.actorId, membershipId: member.id } : null,
      };
    } else if (value.kind === 'return') {
      if (
        !receipt.lines.some((line) => line.id === value.lineId) ||
        source.eventType !== 'refund' ||
        source.direction !== 'inflow'
      )
        throw new Error('Current refund line required');
      const purchased = value.original && originalFor(request, value.original);
      if (
        purchased &&
        !result.receipts.some((entry) => entry.receiptId === purchased.receipt.id && entry.valid)
      )
        throw new Error('Conserved original purchase required');
      const proof = purchased?.source.provenance;
      change = {
        kind: 'return',
        lineId: value.lineId,
        original:
          value.original && proof
            ? {
                ...value.original,
                contentHash: proof.contentHash,
                parserVersion: proof.parserVersion,
              }
            : null,
      };
    } else {
      const order =
        value.order &&
        request.observations.find(
          (entry) =>
            entry.id === value.order!.observationId &&
            entry.provenance.documentId === value.order!.documentId &&
            entry.kind === 'order' &&
            entry.status !== 'superseded' &&
            entry.amount.currency === receipt.total.currency &&
            (entry.counterparty === null ||
              source.counterparty === null ||
              entry.counterparty === source.counterparty),
        );
      if (value.order && !order) throw new Error('Current readable same-retailer order required');
      change = {
        kind: 'fulfillment',
        order: order
          ? {
              documentId: order.provenance.documentId,
              contentHash: order.provenance.contentHash,
              parserVersion: order.provenance.parserVersion,
              observationId: order.id,
            }
          : null,
      };
    }
    return { ...provenance, change };
  });
}
/** Apply only still-visible reviewed claims; expired memberships retain their past attribution, never future access. */
export function applyReceiptAnnotations(
  request: TransactionEvidenceRequest,
  entries: EvidenceReceiptAnnotation[],
  actor: LiquidityActor,
  memberships: SpaceMembership[],
  visible: MemberVisible,
): EvidenceReceiptAnnotation[] {
  return entries.filter((entry) => {
    const receipt = currentReceipt(request, entry.receiptId);
    const source = receipt && sourceFor(request, receipt);
    if (
      !receipt ||
      !source ||
      entry.actorId !== actor.actorId ||
      entry.membershipId !== actor.membershipId ||
      entry.policyVersion !== actor.governancePolicyVersion ||
      entry.policyVersion !== request.policyVersion ||
      entry.documentId !== source.provenance.documentId ||
      entry.contentHash !== source.provenance.contentHash ||
      entry.parserVersion !== source.provenance.parserVersion
    )
      return false;
    const change = entry.change;
    const line =
      'lineId' in change ? receipt.lines.find((line) => line.id === change.lineId) : undefined;
    if ('lineId' in change && !line) return false;
    if (change.kind === 'member') {
      const member =
        change.member &&
        memberships.find(
          (period) =>
            period.id === change.member!.membershipId &&
            period.actorId === change.member!.actorId &&
            membershipAt(period, actor.spaceId!, entry.reviewedAt),
        );
      if (change.member && (!member || !visible(member.actorId))) return false;
      line!.memberId = member?.actorId ?? null;
    } else if (change.kind === 'return') {
      if (source.eventType !== 'refund' || source.direction !== 'inflow') return false;
      if (change.original) {
        try {
          const purchased = originalFor(request, change.original);
          if (
            purchased.source.provenance.contentHash !== change.original.contentHash ||
            purchased.source.provenance.parserVersion !== change.original.parserVersion
          )
            return false;
        } catch {
          return false;
        }
      }
      line!.returnOfLineId = change.original?.lineId ?? null;
    } else {
      const proof = change.order;
      const order =
        proof &&
        request.observations.find(
          (observation) =>
            observation.id === proof.observationId &&
            observation.kind === 'order' &&
            observation.status !== 'superseded' &&
            observation.provenance.documentId === proof.documentId &&
            observation.provenance.contentHash === proof.contentHash &&
            observation.provenance.parserVersion === proof.parserVersion,
        );
      if (proof && !order) return false;
      receipt.fulfillmentGroupId = proof
        ? `fulfillment:${createHash('sha256')
            .update(
              JSON.stringify([
                actor.spaceId,
                actor.budgetId,
                proof.documentId,
                proof.observationId,
              ]),
            )
            .digest('hex')}`
        : null;
    }
    return true;
  });
}
