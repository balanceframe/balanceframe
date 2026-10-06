import { readBody } from 'h3';
import { merchantRoute } from '../../utils/merchant-service';
/** Persist rejection against current scoped evidence and optimistic version. */
export default merchantRoute(async (event, service, actor) => service.reject(actor, await readBody<unknown>(event)), { capability: 'merchant:confirm', human: true });
