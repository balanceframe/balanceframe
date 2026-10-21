import { readEvidenceBody } from '../../../utils/bounded-json';
import { z } from 'zod';
import { evidenceRoute } from '../../../utils/transaction-evidence';
const input = z
  .object({
    connectorId: z.string().trim().min(1).max(256),
    accountId: z.string().trim().min(1).max(256),
  })
  .strict();
/** Read current source-bound human learning data without activating rules or ledger writes. */
export default evidenceRoute(
  async (event, service, actor) =>
    service.itemRuleCandidates(actor, input.parse(await readEvidenceBody(event))),
  { write: true, capability: 'item-rule:read' },
);
