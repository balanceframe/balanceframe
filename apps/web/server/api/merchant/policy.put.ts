import { readBody } from 'h3';
import { merchantRoute } from '../../utils/merchant-service';
/** Replace the complete policy under fresh human and account-override authority. */
export default merchantRoute(async (event, service, actor) => service.setPolicy(actor, await readBody<unknown>(event)), { capability: 'policy:manage', human: true, spaceControl: true });
