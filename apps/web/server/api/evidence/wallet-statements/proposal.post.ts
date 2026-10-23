import { walletMaterializationSelectorSchema } from '@balanceframe/application';
import { readEvidenceBody } from '../../../utils/bounded-json';
import { evidenceRoute } from '../../../utils/transaction-evidence';
import { createWebConsequentialActionService } from '../../../utils/liquidity-service';
import { getWorkflowStore, type EventWithContext } from '../../../utils/workflow-store';
/** Select native opening equity and prepare an ordinary proposal; approval and execution remain separate. */
export default evidenceRoute(
  async (event, service, actor) => {
    const input = walletMaterializationSelectorSchema.parse(await readEvidenceBody(event));
    const workflow = getWorkflowStore(event as unknown as EventWithContext);
    if ('error' in workflow) throw new Error('Evidence workflow unavailable');
    const action = await service.prepareWalletMaterialization(actor, input);
    const actions = await createWebConsequentialActionService(workflow.store);
    const proposal = await actions.propose(actor, { action });
    return { proposalId: proposal.id };
  },
  { write: true, capability: 'resolve' },
);
