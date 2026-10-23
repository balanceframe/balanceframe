// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqliteWorkflowStore } from '@balanceframe/workflow-store';
const deps = vi.hoisted(() => ({
  liquidity: vi.fn(),
  action: vi.fn(),
  evidence: vi.fn(),
  capture: vi.fn(),
}));
vi.mock('@balanceframe/application', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createLiquidityService: deps.liquidity,
  createConsequentialActionService: deps.action,
}));
vi.mock('../../server/utils/evidence-service', () => ({
  createWebTransactionEvidenceService: deps.evidence,
}));
import { createWebConsequentialActionService } from '../../server/utils/liquidity-service';
beforeEach(() => {
  deps.liquidity.mockResolvedValue({});
  deps.evidence.mockResolvedValue({ captureObservations: deps.capture });
  deps.capture.mockResolvedValue([]);
});
describe('evidence ordinary-action composition', () => {
  it('recomputes evidence in the existing current-source capture and isolates an unavailable evidence connector', async () => {
    await createWebConsequentialActionService({} as SqliteWorkflowStore);
    const options = deps.liquidity.mock.calls[0]![0];
    expect(options.transactionEvidence).toBeDefined();
    await options.transactionEvidence.captureObservations(
      { actorId: 'actor' },
      { budgetId: 'budget' },
      { snapshotId: 'current-snapshot' },
    );
    expect(deps.capture).toHaveBeenCalledWith(
      { actorId: 'actor' },
      { budgetId: 'budget' },
      { snapshotId: 'current-snapshot' },
    );
    deps.evidence.mockRejectedValue(new Error('PRIVATE_KEY_PATH'));
    expect(await options.transactionEvidence.captureObservations({}, {})).toEqual([]);
    expect(deps.action).toHaveBeenCalled();
  });
});
