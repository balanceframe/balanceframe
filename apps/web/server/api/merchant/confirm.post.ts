import { readBody } from 'h3';
import { merchantRoute } from '../../utils/merchant-service';
/** Confirm evidence only; no Actual mutation or external research consent. */
export default merchantRoute(async (event, service, actor) => service.confirm(actor, await readBody<unknown>(event)), { capability: 'merchant:confirm', human: true });
