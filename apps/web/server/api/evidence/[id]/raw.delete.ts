import { getRouterParam } from 'h3';
import { z } from 'zod';
import { evidenceRoute } from '../../../utils/transaction-evidence';
/** Delete encrypted raw bytes while retaining allowed normalization and audit provenance. */
export default evidenceRoute(
  async (event, service, actor) => ({
    deleted: await service.deleteRaw(
      actor,
      z.string().min(1).max(256).parse(getRouterParam(event, 'id')),
    ),
  }),
  { write: true, human: true },
);
