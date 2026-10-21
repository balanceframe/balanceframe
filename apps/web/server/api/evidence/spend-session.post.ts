import { readEvidenceBody } from '../../utils/bounded-json';
import { evidenceRoute } from '../../utils/transaction-evidence';
/** Import one exact authorized Spend Session version as evidence, without completing it. */
export default evidenceRoute(
  async (event, service, actor) => service.ingestSpendSession(actor, await readEvidenceBody(event)),
  { write: true, capability: 'ingest' },
);
