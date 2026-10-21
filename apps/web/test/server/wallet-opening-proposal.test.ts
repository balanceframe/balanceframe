// @vitest-environment node
import { expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({
  prepare: vi.fn(),
  propose: vi.fn(),
  actor: { actorId: 'human' },
}));
vi.mock('../../server/utils/bounded-json', () => ({
  readEvidenceBody: async (e: { body: unknown }) => e.body,
}));
vi.mock('../../server/utils/transaction-evidence', () => ({
  evidenceRoute: (f: (e: unknown, s: unknown, a: unknown) => unknown) => (e: unknown) =>
    f(e, { prepareWalletMaterialization: deps.prepare }, deps.actor),
}));
vi.mock('../../server/utils/workflow-store', () => ({ getWorkflowStore: () => ({ store: {} }) }));
vi.mock('../../server/utils/liquidity-service', () => ({
  createWebConsequentialActionService: async () => ({ propose: deps.propose }),
}));
import route from '../../server/api/evidence/wallet-statements/proposal.post';
const selector = {
  resolutionHash: 'a'.repeat(64),
  walletId: 'wallet',
  proofSetHash: 'b'.repeat(64),
  activityManifestHash: 'c'.repeat(64),
  asOfDate: '2026-10-01',
  accountName: 'Reviewed wallet',
};
it('derives exact native opening equity and creates an ordinary proposal without accepting amounts or approving execution', async () => {
  const action = {
    kind: 'wallet_materialization',
    walletId: 'wallet',
    accountName: 'Reviewed wallet',
    currency: 'USD',
    opening: {
      amount: { minorUnits: '100', currency: 'USD' },
      date: '2026-10-01',
      proofSetHash: selector.proofSetHash,
      activityManifestHash: selector.activityManifestHash,
    },
  };
  deps.prepare.mockResolvedValue(action);
  deps.propose.mockResolvedValue({ id: 'proposal' });
  expect(await route({ body: selector } as never)).toEqual({ proposalId: 'proposal' });
  expect(deps.prepare).toHaveBeenCalledWith(deps.actor, selector);
  expect(deps.propose).toHaveBeenCalledWith(deps.actor, { action });
  await expect(
    route({ body: { ...selector, amount: { minorUnits: '999', currency: 'USD' } } } as never),
  ).rejects.toThrow();
});
