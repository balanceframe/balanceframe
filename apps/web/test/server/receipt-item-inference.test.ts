// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({
  actor: { actorId: 'selected' },
  service: {
    receiptInferencePreview: vi.fn(),
    receiptInferenceRun: vi.fn(),
    receiptInferenceWithdraw: vi.fn(),
    receiptInferencePolicy: vi.fn(),
    updateReceiptInferencePolicy: vi.fn(),
  },
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
    return (event: unknown) => operation(event, deps.service, deps.actor);
  },
}));
import preview from '../../server/api/evidence/inference/preview.post';
import run from '../../server/api/evidence/inference/run.post';
import withdraw from '../../server/api/evidence/inference/withdraw.post';
import policy from '../../server/api/evidence/inference/policy.post';
import update from '../../server/api/evidence/inference/policy-update.post';
const event = (body: unknown) => ({ body }) as never;
beforeEach(() =>
  Object.values(deps.service).forEach((method) =>
    method.mockReset().mockResolvedValue({ state: 'manual' }),
  ),
);
describe('receipt-only inference routes', () => {
  it('uses selected actor, strict selectors and human proof for consent and policy controls', async () => {
    const selection = {
      accountId: 'checking',
      receiptId: 'receipt',
      lineId: 'line',
      locality: 'external',
    };
    const consent = { previewId: 'preview', payloadHash: 'a'.repeat(64) };
    await preview(event(selection));
    await run(event(consent));
    await withdraw(event({ ...consent, action: 'revoked' }));
    await policy(event({ layer: 'space' }));
    expect(deps.service.receiptInferencePreview).toHaveBeenCalledWith(deps.actor, selection);
    expect(deps.service.receiptInferenceRun).toHaveBeenCalledWith(deps.actor, consent);
    expect(deps.options).toEqual([
      { write: true },
      { write: true, human: true },
      { write: true, human: true },
      { write: true },
      { write: true, human: true },
    ]);
  });
  it('refuses caller identities, amounts, prompt payloads and malformed consent', async () => {
    await expect(
      preview(
        event({
          accountId: 'checking',
          receiptId: 'receipt',
          lineId: 'line',
          locality: 'local',
          actorId: 'other',
        }),
      ),
    ).rejects.toThrow();
    await expect(
      run(event({ previewId: 'preview', payloadHash: 'a'.repeat(64), payload: { amount: 100 } })),
    ).rejects.toThrow();
    await expect(
      withdraw(event({ previewId: 'preview', payloadHash: 'bad', action: 'rejected' })),
    ).rejects.toThrow();
    await expect(
      update(
        event({
          layer: 'space',
          expectedRevision: '0',
          policy: { local: { enabled: true, providerIds: [] } },
        }),
      ),
    ).rejects.toThrow();
    Object.values(deps.service).forEach((method) => expect(method).not.toHaveBeenCalled());
  });
});
