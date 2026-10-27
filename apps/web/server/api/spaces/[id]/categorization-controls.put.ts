import { z } from 'zod';
import { projectCategorizationControl, readGovernanceBody, ResourceId, spaceGovernanceRoute } from '../../../utils/space-governance';

const Body = z.object({ agentId: ResourceId.nullable(), expectedVersion: z.string().uuid().nullable(), policy: z.unknown() }).strict();

/** Saves one exact human-controlled limit/stop version without granting execution or approval authority. */
export default spaceGovernanceRoute({ capability: 'delegation:manage', freshProof: true }, async ({ event, selected, store, proof, now }) => {
  const body = await readGovernanceBody(event, Body);
  return { policy: projectCategorizationControl(store.governance.setCategorizationControls({ ...body, spaceId: selected.space.id, auth: proof!, now })) };
});
