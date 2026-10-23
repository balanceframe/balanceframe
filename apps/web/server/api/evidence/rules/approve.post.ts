import { readEvidenceBody } from '../../../utils/bounded-json';
import { evidenceItemRuleDecisionSchema } from '@balanceframe/application';
import { evidenceRoute } from '../../../utils/transaction-evidence';
/** Approve only the displayed immutable payload with fresh human authority. */
export default evidenceRoute(
  async (event, service, actor) =>
    service.approveItemRule(
      actor,
      evidenceItemRuleDecisionSchema.parse(await readEvidenceBody(event)),
    ),
  { write: true, human: true, capability: 'item-rule:approve' },
);
