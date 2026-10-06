import { merchantRoute } from '../../utils/merchant-service';
/** Export only freshly authorized local evidence and scoped decisions. */
export default merchantRoute(async (_event, service, actor) => service.export(actor), { capability: 'merchant:export', human: true });
