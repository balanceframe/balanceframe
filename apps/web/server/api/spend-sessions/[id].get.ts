import { getRouterParam } from 'h3';
import { liquidityRoute } from '../../utils/liquidity-service';
export default liquidityRoute((event, service, actor) =>
  service.session(actor, getRouterParam(event, 'id') ?? ''),
);
