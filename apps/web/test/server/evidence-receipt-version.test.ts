// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({
  context: vi.fn(),
  preview: vi.fn(),
  save: vi.fn(),
  revoke: vi.fn(),
  actor: { actorId: 'selected-human' },
  options: [] as unknown[],
}));
vi.mock('../../server/utils/bounded-json', () => ({
  readEvidenceBody: async (event: { body: unknown }) => event.body,
}));
vi.mock('../../server/utils/transaction-evidence', () => ({
  evidenceRoute: (
    operation: (event: unknown, service: unknown, actor: unknown) => unknown,
    options: unknown,
  ) => {
    deps.options.push(options);
    return (event: unknown) =>
      operation(
        event,
        {
          receiptVersionContext: deps.context,
          previewReceiptVersion: deps.preview,
          saveReceiptVersion: deps.save,
          revokeReceiptVersion: deps.revoke,
        },
        deps.actor,
      );
  },
}));
import context from '../../server/api/evidence/receipt-versions/index.get';
import preview from '../../server/api/evidence/receipt-versions/preview.post';
import save from '../../server/api/evidence/receipt-versions/save.post';
import revoke from '../../server/api/evidence/receipt-versions/revoke.post';
const event = (body: unknown = {}) => ({ body }) as unknown as Parameters<typeof save>[0];
const input = {
  resolutionHash: 'a'.repeat(64),
  child: { documentId: 'child', receiptId: 'receipt-new' },
  predecessor: { documentId: 'parent', receiptId: 'receipt-old' },
};
beforeEach(() => {
  deps.context.mockReset();
  deps.preview.mockReset();
  deps.save.mockReset();
  deps.revoke.mockReset();
});
it('keeps server-selected actor and fresh human controls on append and revocation', async () => {
  await context(event());
  await preview(event(input));
  await save(
    event({
      ...input,
      previewHash: 'b'.repeat(64),
      expectedFoldHash: 'c'.repeat(64),
      sameReceiptAcknowledged: true,
    }),
  );
  await revoke(
    event({
      childDocumentId: 'child',
      childReceiptId: 'receipt-new',
      expectedFoldHash: 'c'.repeat(64),
    }),
  );
  expect(deps.context).toHaveBeenCalledWith(deps.actor);
  expect(deps.preview).toHaveBeenCalledWith(deps.actor, input);
  expect(deps.save).toHaveBeenCalledOnce();
  expect(deps.revoke).toHaveBeenCalledOnce();
  expect(
    deps.options.filter(
      (o) =>
        JSON.stringify(o) === JSON.stringify({ write: true, human: true, capability: 'resolve' }),
    ),
  ).toHaveLength(2);
});
it('refuses forged lineage/version, financial fields and caller provenance', async () => {
  for (const extra of [
    { actorId: 'forged' },
    { version: 99 },
    { predecessorLineageHash: 'a'.repeat(64) },
    { ledgerEffect: {} },
    { child: { ...input.child, contentHash: 'a'.repeat(64) } },
  ])
    await expect(preview(event({ ...input, ...extra }))).rejects.toThrow();
  await expect(
    save(
      event({
        ...input,
        previewHash: 'b'.repeat(64),
        expectedFoldHash: 'c'.repeat(64),
        sameReceiptAcknowledged: false,
      }),
    ),
  ).rejects.toThrow();
  expect(deps.preview).not.toHaveBeenCalled();
  expect(deps.save).not.toHaveBeenCalled();
});
