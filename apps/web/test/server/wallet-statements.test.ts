// @vitest-environment node
import { expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({
  context: vi.fn(),
  preview: vi.fn(),
  attest: vi.fn(),
  revoke: vi.fn(),
  actor: { actorId: 'human' },
  options: [] as unknown[],
}));
vi.mock('../../server/utils/bounded-json', () => ({
  readEvidenceBody: async (e: { body: unknown }) => e.body,
}));
vi.mock('../../server/utils/transaction-evidence', () => ({
  evidenceRoute: (f: (e: unknown, s: unknown, a: unknown) => unknown, o: unknown) => {
    deps.options.push(o);
    return (e: unknown) =>
      f(
        e,
        {
          walletStatementContext: deps.context,
          previewWalletStatement: deps.preview,
          attestWalletStatement: deps.attest,
          revokeWalletStatement: deps.revoke,
        },
        deps.actor,
      );
  },
}));
import context from '../../server/api/evidence/wallet-statements/index.get';
import preview from '../../server/api/evidence/wallet-statements/preview.post';
import attest from '../../server/api/evidence/wallet-statements/index.post';
import revoke from '../../server/api/evidence/wallet-statements/revoke.post';
const selector = {
  statementDocumentId: 'document',
  wallet: { kind: 'new', label: 'Wallet', currency: 'USD' },
  startDate: '2026-10-01',
  endDate: '2026-10-20',
  openingBalance: { minorUnits: '100', currency: 'USD' },
  closingBalance: null,
};
const body = {
  ...selector,
  previewHash: 'a'.repeat(64),
  expectedProofFoldHash: 'b'.repeat(64),
  originalAcknowledged: true,
  completeActivityAcknowledged: true,
};
const event = (value: unknown = {}) => ({ body: value }) as unknown as Parameters<typeof attest>[0];
it('uses selected identity and fresh human attest/revoke without accepting provider authority or source proof', async () => {
  await context(event());
  await preview(event(selector));
  await attest(event(body));
  await revoke(event({ proofId: 'proof', expectedProofFoldHash: 'b'.repeat(64) }));
  expect(deps.context).toHaveBeenCalledWith(deps.actor);
  expect(deps.preview).toHaveBeenCalledWith(deps.actor, selector);
  expect(deps.attest).toHaveBeenCalledWith(deps.actor, body);
  expect(deps.options).toContainEqual({ write: true, human: true, capability: 'resolve' });
  for (const extra of [
    { actorId: 'forged' },
    { activityManifest: [] },
    { authorityKind: 'provider_authenticated' },
  ])
    await expect(attest(event({ ...body, ...extra }))).rejects.toThrow();
  await expect(attest(event({ ...body, completeActivityAcknowledged: false }))).rejects.toThrow();
});
