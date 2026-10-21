import { evidenceAllocationSaveSchema } from '@balanceframe/application';
import { readEvidenceBody } from '../../utils/bounded-json';
import { evidenceRoute } from '../../utils/transaction-evidence';
/** Save the exact freshly reviewed native matrix; each financial effect uses ordinary approval. */
export default evidenceRoute(
  async (event, service, actor) =>
    service.saveAllocation(
      actor,
      evidenceAllocationSaveSchema.parse(await readEvidenceBody(event)),
    ),
  { write: true, human: true, capability: 'resolve' },
);
