import { receiptInferenceConsentSchema } from '@balanceframe/application';
import { readEvidenceBody } from '../../../utils/bounded-json';
import { evidenceRoute } from '../../../utils/transaction-evidence';
export default evidenceRoute(
  async (event, service, actor) =>
    service.receiptInferenceRun(
      actor,
      receiptInferenceConsentSchema.parse(await readEvidenceBody(event)),
    ),
  { write: true, human: true },
);
