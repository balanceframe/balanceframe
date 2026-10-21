import { spendSessionReceiptSelectorSchema } from '@balanceframe/application';
import { readEvidenceBody } from '../../utils/bounded-json';
import { evidenceRoute } from '../../utils/transaction-evidence';
/** Read only authorized choices for one exact internally archived saved session. */
export default evidenceRoute(
  async (event, service, actor) =>
    service.spendSessionReceiptContext(
      actor,
      spendSessionReceiptSelectorSchema.parse(await readEvidenceBody(event)),
    ),
  { write: true, capability: 'normalized-evidence' },
);
