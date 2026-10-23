import { receiptVersionRevokeInputSchema } from '@balanceframe/application';
import { readEvidenceBody } from '../../../utils/bounded-json';
import { evidenceRoute } from '../../../utils/transaction-evidence';
/** Revoke a reviewed child relationship without recovering or disclosing its former predecessor. */
export default evidenceRoute(
  async (event, service, actor) =>
    service.revokeReceiptVersion(
      actor,
      receiptVersionRevokeInputSchema.parse(await readEvidenceBody(event)),
    ),
  { write: true, human: true, capability: 'resolve' },
);
