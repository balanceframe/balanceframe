import { getRouterParam, readBody } from 'h3';
import { liquidityRoute } from '../../../utils/liquidity-service';
export default liquidityRoute(async (event, service, actor) =>
  service.transferAction(
    actor,
    getRouterParam(event, 'id') ?? '',
    'approve',
    await readBody(event),
  ),
);
