import { getRouterParam } from 'h3';
import { z } from 'zod';
import { readGovernanceBody, spaceGovernanceRoute } from '../../../../utils/space-governance';

const StatusBody = z.object({ status: z.enum(['disconnected', 'revoked']) }).strict();

/** Disconnects or revokes an independently registered agent without deleting its history. */
export default spaceGovernanceRoute({ capability: 'agent:manage', freshProof: true }, async ({ event, selected, store, proof, now }) => {
  const body = await readGovernanceBody(event, StatusBody);
  store.governance.setAgentStatus({
    spaceId: selected.space.id,
    agentId: getRouterParam(event, 'agentId') ?? '',
    status: body.status,
    now,
    auth: proof!,
  });
  return { status: body.status };
});
