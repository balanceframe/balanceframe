import { z } from 'zod';
import { readGovernanceBody, spaceGovernanceRoute } from '../../../utils/space-governance';

const RegisterAgentBody = z.object({ agentId: z.string().min(1).max(256) }).strict();

/** Registers an independently identified agent under the selected-space manager. */
export default spaceGovernanceRoute({ capability: 'agent:manage', freshProof: true }, async ({ event, selected, store, proof, now }) => {
  const body = await readGovernanceBody(event, RegisterAgentBody);
  const agent = store.governance.registerAgent({
    spaceId: selected.space.id,
    agentId: body.agentId,
    now,
    auth: proof!,
  });
  return { agent };
});
