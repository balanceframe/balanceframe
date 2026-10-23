import { evidenceSettlementPreviewSchema } from '@balanceframe/application';
import { readEvidenceBody } from '../../utils/bounded-json';
import { evidenceRoute } from '../../utils/transaction-evidence';
/** Preview native-conserved receipt allocation without persisting a decision or writing Actual. */
export default evidenceRoute(
  async (event, service, actor) =>
    service.previewSettlementAllocation(
      actor,
      evidenceSettlementPreviewSchema.parse(await readEvidenceBody(event)),
    ),
  { write: true, capability: 'resolve' },
);
