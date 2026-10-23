import { spendSessionReceiptCompareSchema } from '@balanceframe/application';
import { readEvidenceBody } from '../../utils/bounded-json';
import { evidenceRoute } from '../../utils/transaction-evidence';
/** Recompute a comparison without completing a session or accepting client financial facts. */
export default evidenceRoute(
  async (event, service, actor) =>
    service.compareSpendSessionReceipt(
      actor,
      spendSessionReceiptCompareSchema.parse(await readEvidenceBody(event)),
    ),
  { write: true, capability: 'resolve' },
);
