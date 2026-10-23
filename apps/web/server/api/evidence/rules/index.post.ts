import { readEvidenceBody } from '../../../utils/bounded-json';
import { evidenceItemRuleInputSchema } from '@balanceframe/application';
import { evidenceRoute } from '../../../utils/transaction-evidence';
/** Simulate exact or reviewed contextual item criteria before offering a separate human approval. */
export default evidenceRoute(
  async (event, service, actor) =>
    service.proposeItemRule(
      actor,
      evidenceItemRuleInputSchema.parse(await readEvidenceBody(event)),
    ),
  { write: true, capability: 'item-rule:propose' },
);
