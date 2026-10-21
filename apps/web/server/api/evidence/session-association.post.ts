import { spendSessionReceiptSaveSchema } from '@balanceframe/application';
import { readEvidenceBody } from '../../utils/bounded-json';
import { evidenceRoute } from '../../utils/transaction-evidence';
/** Record the exact displayed comparison after fresh human review; financial completion remains separate. */
export default evidenceRoute(
  async (event, service, actor) =>
    service.saveSpendSessionReceipt(
      actor,
      spendSessionReceiptSaveSchema.parse(await readEvidenceBody(event)),
    ),
  { write: true, human: true, capability: 'resolve' },
);
