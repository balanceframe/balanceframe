// @vitest-environment node
vi.mock('../../server/utils/bounded-json', () => ({
  readEvidenceBody: async (event: { body: unknown }) => event.body,
}));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../../../protocol/fixtures/transaction-evidence-projection-result.json';
import actionFixture from '../../../../protocol/fixtures/consequential-evidence-actions.json';
const deps = vi.hoisted(() => ({
  prepare: vi.fn(),
  propose: vi.fn(),
  actor: {
    actorId: 'actor',
    spaceId: 'space',
    budgetId: 'budget',
    governancePolicyVersion: 'current-policy',
  },
}));
vi.mock('h3', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readBody: async (event: { body: unknown }) => event.body,
}));
vi.mock('../../server/utils/transaction-evidence', () => ({
  evidenceRoute:
    (operation: (event: unknown, service: unknown, actor: unknown) => Promise<unknown>) =>
    (event: unknown) =>
      operation(event, { prepareLedgerAction: deps.prepare }, deps.actor),
}));
vi.mock('../../server/utils/liquidity-service', () => ({
  createWebConsequentialActionService: async () => ({ propose: deps.propose }),
}));
vi.mock('../../server/utils/workflow-store', () => ({ getWorkflowStore: () => ({ store: {} }) }));
import route from '../../server/api/evidence/proposal.post';
beforeEach(() => {
  deps.prepare.mockReset();
  deps.propose.mockReset().mockResolvedValue({ id: 'proposal-1' });
});
const event = (body: unknown) => ({ body }) as unknown as Parameters<typeof route>[0];
const body = { resolutionHash: fixture.resolutionHash, eventId: fixture.events[0]!.id };
describe('source-bound governed evidence proposals', () => {
  it.each([
    actionFixture.creditIntent,
    actionFixture.amendmentIntent,
    {
      kind: 'evidence_projection',
      evidenceIds: fixture.events[0]!.evidenceIds,
      transaction: {
        ...fixture.events[0]!.projectionObservation!.ledgerEffect,
        parentId: 'prepared-parent',
        correlationId: 'prepared-correlation',
      },
    },
  ])(
    'uses the current derived $kind intent without accepting caller financial fields',
    async (action) => {
      deps.prepare.mockResolvedValue(action);
      expect(await route(event(body))).toEqual({ proposalId: 'proposal-1' });
      expect(deps.propose).toHaveBeenCalledWith(deps.actor, { action });
      expect(deps.prepare).toHaveBeenCalledWith(deps.actor, {
        ...body,
        parentId: expect.stringMatching(/^evidence-[a-f0-9]{64}$/),
        correlationId: expect.stringMatching(/^evidence-[a-f0-9]{64}$/),
      });
      const identity = deps.prepare.mock.calls[0]![1].parentId;
      await route(event(body));
      expect(deps.prepare.mock.calls[1]![1].parentId).toBe(identity);
    },
  );
  it('refuses stale source outcomes and authority-bearing selectors before proposing any write', async () => {
    await expect(route(event({ ...body, transaction: { amount: '1' } }))).rejects.toThrow();
    await expect(
      route(event({ ...body, kind: 'evidence_credit', actorId: 'forged' })),
    ).rejects.toThrow();
    expect(deps.prepare).not.toHaveBeenCalled();
    deps.prepare.mockRejectedValue(new Error('Current evidence source changed'));
    await expect(route(event(body))).rejects.toThrow(/changed/);
    expect(deps.propose).not.toHaveBeenCalled();
  });
});

it('derives an exact allocation composite without injecting singleton parent identities', async () => {
  const action = { kind: 'composite', actions: [actionFixture.amendmentIntent] };
  deps.prepare.mockResolvedValue(action);
  const selector = { ...body, allocationSetHash: 'b'.repeat(64) };
  await route(event(selector));
  expect(deps.prepare).toHaveBeenCalledWith(deps.actor, selector);
  expect(deps.propose).toHaveBeenCalledWith(deps.actor, { action });
});
