import { merchantRoute } from '../../utils/merchant-service';
/** Purge the exact selected connection using independent lifecycle authority. */
export default merchantRoute(async (_event, service, actor) => service.delete(actor), { capability: 'merchant:delete', human: true });
