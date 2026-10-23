import { readEvidenceBody } from '../../../utils/bounded-json';
import { z } from 'zod';
import { evidenceRoute } from '../../../utils/transaction-evidence';
const input = z.object({ accountId: z.string().trim().min(1).max(256) }).strict();
/** Return local suggestions under current source and rule authority without ledger writes. */
export default evidenceRoute(
  async (event, service, actor) =>
    service.itemRuleSuggestions(actor, input.parse(await readEvidenceBody(event))),
  { write: true, capability: 'item-rule:read' },
);
