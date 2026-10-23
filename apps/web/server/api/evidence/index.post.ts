import { readEvidenceBody } from '../../utils/bounded-json';
import { evidenceRoute } from '../../utils/transaction-evidence';
/** Import untrusted user evidence without granting source or ledger authority. */
export default evidenceRoute(
  async (event, service, actor) => service.ingest(actor, await readEvidenceBody(event)),
  { write: true, capability: 'ingest' },
);
