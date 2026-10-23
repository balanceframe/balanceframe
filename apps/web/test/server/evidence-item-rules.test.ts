// @vitest-environment node
vi.mock('../../server/utils/bounded-json', () => ({
  readEvidenceBody: async (event: { body: unknown }) => event.body,
}));
import { beforeEach, describe, expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({
  actor: { actorId: 'selected-actor', governancePolicyVersion: 'current-policy' },
  service: {
    listItemRules: vi.fn(),
    proposeItemRule: vi.fn(),
    approveItemRule: vi.fn(),
    revokeItemRule: vi.fn(),
    itemRuleSuggestions: vi.fn(),
  },
  options: [] as unknown[],
}));
vi.mock('h3', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readBody: async (event: { body: unknown }) => event.body,
}));
vi.mock('../../server/utils/transaction-evidence', () => ({
  evidenceRoute: (
    operation: (event: unknown, service: unknown, actor: unknown) => Promise<unknown>,
    options?: unknown,
  ) => {
    deps.options.push(options);
    return (event: unknown) => operation(event, deps.service, deps.actor);
  },
}));
import list from '../../server/api/evidence/rules/index.get';
import propose from '../../server/api/evidence/rules/index.post';
import approve from '../../server/api/evidence/rules/approve.post';
import revoke from '../../server/api/evidence/rules/revoke.post';
import suggestions from '../../server/api/evidence/rules/suggestions.post';
beforeEach(() => {
  for (const method of Object.values(deps.service))
    method.mockReset().mockResolvedValue({ accepted: true });
});
const event = (body: unknown) => ({ body }) as unknown as Parameters<typeof list>[0];
describe('exact evidence item-rule routes', () => {
  it('uses the selected actor and exact source criteria with separate fresh-human approval and revocation', async () => {
    await list(event(undefined));
    expect(deps.service.listItemRules).toHaveBeenCalledWith(deps.actor);
    const input = {
      connectorId: 'retail',
      accountId: 'checking',
      fundingInstrumentId: 'card',
      counterparty: 'Store A',
      sku: 'sku-1',
      normalizedDescription: null,
      categoryId: 'food',
    };
    await propose(event(input));
    expect(deps.service.proposeItemRule).toHaveBeenCalledWith(deps.actor, input);
    const decision = { proposalId: 'rule', payloadHash: 'a'.repeat(64) };
    await approve(event(decision));
    await revoke(event(decision));
    expect(deps.service.approveItemRule).toHaveBeenCalledWith(deps.actor, decision);
    expect(deps.service.revokeItemRule).toHaveBeenCalledWith(deps.actor, decision);
    await suggestions(event({ accountId: 'checking' }));
    expect(deps.service.itemRuleSuggestions).toHaveBeenCalledWith(deps.actor, {
      accountId: 'checking',
    });
    expect(deps.options).toContainEqual({ capability: 'item-rule:read' });
    expect(
      deps.options.filter(
        (value) =>
          JSON.stringify(value) ===
          JSON.stringify({ write: true, human: true, capability: 'item-rule:approve' }),
      ),
    ).toHaveLength(2);
  });
  it('accepts explicit contextual criteria only with exact merchant and exclusive item conditions', async () => {
    const body = {
      connectorId: 'retail',
      accountId: 'checking',
      fundingInstrumentId: 'card',
      counterparty: 'Store A',
      sku: null,
      normalizedDescription: null,
      categoryId: 'food',
      criterion: { kind: 'department', value: 'produce' },
    };
    await propose(event(body));
    expect(deps.service.proposeItemRule).toHaveBeenCalledWith(deps.actor, body);
    deps.service.proposeItemRule.mockClear();
    for (const invalid of [
      { ...body, sku: 'also-exact' },
      { ...body, criterion: { kind: 'opaque_model', value: 'produce' } },
      { ...body, criterion: { kind: 'historical_similarity', value: 'apple' } },
      { ...body, counterparty: '' },
    ])
      await expect(propose(event(invalid))).rejects.toThrow();
    expect(deps.service.proposeItemRule).not.toHaveBeenCalled();
  });
  it('rejects forged authority, broad merchant predicates, unknown decision fields and invalid hashes before delegation', async () => {
    await expect(
      propose(event({ connectorId: 'retail', merchant: 'all', actorId: 'other' })),
    ).rejects.toThrow();
    await expect(approve(event({ proposalId: 'rule', payloadHash: 'bad' }))).rejects.toThrow();
    await expect(
      revoke(event({ proposalId: 'rule', payloadHash: 'a'.repeat(64), policyVersion: 'old' })),
    ).rejects.toThrow();
    await expect(suggestions(event({ accountId: 'checking', write: true }))).rejects.toThrow();
    expect(deps.service.proposeItemRule).not.toHaveBeenCalled();
    expect(deps.service.approveItemRule).not.toHaveBeenCalled();
    expect(deps.service.revokeItemRule).not.toHaveBeenCalled();
    expect(deps.service.itemRuleSuggestions).not.toHaveBeenCalled();
  });
});
