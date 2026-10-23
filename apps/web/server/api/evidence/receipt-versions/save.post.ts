import { receiptVersionSaveInputSchema } from '@balanceframe/application';
import { readEvidenceBody } from '../../../utils/bounded-json';
import { evidenceRoute } from '../../../utils/transaction-evidence';
/** Fresh human review may append an exact immutable evidence relationship, never an Actual write. */
export default evidenceRoute(
  async (event, service, actor) =>
    service.saveReceiptVersion(
      actor,
      receiptVersionSaveInputSchema.parse(await readEvidenceBody(event)),
    ),
  { write: true, human: true, capability: 'resolve' },
);
