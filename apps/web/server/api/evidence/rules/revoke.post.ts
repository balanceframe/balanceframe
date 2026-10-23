import { readEvidenceBody } from '../../../utils/bounded-json';
import { evidenceItemRuleDecisionSchema } from '@balanceframe/application';
import { evidenceRoute } from '../../../utils/transaction-evidence';
/** Revoke an exact item-rule approval and retain its attributable history. */
export default evidenceRoute(
  async (event, service, actor) =>
    service.revokeItemRule(
      actor,
      evidenceItemRuleDecisionSchema.parse(await readEvidenceBody(event)),
    ),
  { write: true, human: true, capability: 'item-rule:approve' },
);
