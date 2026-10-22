import { receiptInferenceWithdrawalSchema } from '@balanceframe/application';
import { readEvidenceBody } from '../../../utils/bounded-json';
import { evidenceRoute } from '../../../utils/transaction-evidence';
export default evidenceRoute(
  async (event, service, actor) =>
    service.receiptInferenceWithdraw(
      actor,
      receiptInferenceWithdrawalSchema.parse(await readEvidenceBody(event)),
    ),
  { write: true, human: true },
);
