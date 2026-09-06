import { liquidityRoute } from '../../utils/liquidity-service';
export default liquidityRoute((_event, service, actor) => service.configuration(actor));
