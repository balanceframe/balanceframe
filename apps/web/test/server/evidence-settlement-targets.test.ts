// @vitest-environment node
vi.mock('../../server/utils/bounded-json', () => ({
  readEvidenceBody: async (event: { body: unknown }) => event.body,
}));
import { describe, expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({ targets: vi.fn(), actor: { actorId: 'selected-human' } }));
vi.mock('h3', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readBody: async (event: { body: unknown }) => event.body,
}));
vi.mock('../../server/utils/transaction-evidence', () => ({
  evidenceRoute:
    (operation: (event: unknown, service: unknown, actor: unknown) => Promise<unknown>) =>
    (event: unknown) =>
      operation(event, { settlementTargets: deps.targets }, deps.actor),
}));
import route from '../../server/api/evidence/settlement-targets.post';
const event = (body: unknown) => ({ body }) as unknown as Parameters<typeof route>[0];
describe('current permitted settlement targets', () => {
  it('delegates the exact current event/account selector under server-selected identity', async () => {
    const body = { resolutionHash: 'a'.repeat(64), eventId: 'event', accountId: 'checking' };
    deps.targets.mockResolvedValue({ transactions: [] });
    expect(await route(event(body))).toEqual({ transactions: [] });
    expect(deps.targets).toHaveBeenCalledWith(deps.actor, body);
  });
  it('rejects forged source authority and malformed selectors', async () => {
    deps.targets.mockClear();
    await expect(
      route(event({ resolutionHash: 'bad', eventId: 'event', accountId: 'checking' })),
    ).rejects.toThrow();
    await expect(
      route(
        event({
          resolutionHash: 'a'.repeat(64),
          eventId: 'event',
          accountId: 'checking',
          actorId: 'forged',
        }),
      ),
    ).rejects.toThrow();
    expect(deps.targets).not.toHaveBeenCalled();
  });
});
