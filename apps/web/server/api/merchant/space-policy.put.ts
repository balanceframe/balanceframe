import { readBody } from 'h3';
import { merchantRoute } from '../../utils/merchant-service';
export default merchantRoute(async (event, service, actor) => service.setSpacePolicy(actor, await readBody<unknown>(event)), { capability: 'policy:manage', human: true, spaceControl: true, origin: true });
