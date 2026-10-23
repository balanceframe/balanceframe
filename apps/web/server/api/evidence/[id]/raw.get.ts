import { getRouterParam } from 'h3';
import { z } from 'zod';
import { evidenceRoute } from '../../../utils/transaction-evidence';
/** Return authorized source bytes as inert base64, never as active HTML. */
export default evidenceRoute(async (event, service, actor) => ({
  contentBase64:
    (
      await service.raw(actor, z.string().min(1).max(256).parse(getRouterParam(event, 'id')))
    )?.toString('base64') ?? null,
}));
