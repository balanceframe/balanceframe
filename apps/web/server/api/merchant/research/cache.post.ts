import { readBody } from 'h3';
import { merchantRoute } from '../../../utils/merchant-service';
export default merchantRoute(async (event, service, actor) => service.cachedResearch(actor, await readBody<unknown>(event)), { capability: 'merchant:research', origin: true });
