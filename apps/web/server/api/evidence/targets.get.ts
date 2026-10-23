import { evidenceRoute } from '../../utils/transaction-evidence';
/** List current permitted account/category names for an evidence ledger proposal. */
export default evidenceRoute(async (_event, service, actor) => service.ledgerTargets(actor));
