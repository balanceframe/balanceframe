import { getRouterParam } from 'h3';
import { z } from 'zod';
import { readGovernanceBody, spaceGovernanceRoute } from '../../../../../utils/space-governance';

const EmptyBody = z.object({}).strict();

/** Revokes a selected-space credential binding without freeing its immutable key ID. */
export default spaceGovernanceRoute({ capability: 'credential:manage', freshProof: true }, async ({ event, selected, store, proof, now }) => {
  await readGovernanceBody(event, EmptyBody);
  store.governance.revokeCredentialBinding({
    spaceId: selected.space.id,
    credentialId: getRouterParam(event, 'credentialId') ?? '',
    now,
    auth: proof!,
  });
  return { revoked: true };
});
