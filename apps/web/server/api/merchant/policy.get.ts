import { merchantRoute } from '../../utils/merchant-service';
/** Return a full authorized policy or refuse; never hide overrides in an editable replacement. */
export default merchantRoute(async (_event, service, actor) => service.policy(actor), { capability: 'policy' });
