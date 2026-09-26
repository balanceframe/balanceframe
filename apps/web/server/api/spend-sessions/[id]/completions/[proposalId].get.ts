import { getRouterParam } from 'h3';
import { liquidityRoute } from '../../../../utils/liquidity-service';

export default liquidityRoute(async (event, service, actor) => {
  const sessionId = getRouterParam(event, 'id') ?? '';
  const proposalId = getRouterParam(event, 'proposalId') ?? '';
  const proposals = await service.sessionCompletions(actor, sessionId);
  if (!proposals.some((proposal) => proposal.id === proposalId))
    throw new Error('Proposal unavailable');
  return service.sessionCompletion(actor, proposalId);
});
