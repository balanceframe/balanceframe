// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({ context: vi.fn(), save: vi.fn(), actor: { actorId: 'selected-human' }, options: [] as unknown[] }));
vi.mock('../../server/utils/bounded-json', () => ({ readEvidenceBody: async (event: { body: unknown }) => event.body }));
vi.mock('../../server/utils/transaction-evidence', () => ({ evidenceRoute: (operation: (event: unknown, service: unknown, actor: unknown) => unknown, options: unknown) => { deps.options.push(options); return (event: unknown) => operation(event, { receiptReviewContext: deps.context, saveReceiptReview: deps.save }, deps.actor); } }));
import context from '../../server/api/evidence/receipt-review.get';
import save from '../../server/api/evidence/receipt-review.post';
const event = (body: unknown = {}) => ({ body }) as unknown as Parameters<typeof save>[0];
beforeEach(() => { deps.context.mockReset(); deps.save.mockReset(); });
it('keeps identity server-selected and relationship confirmation behind fresh human control', async () => {
  const body = { resolutionHash: 'a'.repeat(64), decisions: [{ kind: 'member', receiptId: 'receipt', lineId: 'line', membershipId: 'period' }] };
  await context(event()); await save(event(body));
  expect(deps.context).toHaveBeenCalledWith(deps.actor);
  expect(deps.save).toHaveBeenCalledWith(deps.actor, body);
  expect(deps.options).toContainEqual({ capability: 'resolve' });
  expect(deps.options).toContainEqual({ write: true, human: true, capability: 'resolve' });
});
it('rejects financial facts, source attestations and caller-assigned identity/provenance', async () => {
  const body = { resolutionHash: 'a'.repeat(64), decisions: [{ kind: 'return', receiptId: 'receipt', lineId: 'line', original: null }] };
  for (const extra of [{ actorId: 'forged' }, { policyVersion: 'forged' }, { ledgerEffect: {} }]) await expect(save(event({ ...body, ...extra }))).rejects.toThrow();
  await expect(save(event({ ...body, decisions: [{ ...body.decisions[0], reviewedAt: '2026-10-21T00:00:00Z' }] }))).rejects.toThrow();
  await expect(save(event({ ...body, decisions: [{ kind: 'member', receiptId: 'receipt', lineId: 'line', member: { actorId: 'forged' } }] }))).rejects.toThrow();
  expect(deps.save).not.toHaveBeenCalled();
});
