import { z } from 'zod';
import { findingTransitionRoute } from '../../../utils/liquidity-service';

const Body = z.object({ expectedVersion: z.number().int().nonnegative() }).strict();

export default findingTransitionRoute(
  Body,
  ({ store, actor, finding, body }) =>
    store.reopenFinding({
      findingId: finding.id,
      actorId: actor.actorId,
      expectedVersion: body.expectedVersion,
    }),
  'REOPEN_FAILED',
);
