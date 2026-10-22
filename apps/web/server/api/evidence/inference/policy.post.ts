import { z } from 'zod';
import { readEvidenceBody } from '../../../utils/bounded-json';
import { evidenceRoute } from '../../../utils/transaction-evidence';
const input = z.object({ layer: z.enum(['space', 'budget']) }).strict();
export default evidenceRoute(
  async (event, service, actor) =>
    service.receiptInferencePolicy(actor, input.parse(await readEvidenceBody(event))),
  { write: true },
);
