// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowStore, LiquidityActor } from '@balanceframe/workflow-store';
const deps = vi.hoisted(() => ({
  service: vi.fn(),
  attention: vi.fn(),
  authorize: vi.fn(),
  allowed: vi.fn(),
}));
vi.mock('../../server/utils/evidence-service', () => ({
  createWebTransactionEvidenceService: deps.service,
}));
import { evidenceAttentionPublication } from '../../server/utils/evidence-attention';
const actor = {
  actorId: 'actor',
  budgetId: 'budget',
  spaceId: 'space',
  auth: { method: 'session', actorId: 'actor', sessionId: 'session' },
} as LiquidityActor;
beforeEach(() => {
  deps.allowed.mockReturnValue(true);
  deps.authorize.mockReturnValue(true);
  deps.attention.mockResolvedValue({
    items: [
      {
        id: 'attention',
        classification: 'unresolved_material_evidence',
        severity: 'high',
        description: 'Review exact evidence',
        evidenceIds: ['doc'],
        reasonCodes: ['receipt_total_mismatch'],
      },
    ],
    authorize: deps.authorize,
  });
  deps.service.mockResolvedValue({ attentionPublication: deps.attention });
});
describe('evidence single attention publication', () => {
  it('carries current scoped evidence and a final authority fence into the ordinary attention result', async () => {
    const store = { liquidity: { isAuthorized: deps.allowed } } as unknown as WorkflowStore;
    const result = await evidenceAttentionPublication(store, actor);
    expect(result.blockers[0]).toMatchObject({
      classification: 'unresolved_material_evidence',
      message: 'Review exact evidence',
      severity: 'warning',
    });
    expect(result.authorize()).toBe(true);
    deps.authorize.mockReturnValue(false);
    expect(result.authorize()).toBe(false);
  });
  it('isolates unavailable evidence and refuses to load unauthorized source context', async () => {
    const store = { liquidity: { isAuthorized: deps.allowed } } as unknown as WorkflowStore;
    deps.allowed.mockReturnValue(false);
    expect((await evidenceAttentionPublication(store, actor)).blockers).toEqual([]);
    expect(deps.service).not.toHaveBeenCalled();
    deps.allowed.mockReturnValue(true);
    deps.service.mockRejectedValue(new Error('PRIVATE_PATH'));
    expect((await evidenceAttentionPublication(store, actor)).blockers[0]).toMatchObject({
      classification: 'evidence_connector_degradation',
    });
  });
});
