import { evidenceRoute } from '../../utils/transaction-evidence';
/** Read authorized connector health without disclosing hidden evidence counts. */
export default evidenceRoute(async (_event, service, actor) => ({
  connectors: await service.health(actor),
}));
