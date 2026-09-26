import { getRouterParam, readBody } from 'h3';
import { liquidityRoute } from '../../../../utils/liquidity-service';

export default liquidityRoute(async (event, service, actor) =>
  service.releaseProspectiveClaim(
    actor,
    getRouterParam(event, 'claimId') ?? '',
    await readBody(event),
  ),
);
