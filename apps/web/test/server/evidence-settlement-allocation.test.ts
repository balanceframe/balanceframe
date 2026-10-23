// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({
  actor: { actorId: 'selected-human' },
  preview: vi.fn(),
  save: vi.fn(),
  options: [] as Array<Record<string, unknown>>,
}));
vi.mock('../../server/utils/bounded-json', () => ({
  readEvidenceBody: async (event: { body: unknown }) => event.body,
}));
vi.mock('../../server/utils/transaction-evidence', () => ({
  evidenceRoute: (
    operation: (event: unknown, service: unknown, actor: unknown) => unknown,
    options: Record<string, unknown>,
  ) => {
    deps.options.push(options);
    return (event: unknown) =>
      operation(
        event,
        { previewSettlementAllocation: deps.preview, saveSettlementAllocation: deps.save },
        deps.actor,
      );
  },
}));
import preview from '../../server/api/evidence/settlement-preview.post';
import save from '../../server/api/evidence/settlement-allocation.post';
const input = {
  resolutionHash: 'a'.repeat(64),
  targetTransactionId: 'actual-1',
  receiptIds: ['receipt-1', 'receipt-2'],
  lineCategories: [{ receiptId: 'receipt-1', lineId: 'line-1', categoryId: 'food' }],
};
const event = (body: unknown) => ({ body }) as never;
beforeEach(() => {
  deps.preview.mockReset().mockResolvedValue({ preview: true });
  deps.save.mockReset().mockResolvedValue({ saved: true });
});
describe('whole receipt settlement allocation boundaries', () => {
  it('uses bounded selectors with selected actor and requires fresh human save', async () => {
    expect(await preview(event(input))).toEqual({ preview: true });
    expect(deps.preview).toHaveBeenCalledWith(deps.actor, input);
    const body = { ...input, allocationHash: 'b'.repeat(64) };
    expect(await save(event(body))).toEqual({ saved: true });
    expect(deps.save).toHaveBeenCalledWith(deps.actor, body);
    expect(deps.options).toContainEqual({ write: true, human: true, capability: 'resolve' });
  });
  it('rejects caller-authored amounts, edges, effects, source and identity claims', async () => {
    for (const key of [
      'actorId',
      'relationships',
      'ledgerEffect',
      'amount',
      'policyVersion',
      'sources',
    ])
      await expect(preview(event({ ...input, [key]: 'forged' }))).rejects.toThrow();
    await expect(save(event(input))).rejects.toThrow();
    await expect(preview(event({ ...input, receiptIds: Array(101).fill('r') }))).rejects.toThrow();
    await expect(
      preview(event({ ...input, lineCategories: [{ ...input.lineCategories[0], amount: '400' }] })),
    ).rejects.toThrow();
    expect(deps.preview).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
  });
});
