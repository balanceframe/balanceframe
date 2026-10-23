import { evidenceAllocationPreviewSchema } from '@balanceframe/application';
import { readEvidenceBody } from '../../utils/bounded-json';
import { evidenceRoute } from '../../utils/transaction-evidence';
/** Preview explicit native matrix conservation without approving evidence or writing Actual. */
export default evidenceRoute(
  async (event, service, actor) =>
    service.previewAllocation(
      actor,
      evidenceAllocationPreviewSchema.parse(await readEvidenceBody(event)),
    ),
  { capability: 'resolve' },
);
