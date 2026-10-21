import { evidenceRoute } from '../../../utils/transaction-evidence';
/** Offer independently readable source choices without granting historical access. */
export default evidenceRoute(
  async (_event, service, actor) => service.receiptVersionContext(actor),
  { capability: 'resolve' },
);
