import { walletStatementRevokeInputSchema } from '@balanceframe/application';
import { evidenceRoute } from '../../../utils/transaction-evidence';
import { readEvidenceBody } from '../../../utils/bounded-json';
/** Revoke current human proof without needing expired or deleted original bytes. */
export default evidenceRoute(
  async (event, service, actor) =>
    service.revokeWalletStatement(
      actor,
      walletStatementRevokeInputSchema.parse(await readEvidenceBody(event)),
    ),
  { write: true, human: true, capability: 'resolve' },
);
