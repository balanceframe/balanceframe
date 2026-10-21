import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  prepareReceiptAnnotations,
  applyReceiptAnnotations,
} from '../src/evidence-receipt-annotations.js';
import type {
  TransactionEvidenceRequest,
  TransactionEvidenceResult,
} from '@balanceframe/protocol-generated';
const fixture = JSON.parse(
  readFileSync(
    new URL('../../../protocol/fixtures/transaction-evidence-receipt.json', import.meta.url),
    'utf8',
  ),
) as TransactionEvidenceRequest;
const now = '2026-10-21T12:00:00.000Z';
const actor = {
  actorId: 'owner',
  spaceId: 'space',
  budgetId: 'budget',
  membershipId: 'owner-period',
  governancePolicyVersion: 'policy',
};
const membership = {
  id: 'member-period',
  actorId: 'member',
  spaceId: 'space',
  validFrom: '2026-01-01T00:00:00Z',
  validUntil: null,
  revokedAt: null,
  grantedBy: 'owner',
  createdAt: now,
  origin: 'managed' as const,
};
function setup() {
  const request = structuredClone(fixture);
  request.policyVersion = actor.governancePolicyVersion;
  const source = request.observations[0]!;
  source.provenance.documentId = 'doc';
  const refund = structuredClone(request.receipts[0]!);
  refund.id = 'return';
  refund.observationId = 'refund';
  refund.lines[0]!.id = 'return-line';
  refund.tenders[0]!.observationId = null;
  const observation = structuredClone(source);
  observation.id = 'refund';
  observation.eventType = 'refund';
  observation.direction = 'inflow';
  observation.provenance.documentId = 'refund-doc';
  request.observations.push(observation);
  request.receipts.push(refund);
  const order = structuredClone(source);
  order.id = 'order';
  order.kind = 'order';
  order.status = 'pending';
  order.provenance.documentId = 'order-doc';
  request.observations.push(order);
  const result = {
    receipts: request.receipts.map((receipt) => ({ receiptId: receipt.id, valid: true })),
  } as TransactionEvidenceResult;
  return { request, result };
}
describe('explicit receipt relationships and member attribution', () => {
  it('binds explicit member, return and shipment choices to real current source and human provenance', () => {
    const { request, result } = setup();
    const entries = prepareReceiptAnnotations(
      [
        { kind: 'member', receiptId: 'receipt-1', lineId: 'line-1', membershipId: membership.id },
        {
          kind: 'return',
          receiptId: 'return',
          lineId: 'return-line',
          original: { documentId: 'doc', receiptId: 'receipt-1', lineId: 'line-1' },
        },
        {
          kind: 'fulfillment',
          receiptId: 'receipt-1',
          order: { documentId: 'order-doc', observationId: 'order' },
        },
      ],
      request,
      result,
      actor,
      now,
      [membership],
      () => true,
    );
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      documentId: 'doc',
      actorId: 'owner',
      membershipId: 'owner-period',
      policyVersion: 'policy',
      change: { member: { actorId: 'member', membershipId: membership.id } },
    });
    expect(applyReceiptAnnotations(request, entries, actor, [membership], () => true)).toHaveLength(
      3,
    );
    expect(request.receipts[0]!.lines[0]!.memberId).toBe('member');
    expect(request.receipts[1]!.lines[0]!.returnOfLineId).toBe('line-1');
    expect(request.receipts[0]!.fulfillmentGroupId).toMatch(/^fulfillment:[a-f0-9]{64}$/);
  });
  it('requires current eligible membership, exact original purchase and order selections, never imported identity claims', () => {
    const { request, result } = setup();
    const member = {
      kind: 'member' as const,
      receiptId: 'receipt-1',
      lineId: 'line-1',
      membershipId: membership.id,
    };
    for (const members of [
      [],
      [{ ...membership, spaceId: 'other' }],
      [{ ...membership, revokedAt: now }],
      [{ ...membership, validFrom: '2027-01-01T00:00:00Z' }],
    ])
      expect(() =>
        prepareReceiptAnnotations([member], request, result, actor, now, members, () => true),
      ).toThrow();
    expect(() =>
      prepareReceiptAnnotations([member], request, result, actor, now, [membership], () => false),
    ).toThrow();
    expect(() =>
      prepareReceiptAnnotations(
        [member, member],
        request,
        result,
        actor,
        now,
        [membership],
        () => true,
      ),
    ).toThrow();
    expect(() =>
      prepareReceiptAnnotations(
        [
          {
            kind: 'return',
            receiptId: 'return',
            lineId: 'return-line',
            original: { documentId: 'refund-doc', receiptId: 'return', lineId: 'return-line' },
          },
        ],
        request,
        result,
        actor,
        now,
        [membership],
        () => true,
      ),
    ).toThrow();
    expect(() =>
      prepareReceiptAnnotations(
        [
          {
            kind: 'fulfillment',
            receiptId: 'receipt-1',
            order: { documentId: 'doc', observationId: 'wallet-1' },
          },
        ],
        request,
        result,
        actor,
        now,
        [membership],
        () => true,
      ),
    ).toThrow();
  });
  it('honors explicit revocation and historical member attribution while stale source, scope and member permissions abstain', () => {
    const { request, result } = setup();
    const [entry] = prepareReceiptAnnotations(
      [{ kind: 'member', receiptId: 'receipt-1', lineId: 'line-1', membershipId: membership.id }],
      request,
      result,
      actor,
      now,
      [membership],
      () => true,
    );
    expect(
      applyReceiptAnnotations(
        request,
        [entry!],
        actor,
        [{ ...membership, revokedAt: '2026-10-22T00:00:00Z' }],
        () => true,
      ),
    ).toHaveLength(1);
    for (const change of [
      { actorId: 'other' },
      { contentHash: 'b'.repeat(64) },
      { policyVersion: 'new' },
      { membershipId: 'replacement' },
    ])
      expect(
        applyReceiptAnnotations(
          structuredClone(request),
          [{ ...entry!, ...change }],
          actor,
          [membership],
          () => true,
        ),
      ).toEqual([]);
    expect(applyReceiptAnnotations(request, [entry!], actor, [membership], () => false)).toEqual(
      [],
    );
    expect(
      applyReceiptAnnotations(
        request,
        [{ ...entry!, change: { kind: 'member', lineId: 'line-1', member: null } }],
        actor,
        [membership],
        () => true,
      ),
    ).toHaveLength(1);
    expect(request.receipts[0]!.lines[0]!.memberId).toBeNull();
  });
});

it('allows explicit removal from a current invalid receipt while refusing new claims on it', () => {
  const { request, result } = setup();
  result.receipts.find((receipt) => receipt.receiptId === 'return')!.valid = false;
  const revoke = {
    kind: 'return' as const,
    receiptId: 'return',
    lineId: 'return-line',
    original: null,
  };
  expect(
    prepareReceiptAnnotations([revoke], request, result, actor, now, [membership], () => true)[0]!
      .change,
  ).toEqual({ kind: 'return', lineId: 'return-line', original: null });
  expect(() =>
    prepareReceiptAnnotations(
      [{ ...revoke, original: { documentId: 'doc', receiptId: 'receipt-1', lineId: 'line-1' } }],
      request,
      result,
      actor,
      now,
      [membership],
      () => true,
    ),
  ).toThrow(/Conserved/);
});
