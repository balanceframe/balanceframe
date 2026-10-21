import { readEvidenceBody } from '../../../utils/bounded-json';
import { z } from 'zod';
import { evidenceRoute } from '../../../utils/transaction-evidence';
const input = z
  .object({
    connectorId: z.string().trim().min(1).max(256),
    accountId: z.string().trim().min(1).max(256),
    candidateHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
/** A current candidate becomes an ordinary immutable proposal requiring separate human approval. */
export default evidenceRoute(
  async (event, service, actor) =>
    service.proposeItemRuleCandidate(actor, input.parse(await readEvidenceBody(event))),
  { write: true, capability: 'item-rule:propose' },
);
