// @vitest-environment node
import { expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({
  preview: vi.fn(),
  save: vi.fn(),
  options: [] as unknown[],
  actor: { actorId: 'human' },
}));
vi.mock('../../server/utils/bounded-json', () => ({
  readEvidenceBody: async (e: { body: unknown }) => e.body,
}));
vi.mock('../../server/utils/transaction-evidence', () => ({
  evidenceRoute: (f: (e: unknown, s: unknown, a: unknown) => unknown, o: unknown) => {
    deps.options.push(o);
    return (e: unknown) =>
      f(e, { previewAllocation: deps.preview, saveAllocation: deps.save }, deps.actor);
  },
}));
import preview from '../../server/api/evidence/allocation-preview.post';
import save from '../../server/api/evidence/allocation.post';
const selector = {
  resolutionHash: 'a'.repeat(64),
  targetTransactionIds: ['parent'],
  receiptIds: ['receipt'],
  lineCategories: [
    { receiptId: 'receipt', lineId: 'line', accountId: 'account', categoryId: 'food' },
  ],
  cells: [
    {
      receiptId: 'receipt',
      lineId: 'line',
      targetTransactionId: 'parent',
      amount: { minorUnits: '700', currency: 'USD' },
    },
  ],
};
const event = (body: unknown) => ({ body }) as unknown as Parameters<typeof save>[0];
it('previews selections read-only and saves exact manifests only through fresh human controls', async () => {
  await preview(event(selector));
  await save(event({ ...selector, allocationSetHash: 'b'.repeat(64) }));
  expect(deps.preview).toHaveBeenCalledWith(deps.actor, selector);
  expect(deps.save).toHaveBeenCalledWith(deps.actor, {
    ...selector,
    allocationSetHash: 'b'.repeat(64),
  });
  expect(deps.options).toContainEqual({ capability: 'resolve' });
  expect(deps.options).toContainEqual({ write: true, human: true, capability: 'resolve' });
  await expect(
    save(event({ ...selector, allocationSetHash: 'b'.repeat(64), ledgerEffect: {} })),
  ).rejects.toThrow();
});
