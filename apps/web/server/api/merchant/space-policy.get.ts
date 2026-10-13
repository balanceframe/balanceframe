import { merchantRoute } from '../../utils/merchant-service';
export default merchantRoute(async (_event, service, actor) => service.spacePolicy(actor), { capability: 'policy:manage', spaceControl: true });
