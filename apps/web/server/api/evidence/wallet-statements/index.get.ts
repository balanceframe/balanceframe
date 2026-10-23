import { evidenceRoute } from '../../../utils/transaction-evidence';
/** Return only current caller-authorized statement metadata, human proofs and bounded native diagnostics. */
export default evidenceRoute(
  async (_event, service, actor) => service.walletStatementContext(actor),
  { capability: 'resolve' },
);
