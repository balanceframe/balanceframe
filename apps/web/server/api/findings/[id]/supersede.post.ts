import { z } from 'zod';
import {
  findFindingInBudget,
  findingTransitionRoute,
  projectFinancialFinding,
} from '../../../utils/liquidity-service';

const Body = z.object({
  expectedVersion: z.number().int().nonnegative(),
  supersededBy: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(1000),
}).strict();

export default findingTransitionRoute(
  Body,
  async ({ store, actor, finding, body }) => {
    const replacement = await findFindingInBudget(store, actor.budgetId, body.supersededBy);
    if (!replacement || !projectFinancialFinding(store, actor, replacement))
      throw new Error('Replacement finding unavailable in the selected space');
    return store.supersedeFinding({
      findingId: finding.id,
      actorId: actor.actorId,
      supersededBy: replacement.id,
      reason: body.reason,
      expectedVersion: body.expectedVersion,
    });
  },
  'SUPERSEDE_FAILED',
);
