import { evidenceSettlementSaveSchema } from '@balanceframe/application';
import { readEvidenceBody } from '../../utils/bounded-json';
import { evidenceRoute } from '../../utils/transaction-evidence';
/** Save an exact freshly reviewed allocation; the ordinary governed amendment remains separate. */
export default evidenceRoute(
  async (event, service, actor) =>
    service.saveSettlementAllocation(
      actor,
      evidenceSettlementSaveSchema.parse(await readEvidenceBody(event)),
    ),
  { write: true, human: true, capability: 'resolve' },
);
