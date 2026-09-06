import { readBody } from 'h3';
import { liquidityRoute } from '../../utils/liquidity-service';
export default liquidityRoute(async (event, service, actor) =>
  service.saveSession(actor, null, await readBody(event)),
);
