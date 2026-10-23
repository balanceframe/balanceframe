import { z } from 'zod';
import { receiptInferencePolicySchema } from '@balanceframe/workflow-store';
import { readEvidenceBody } from '../../../utils/bounded-json';
import { evidenceRoute } from '../../../utils/transaction-evidence';
const input = z
  .object({
    layer: z.enum(['space', 'budget']),
    expectedRevision: z.string().min(1).max(256),
    policy: receiptInferencePolicySchema.nullable(),
  })
  .strict();
export default evidenceRoute(
  async (event, service, actor) =>
    service.updateReceiptInferencePolicy(actor, input.parse(await readEvidenceBody(event))),
  { write: true, human: true },
);
