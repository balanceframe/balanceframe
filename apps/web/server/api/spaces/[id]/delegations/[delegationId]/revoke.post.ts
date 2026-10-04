import { getRouterParam } from 'h3';
import { z } from 'zod';
import { readGovernanceBody, spaceGovernanceRoute } from '../../../../../utils/space-governance';

const RevokeBody = z.object({ expectedVersion: z.string().regex(/^[1-9]\d*$/) }).strict();

/** Revokes only the expected current delegation version. */
export default spaceGovernanceRoute({ capability: 'delegation:manage', freshProof: true }, async ({ event, selected, store, proof, now }) => {
  const body = await readGovernanceBody(event, RevokeBody);
  const delegationId = getRouterParam(event, 'delegationId') ?? '';
  store.governance.revokeDelegation({
    spaceId: selected.space.id,
    delegationId,
    expectedVersion: body.expectedVersion,
    now,
    auth: proof!,
  });
  return { revoked: true };
});
