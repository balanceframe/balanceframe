import { receiptInferenceSelectionSchema } from '@balanceframe/application';
import { readEvidenceBody } from '../../../utils/bounded-json';
import { evidenceRoute } from '../../../utils/transaction-evidence';
export default evidenceRoute(
  async (event, service, actor) =>
    service.receiptInferencePreview(
      actor,
      receiptInferenceSelectionSchema.parse(await readEvidenceBody(event)),
    ),
  { write: true },
);
