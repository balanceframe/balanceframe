import { merchantRoute } from '../../../utils/merchant-service';
export default merchantRoute(async (_event, service, actor) => service.researchPolicy(actor), { capability: 'policy' });
