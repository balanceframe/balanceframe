import { receiptVersionPreviewInputSchema } from '@balanceframe/application';
import { readEvidenceBody } from '../../../utils/bounded-json';
import { evidenceRoute } from '../../../utils/transaction-evidence';
/** Preview explicit source selectors through native conservation without recording a relationship. */
export default evidenceRoute(
  async (event, service, actor) =>
    service.previewReceiptVersion(
      actor,
      receiptVersionPreviewInputSchema.parse(await readEvidenceBody(event)),
    ),
  { write: true, capability: 'resolve' },
);
