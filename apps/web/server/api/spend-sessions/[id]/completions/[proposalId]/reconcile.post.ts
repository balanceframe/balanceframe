import { getRouterParam, readBody } from 'h3';
import { liquidityRoute } from '../../../../../utils/liquidity-service';

export default liquidityRoute(async (event, service, actor) => {
  const sessionId = getRouterParam(event, 'id') ?? '';
  const proposalId = getRouterParam(event, 'proposalId') ?? '';
  if (!(await service.sessionCompletions(actor, sessionId)).some((item) => item.id === proposalId))
    throw new Error('Proposal unavailable');
  return service.reconcileSessionCompletion(actor, proposalId, await readBody(event));
});
