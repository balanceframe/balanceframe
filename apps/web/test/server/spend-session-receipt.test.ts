// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({
  context: vi.fn(),
  compare: vi.fn(),
  save: vi.fn(),
  actor: { actorId: 'selected-human' },
  options: [] as unknown[],
}));
vi.mock('../../server/utils/bounded-json', () => ({
  readEvidenceBody: async (event: { body: unknown }) => event.body,
}));
vi.mock('../../server/utils/transaction-evidence', () => ({
  evidenceRoute: (
    operation: (event: unknown, service: unknown, actor: unknown) => Promise<unknown>,
    options: unknown,
  ) => {
    deps.options.push(options);
    return (event: unknown) =>
      operation(
        event,
        {
          spendSessionReceiptContext: deps.context,
          compareSpendSessionReceipt: deps.compare,
          saveSpendSessionReceipt: deps.save,
        },
        deps.actor,
      );
  },
}));
import contextRoute from '../../server/api/evidence/session-context.post';
import compareRoute from '../../server/api/evidence/session-compare.post';
import saveRoute from '../../server/api/evidence/session-association.post';
const event = (body: unknown) => ({ body }) as unknown as Parameters<typeof contextRoute>[0];
const input = {
  sessionDocumentId: 'doc-session',
  receipt: { documentId: 'doc-receipt', receiptId: 'receipt-one' },
  review: { coverage: 'unknown', pairs: [], omittedItemIds: [], newLineIds: [] },
};
beforeEach(() => {
  deps.context.mockReset();
  deps.compare.mockReset();
  deps.save.mockReset();
});
describe('source-owned saved-session receipt routes', () => {
  it('uses server-selected identity and independent read, resolve and fresh-human controls', async () => {
    deps.context.mockResolvedValue({ receipts: [] });
    deps.compare.mockResolvedValue({ authority: 'comparison_only' });
    deps.save.mockResolvedValue({ saved: true });
    await contextRoute(event({ sessionDocumentId: 'doc-session' }));
    await compareRoute(event(input));
    await saveRoute(event({ ...input, comparisonHash: 'a'.repeat(64) }));
    expect(deps.context).toHaveBeenCalledWith(deps.actor, { sessionDocumentId: 'doc-session' });
    expect(deps.compare).toHaveBeenCalledWith(deps.actor, input);
    expect(deps.save).toHaveBeenCalledWith(deps.actor, {
      ...input,
      comparisonHash: 'a'.repeat(64),
    });
    expect(deps.options).toContainEqual({ write: true, capability: 'normalized-evidence' });
    expect(deps.options).toContainEqual({ write: true, capability: 'resolve' });
    expect(deps.options).toContainEqual({ write: true, human: true, capability: 'resolve' });
  });
  it('refuses supplied financial facts, identity, scope, policy, snapshots and malformed review selectors', async () => {
    for (const extra of [
      { actorId: 'forged' },
      { budgetId: 'other' },
      { policyVersion: 'forged' },
      { sessionSnapshot: {} },
      { ledgerEffect: {} },
      { comparisonHash: 'a'.repeat(64) },
    ])
      await expect(compareRoute(event({ ...input, ...extra }))).rejects.toThrow();
    await expect(
      contextRoute(event({ sessionDocumentId: 'doc-session', receipt: input.receipt })),
    ).rejects.toThrow();
    await expect(saveRoute(event({ ...input, comparisonHash: 'wrong' }))).rejects.toThrow();
    await expect(
      compareRoute(
        event({
          ...input,
          review: {
            ...input.review,
            pairs: [{ sessionItemId: 'one', receiptLineId: 'line', kind: 'automatically_trusted' }],
          },
        }),
      ),
    ).rejects.toThrow();
    expect(deps.context).not.toHaveBeenCalled();
    expect(deps.compare).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
  });
});
