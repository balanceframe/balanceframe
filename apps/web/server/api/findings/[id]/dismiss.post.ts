import { z } from 'zod';
import { findingTransitionRoute } from '../../../utils/liquidity-service';

const Body = z.object({
  expectedVersion: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(1000),
}).strict();

export default findingTransitionRoute(
  Body,
  ({ store, actor, finding, body }) =>
    store.dismissFinding({
      findingId: finding.id,
      actorId: actor.actorId,
      reason: body.reason,
      expectedVersion: body.expectedVersion,
    }),
  'DISMISS_FAILED',
);
