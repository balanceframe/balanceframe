import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import type { EvidenceDocument, ReceiptVersionLink } from '@balanceframe/workflow-store';
import {
  prepareReceiptVersionLink,
  receiptVersionDocuments,
  ReceiptVersionService,
} from '../src/evidence-receipt-version.js';
const fixture = JSON.parse(
  readFileSync(
    new URL('../../../protocol/fixtures/transaction-evidence-receipt.json', import.meta.url),
    'utf8',
  ),
);
const actor = { actorId: 'owner', membershipId: 'member', governancePolicyVersion: 'policy' };
const now = '2026-10-21T12:00:00.000Z';
function document(name: string): EvidenceDocument {
  const receipt = structuredClone(fixture.receipts[0]);
  receipt.id = `${name}:receipt`;
  receipt.observationId = `${name}:observation`;
  receipt.tenders = receipt.tenders.map((t: { id: string }) => ({
    ...t,
    id: `${name}:${t.id}`,
    observationId: null,
  }));
  receipt.lines = receipt.lines.map((line: { id: string }) => ({
    ...line,
    id: `${name}:${line.id}`,
  }));
  const { provenance: _provenance, ...o } = fixture.observations[0];
  return {
    id: name,
    scope: { spaceId: 'space', budgetId: 'budget', connectionId: 'connection' },
    connectorId: 'camera',
    sourceId: `${name}.jpg`,
    contentHash:
      name === 'parent' ? 'a'.repeat(64) : name === 'child' ? 'b'.repeat(64) : 'c'.repeat(64),
    parserVersion: 'retail-photo-user-v1',
    privateActorId: 'owner',
    sourceTimestamp: now,
    receivedAt: now,
    retentionUntil: '2026-10-22T00:00:00.000Z',
    mediaType: 'image/jpeg',
    parseStatus: 'parsed',
    supersedesId: null,
    quality: [],
    extraction: {
      templateVersion: 'retail-v1',
      observations: [
        {
          ...o,
          id: receipt.observationId,
          kind: 'receipt',
          counterparty: 'Retailer',
          externalEventId: null,
          eventType: 'purchase',
        },
      ],
      receipts: [receipt],
      relationships: [],
      wallets: [],
    },
  };
}
const ref = (d: EvidenceDocument) => ({ documentId: d.id, receiptId: `${d.id}:receipt` });
function prepare(
  child: EvidenceDocument,
  parent: EvidenceDocument,
  readable: EvidenceDocument[],
  links: ReceiptVersionLink[] = [],
) {
  return prepareReceiptVersionLink(
    { child: ref(child), predecessor: ref(parent) },
    [child],
    readable,
    links,
    actor,
    now,
  );
}
describe('exact reviewed receipt version normalization', () => {
  it('overlays structural lineage without rewriting original extraction or fabricating source-document ancestry', () => {
    const parent = document('parent'),
      child = document('child');
    const original = structuredClone([parent, child]);
    const link = prepare(child, parent, [parent, child]);
    const plan = receiptVersionDocuments([child], [parent, child], [link], [], actor);
    expect(plan.documents).toHaveLength(2);
    const current = plan.documents.find((d) => d.id === 'child')!;
    expect(current.extraction.receipts).toMatchObject([
      { version: 2, supersedesId: 'parent:receipt' },
    ]);
    expect(plan.documents.find((d) => d.id === 'parent')!.extraction.observations).toMatchObject([
      { status: 'superseded' },
    ]);
    expect([parent, child]).toEqual(original);
    expect(current.supersedesId).toBeNull();
    expect(plan.blockedChildren).toEqual([]);
  });
  it('retains only explicitly reachable independently readable history and invalidates descendants when parent proof is revoked', () => {
    const a = document('parent'),
      b = document('child'),
      c = document('third');
    const ab = prepare(b, a, [a, b]);
    const bc = prepare(c, b, [a, b, c], [ab]);
    expect(bc.predecessorVersion).toBe(2);
    const complete = receiptVersionDocuments([c], [a, b, c], [ab, bc], [], actor);
    expect(complete.documents.map((d) => d.id).sort()).toEqual(['child', 'parent', 'third']);
    expect(complete.documents.find((d) => d.id === 'third')!.extraction.receipts).toMatchObject([
      { version: 3 },
    ]);
    const revoked = receiptVersionDocuments([c], [a, b, c], [bc], [], actor);
    expect(revoked.blockedChildren.map((v) => v.child.documentId)).toEqual(['third']);
    expect(revoked.documents).toHaveLength(1);
    expect(revoked.documents[0]!.extraction.receipts).toEqual([]);
    expect(receiptVersionDocuments([c], [a, b, c], [ab], [], actor).documents).toHaveLength(1);
  });
  it('does not restore history after a source grant, parser, exact content or review scope changes', () => {
    const a = document('parent'),
      b = document('child');
    const link = prepare(b, a, [a, b]);
    for (const parents of [
      [b],
      [{ ...a, contentHash: 'f'.repeat(64) }, b],
      [{ ...a, parserVersion: 'other' }, b],
    ]) {
      const plan = receiptVersionDocuments([b], parents, [link], [], actor);
      expect(plan.blockedChildren).toHaveLength(1);
      expect(plan.documents[0]!.extraction.receipts).toEqual([]);
    }
    expect(
      receiptVersionDocuments([b], [a, b], [link], [], { ...actor, membershipId: 'new' }).documents,
    ).toHaveLength(1);
  });
  it('rejects cross-owner/connector/merchant/currency/direction and mismatched stable identities instead of guessing', () => {
    const a = document('parent'),
      b = document('child');
    for (const change of [
      { connectorId: 'other' },
      { privateActorId: null },
      { scope: { ...a.scope, budgetId: 'other' } },
    ])
      expect(() => prepare(b, { ...a, ...change }, [{ ...a, ...change }, b])).toThrow();
    for (const change of [
      { counterparty: null },
      { counterparty: 'Other' },
      { direction: 'inflow' },
      { externalEventId: 'other' },
    ]) {
      const bad = structuredClone(a);
      Object.assign((bad.extraction.observations as object[])[0]!, change);
      expect(() => prepare(b, bad, [bad, b])).toThrow();
    }
  });
  it('rejects forks/cycles/overflow and preserves unrelated receipt activity when a child closure blocks', () => {
    const a = document('parent'),
      b = document('child'),
      c = document('third');
    const ab = prepare(b, a, [a, b]);
    expect(() => prepare(c, a, [a, b, c], [ab])).toThrow(/fork/i);
    const bad = { ...ab, predecessor: { ...ab.child }, predecessorVersion: 1, version: 2 };
    expect(() => receiptVersionDocuments([b], [a, b], [bad], [], actor)).toThrow(/cycle/i);
    const unrelated = document('other');
    const plan = receiptVersionDocuments([b, unrelated], [b, unrelated], [ab], [], actor);
    expect(plan.documents.find((d) => d.id === 'other')!.extraction.receipts).toHaveLength(1);
    const max = structuredClone(a);
    (max.extraction.receipts as { version: number }[])[0]!.version = 4294967295;
    expect(() => prepare(b, max, [max, b])).toThrow(/version|overflow/i);
  });
});

function serviceSetup() {
  const parent = document('parent'),
    child = document('child');
  let allowed = true,
    foldHash = 'd'.repeat(64),
    links: ReceiptVersionLink[] = [];
  const access = { scope: child.scope, actorId: actor.actorId, now, authorize: () => allowed };
  const state = () => ({ foldHash, links, blockedChildren: [] });
  const append = vi.fn();
  const revoke = vi.fn();
  const native = createRequire(import.meta.url)(
    '../../../crates/node-binding/balanceframe.node',
  ) as { resolveTransactionEvidence(input: string): string };
  const normalize = (
    _actor: unknown,
    _capture: unknown,
    plan: { documents: EvidenceDocument[] },
  ) => ({
    contractVersion: '1' as const,
    policyVersion: 'policy',
    maxSettlementDays: 5,
    wallets: [],
    relationships: [],
    receipts: plan.documents.flatMap((d) => d.extraction.receipts as typeof fixture.receipts),
    observations: plan.documents.flatMap((d) =>
      (d.extraction.observations as typeof fixture.observations).map((o) => ({
        ...o,
        sourceId: 'same-authorized-camera-source',
        reliability: 0,
        reviewedLedgerEffect: false,
        provenance: {
          documentId: d.id,
          contentHash: d.contentHash,
          parserVersion: d.parserVersion,
          sourceTimestamp: d.sourceTimestamp,
          receivedAt: d.receivedAt,
        },
      })),
    ),
  });
  const capture = async () => ({
    scope: child.scope,
    currentDocuments: [child],
    readableDocuments: [parent, child],
    request: normalize(null, null, { documents: [child] }),
    authorize: () => allowed,
  });
  const host = {
    store: {
      evidence: {
        receiptVersions: { state, link: append, revoke },
        get: (_access: unknown, id: string) => [parent, child].find((d) => d.id === id) ?? null,
        isCurrent: (_access: unknown, id: string) => id === child.id,
      },
    },
    now: () => now,
    fresh: vi.fn(),
    native,
    capture,
    normalize,
    access: () => access,
  };
  const service = new ReceiptVersionService(
    host as unknown as ConstructorParameters<typeof ReceiptVersionService>[0],
  );
  return {
    service,
    parent,
    child,
    host,
    state,
    append,
    revoke,
    setAllowed: (v: boolean) => (allowed = v),
    setFold: (v: string) => (foldHash = v),
    setLinks: (v: ReceiptVersionLink[]) => (links = v),
  };
}
describe('fresh human receipt version service', () => {
  it('previews exact native conserved closure then saves only after exact fresh confirmation', async () => {
    const s = serviceSetup();
    const context = await s.service.context({ ...actor, auth: {} } as never);
    const selectors = {
      resolutionHash: context.resolutionHash,
      child: ref(s.child),
      predecessor: ref(s.parent),
    };
    const preview = await s.service.preview({ ...actor, auth: {} } as never, selectors);
    expect(preview.version).toBe(2);
    expect(preview.child.contentHash).toBe(s.child.contentHash);
    expect(s.append).not.toHaveBeenCalled();
    await s.service.save({ ...actor, auth: {} } as never, {
      ...selectors,
      previewHash: preview.previewHash,
      expectedFoldHash: preview.foldHash,
      sameReceiptAcknowledged: true,
    });
    expect(s.append).toHaveBeenCalledOnce();
    expect(s.append.mock.calls[0]![1].link).toMatchObject({
      version: 2,
      identityBasis: 'human_attested_same_receipt',
      actorId: actor.actorId,
    });
    expect(s.host.fresh).toHaveBeenCalledTimes(2);
  });
  it('rejects stale preview/fold, tampered claims and revoked authority before append', async () => {
    const s = serviceSetup();
    const context = await s.service.context({ ...actor, auth: {} } as never);
    const input = {
      resolutionHash: context.resolutionHash,
      child: ref(s.child),
      predecessor: ref(s.parent),
    };
    const preview = await s.service.preview({ ...actor, auth: {} } as never, input);
    for (const change of [
      { previewHash: 'f'.repeat(64) },
      { expectedFoldHash: 'f'.repeat(64) },
      { actorId: 'forged' },
      { sameReceiptAcknowledged: false },
    ])
      await expect(
        s.service.save({ ...actor, auth: {} } as never, {
          ...input,
          previewHash: preview.previewHash,
          expectedFoldHash: preview.foldHash,
          sameReceiptAcknowledged: true,
          ...change,
        }),
      ).rejects.toThrow();
    s.setAllowed(false);
    await expect(
      s.service.save({ ...actor, auth: {} } as never, {
        ...input,
        previewHash: preview.previewHash,
        expectedFoldHash: preview.foldHash,
        sameReceiptAcknowledged: true,
      }),
    ).rejects.toThrow();
    expect(s.append).not.toHaveBeenCalled();
  });
  it('uses immutable tombstones for revocation without requiring predecessor capture or bytes', async () => {
    const s = serviceSetup();
    await s.service.revoke({ ...actor, auth: {} } as never, {
      childDocumentId: s.child.id,
      childReceiptId: 'child:receipt',
      expectedFoldHash: s.state().foldHash,
    });
    expect(s.revoke).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        childDocumentId: s.child.id,
        membershipId: 'member',
        policyVersion: 'policy',
      }),
    );
    expect(s.append).not.toHaveBeenCalled();
  });
});
it('preserves every unreviewed legacy receipt byte and native failure instead of silently repairing source facts', () => {
  const legacy = document('parent');
  (legacy.extraction.observations as { kind: string }[])[0]!.kind = 'wallet_payment';
  const plan = receiptVersionDocuments([legacy], [legacy], [], [], actor);
  expect(plan.documents).toEqual([legacy]);
  const invalid = document('child');
  (
    invalid.extraction.receipts as { total: { minorUnits: string; currency: string } }[]
  )[0]!.total.currency = 'EUR';
  expect(receiptVersionDocuments([invalid], [invalid], [], [], actor).documents).toEqual([invalid]);
});
it('retains same-document original invoice ancestry when a later photo is explicitly reviewed', () => {
  const parent = document('parent'),
    child = document('child');
  const prior = structuredClone((parent.extraction.receipts as typeof fixture.receipts)[0]);
  prior.id = 'original-receipt';
  prior.observationId = 'original-source';
  prior.lines[0].id = 'original-line';
  const priorSource = structuredClone(
    (parent.extraction.observations as typeof fixture.observations)[0],
  );
  priorSource.id = prior.observationId;
  (parent.extraction.receipts as typeof fixture.receipts)[0].version = 2;
  (parent.extraction.receipts as typeof fixture.receipts)[0].supersedesId = prior.id;
  (parent.extraction.receipts as typeof fixture.receipts).push(prior);
  (parent.extraction.observations as typeof fixture.observations).push(priorSource);
  const link = prepare(child, parent, [parent, child]);
  expect(link.version).toBe(3);
  expect(
    receiptVersionDocuments([child], [parent, child], [link], [], actor).documents.find(
      (d) => d.id === 'parent',
    )!.extraction.receipts,
  ).toHaveLength(2);
});
it('refuses concurrent review changes, stale human control and invalid native child conservation', async () => {
  const concurrent = serviceSetup();
  const actorInput = { ...actor, auth: {} } as never;
  const before = await concurrent.service.context(actorInput);
  const resolve = concurrent.host.native.resolveTransactionEvidence;
  concurrent.host.native.resolveTransactionEvidence = (input: string) => {
    const value = resolve(input);
    concurrent.setFold('f'.repeat(64));
    return value;
  };
  await expect(
    concurrent.service.preview(actorInput, {
      resolutionHash: before.resolutionHash,
      child: ref(concurrent.child),
      predecessor: ref(concurrent.parent),
    }),
  ).rejects.toThrow(/changed/i);
  expect(concurrent.append).not.toHaveBeenCalled();
  const invalid = serviceSetup();
  (invalid.child.extraction.receipts as typeof fixture.receipts)[0].lines[0].net.minorUnits =
    '1199';
  const context = await invalid.service.context(actorInput);
  await expect(
    invalid.service.preview(actorInput, {
      resolutionHash: context.resolutionHash,
      child: ref(invalid.child),
      predecessor: ref(invalid.parent),
    }),
  ).rejects.toThrow(/conserved/i);
  expect(invalid.append).not.toHaveBeenCalled();
  invalid.host.fresh.mockImplementation(() => {
    throw new Error('Fresh human required');
  });
  await expect(
    invalid.service.revoke(actorInput, {
      childDocumentId: invalid.child.id,
      childReceiptId: 'child:receipt',
      expectedFoldHash: invalid.state().foldHash,
    }),
  ).rejects.toThrow(/Fresh/);
});
it('withholds choices without logical retailer identity and requires current review membership', async () => {
  const s = serviceSetup();
  (s.child.extraction.observations as { counterparty: string | null }[])[0]!.counterparty = null;
  const context = await s.service.context({ ...actor, auth: {} } as never);
  expect(context.children).toEqual([]);
  await expect(
    s.service.context({ ...actor, membershipId: undefined, auth: {} } as never),
  ).rejects.toThrow(/scope/);
});
it('blocks a descendant preview when a retained parent has an inaccessible reviewed ancestor', () => {
  const parent = document('parent'),
    child = document('child');
  const parentSource = {
    documentId: parent.id,
    receiptId: 'parent:receipt',
    contentHash: parent.contentHash,
    parserVersion: parent.parserVersion,
  };
  expect(() =>
    prepareReceiptVersionLink(
      { child: ref(child), predecessor: ref(parent) },
      [child],
      [parent, child],
      [],
      actor,
      now,
      [{ child: parentSource, reasonCode: 'reviewed_receipt_history_unavailable' }],
    ),
  ).toThrow(/unavailable/i);
});
