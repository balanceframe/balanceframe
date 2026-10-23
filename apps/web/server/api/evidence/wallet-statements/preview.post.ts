import { walletStatementPreviewInputSchema } from '@balanceframe/application';
import { evidenceRoute } from '../../../utils/transaction-evidence';
import { readEvidenceBody } from '../../../utils/bounded-json';
/** Preview local claims without authenticating an issuer or recording human approval. */
export default evidenceRoute(
  async (event, service, actor) =>
    service.previewWalletStatement(
      actor,
      walletStatementPreviewInputSchema.parse(await readEvidenceBody(event)),
    ),
  { capability: 'resolve' },
);
