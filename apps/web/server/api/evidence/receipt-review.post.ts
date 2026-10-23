import { receiptReviewSaveSchema } from '@balanceframe/application';
import { readEvidenceBody } from '../../utils/bounded-json';
import { evidenceRoute } from '../../utils/transaction-evidence';
/** Save explicit selectors as human-reviewed evidence; this never dispatches an Actual mutation. */
export default evidenceRoute(async (event, service, actor) => service.saveReceiptReview(actor, receiptReviewSaveSchema.parse(await readEvidenceBody(event))), { write: true, human: true, capability: 'resolve' });
