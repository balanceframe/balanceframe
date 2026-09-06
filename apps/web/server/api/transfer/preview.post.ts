import { readBody } from 'h3';
import { liquidityRoute } from '../../utils/liquidity-service';
export default liquidityRoute(async (event, service, actor) =>
  service.previewTransfer(actor, await readBody(event)),
);
