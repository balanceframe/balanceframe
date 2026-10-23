import { readEvidenceBody } from '../../utils/bounded-json';
import { z } from 'zod';
import { evidenceRoute } from '../../utils/transaction-evidence';
const selector = z
  .object({
    resolutionHash: z.string().regex(/^[a-f0-9]{64}$/),
    eventId: z.string().min(1).max(256),
    accountId: z.string().min(1).max(256),
    matchMode: z.enum(['exact', 'partial']).optional(),
  })
  .strict();
/** Read only current authorized settlement candidates for one reviewed event and account. */
export default evidenceRoute(
  async (event, service, actor) =>
    service.settlementTargets(actor, selector.parse(await readEvidenceBody(event))),
  { write: true, capability: 'resolve' },
);
