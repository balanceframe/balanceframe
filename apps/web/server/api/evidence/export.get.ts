import { evidenceRoute } from '../../utils/transaction-evidence';
/** Export current authorized normalized evidence; raw bytes require their separate grant. */
export default evidenceRoute(async (_event, service, actor) =>
  service.exportEvidence(actor, { includeRaw: false }),
);
