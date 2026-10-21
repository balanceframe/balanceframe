import { getRouterParam } from 'h3';
import { z } from 'zod';
import { evidenceRoute } from '../../utils/transaction-evidence';
/** Read normalized source detail under its current evidence grant. */
export default evidenceRoute(async (event, service, actor) => ({
  document: await service.detail(
    actor,
    z.string().min(1).max(256).parse(getRouterParam(event, 'id')),
  ),
}));
