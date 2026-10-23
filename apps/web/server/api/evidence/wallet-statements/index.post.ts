import { walletStatementAttestInputSchema } from '@balanceframe/application';
import { evidenceRoute } from '../../../utils/transaction-evidence';
import { readEvidenceBody } from '../../../utils/bounded-json';
/** Reread and record explicit fresh human completeness/original-source attestation. */
export default evidenceRoute(
  async (event, service, actor) =>
    service.attestWalletStatement(
      actor,
      walletStatementAttestInputSchema.parse(await readEvidenceBody(event)),
    ),
  { write: true, human: true, capability: 'resolve' },
);
