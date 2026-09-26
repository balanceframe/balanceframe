import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getRouterParam } = vi.hoisted(() => ({ getRouterParam: vi.fn() }));
vi.mock('h3', () => ({ getRouterParam }));
vi.mock('../../server/utils/liquidity-service', () => ({
  liquidityRoute: (operation: unknown) => operation,
}));

import handler from '../../server/api/spend-sessions/[id]/completions/[proposalId].get';

const actor = { actorId: 'coapprover', budgetId: 'fixture-budget' };
const proposal = {
  id: 'completion-1',
  phase: 'proposed',
  debit: {
    accountId: 'checking',
    amount: -5500,
    date: '2026-09-06',
    payeeName: 'Fixture shop',
    notes: 'Order 1',
    categoryCharges: [],
    splits: [],
  },
};

beforeEach(() => {
  getRouterParam.mockImplementation((event: { params: Record<string, string> }, name: string) => event.params[name]);
});

describe('GET scoped session completion proposal', () => {
  it('requires the proposal to be present in the actor-scoped session list before reading it', async () => {
    const sessionCompletions = vi.fn().mockResolvedValue([proposal]);
    const sessionCompletion = vi.fn().mockResolvedValue(proposal);
    const service = { sessionCompletions, sessionCompletion };

    const result = await (handler as unknown as Function)(
      { params: { id: 'owner-session', proposalId: 'completion-1' } },
      service,
      actor,
    );

    expect(result).toBe(proposal);
    expect(sessionCompletions).toHaveBeenCalledWith(actor, 'owner-session');
    expect(sessionCompletion).toHaveBeenCalledWith(actor, 'completion-1');
  });

  it('does not read a proposal absent from the actor-scoped list', async () => {
    const sessionCompletions = vi.fn().mockResolvedValue([]);
    const sessionCompletion = vi.fn();
    const service = { sessionCompletions, sessionCompletion };

    await expect(
      (handler as unknown as Function)(
        { params: { id: 'owner-session', proposalId: 'private-proposal' } },
        service,
        actor,
      ),
    ).rejects.toThrow('Proposal unavailable');
    expect(sessionCompletion).not.toHaveBeenCalled();
  });

  it('does not accept a proposal filtered out for another session id', async () => {
    const sessionCompletions = vi.fn().mockResolvedValue([]);
    const sessionCompletion = vi.fn();
    const service = { sessionCompletions, sessionCompletion };

    await expect(
      (handler as unknown as Function)(
        { params: { id: 'different-session', proposalId: 'completion-1' } },
        service,
        actor,
      ),
    ).rejects.toThrow('Proposal unavailable');
    expect(sessionCompletion).not.toHaveBeenCalled();
  });
});
