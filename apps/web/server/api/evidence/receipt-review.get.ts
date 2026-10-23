import { evidenceRoute } from '../../utils/transaction-evidence';
/** Read only current permitted receipt relationships and membership choices. */
export default evidenceRoute(async (_event, service, actor) => service.receiptReviewContext(actor), { capability: 'resolve' });
