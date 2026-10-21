import { evidenceRoute } from '../../utils/transaction-evidence';
/** List authorized source normalization in the selected connection. */
export default evidenceRoute(async (_event, service, actor) => ({
  documents: await service.list(actor),
}));
