import { getRouterParam } from 'h3';
import { z } from 'zod';
import { readGovernanceBody, spaceGovernanceRoute } from '../../../../../utils/space-governance';

const EmptyBody = z.object({}).strict();

/** Revokes one membership period while retaining membership and grant history. */
export default spaceGovernanceRoute({ capability: 'identity:manage', freshProof: true }, async ({ event, selected, store, proof, now }) => {
  await readGovernanceBody(event, EmptyBody);
  const membershipId = getRouterParam(event, 'membershipId') ?? '';
  store.governance.revokeMembership({ spaceId: selected.space.id, membershipId, now, auth: proof! });
  return { revoked: true };
});
