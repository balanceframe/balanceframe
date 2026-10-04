import { z } from 'zod';
import { findingTransitionRoute } from '../../../utils/liquidity-service';

const Body = z.object({
  expectedVersion: z.number().int().nonnegative(),
  correctionRef: z.string().trim().min(1).max(200),
}).strict();

export default findingTransitionRoute(
  Body,
  ({ store, actor, finding, body }) =>
    store.correctFinding({
      findingId: finding.id,
      actorId: actor.actorId,
      correctionRef: body.correctionRef,
      expectedVersion: body.expectedVersion,
    }),
  'CORRECT_FAILED',
);
