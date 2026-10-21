// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({
  actor: { actorId: 'selected-actor' },
  service: {
    itemCategoryOutcomes: vi.fn(),
    itemRuleCandidates: vi.fn(),
    proposeItemRuleCandidate: vi.fn(),
  },
}));
vi.mock('../../server/utils/bounded-json', () => ({
  readEvidenceBody: async (event: { body: unknown }) => event.body,
}));
vi.mock('../../server/utils/transaction-evidence', () => ({
  evidenceRoute:
    (operation: (event: unknown, service: unknown, actor: unknown) => unknown) =>
    (event: unknown) =>
      operation(event, deps.service, deps.actor),
}));
import outcomes from '../../server/api/evidence/rules/outcomes.post';
import candidates from '../../server/api/evidence/rules/candidates.post';
import propose from '../../server/api/evidence/rules/from-candidate.post';
const event = (body: unknown) => ({ body }) as never;
beforeEach(() => {
  for (const method of Object.values(deps.service)) method.mockReset().mockResolvedValue([]);
});
describe('explicit reviewed receipt learning routes', () => {
  it('uses only the selected actor and current exact candidate criteria', async () => {
    const input = { connectorId: 'retail', accountId: 'checking' };
    await outcomes(event(input));
    await candidates(event(input));
    expect(deps.service.itemCategoryOutcomes).toHaveBeenCalledWith(deps.actor, input);
    expect(deps.service.itemRuleCandidates).toHaveBeenCalledWith(deps.actor, input);
    const decision = { ...input, candidateHash: 'a'.repeat(64) };
    await propose(event(decision));
    expect(deps.service.proposeItemRuleCandidate).toHaveBeenCalledWith(deps.actor, decision);
  });
  it('rejects authority, category and training claims at read and proposal boundaries', async () => {
    for (const handler of [outcomes, candidates])
      await expect(
        handler(
          event({
            connectorId: 'retail',
            accountId: 'checking',
            categoryId: 'forged',
            actorId: 'other',
          }),
        ),
      ).rejects.toThrow();
    await expect(
      propose(event({ connectorId: 'retail', accountId: 'checking', candidateHash: 'invalid' })),
    ).rejects.toThrow();
    expect(deps.service.proposeItemRuleCandidate).not.toHaveBeenCalled();
  });
});
