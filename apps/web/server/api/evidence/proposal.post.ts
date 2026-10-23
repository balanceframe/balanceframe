import { createHash } from 'node:crypto';
import { readEvidenceBody } from '../../utils/bounded-json';
import { z } from 'zod';
import { evidenceRoute } from '../../utils/transaction-evidence';
import { createWebConsequentialActionService } from '../../utils/liquidity-service';
import { getWorkflowStore, type EventWithContext } from '../../utils/workflow-store';
const selector = z
  .object({
    resolutionHash: z.string().regex(/^[a-f0-9]{64}$/),
    eventId: z.string().min(1).max(256),
    allocationSetHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
/** Derive an exact debit, credit, or amendment through the ordinary governed pipeline. */
export default evidenceRoute(
  async (event, service, actor) => {
    const input = selector.parse(await readEvidenceBody(event));
    const workflow = getWorkflowStore(event as unknown as EventWithContext);
    if ('error' in workflow) throw new Error('Evidence workflow unavailable');
    const identity = `evidence-${createHash('sha256')
      .update(JSON.stringify([actor.spaceId, actor.budgetId, input.resolutionHash, input.eventId]))
      .digest('hex')}`;
    const action = await service.prepareLedgerAction(actor, {
      ...input,
      ...(input.allocationSetHash ? {} : { parentId: identity, correlationId: identity }),
    });
    const actions = await createWebConsequentialActionService(workflow.store);
    const proposal = await actions.propose(actor, {
      action,
    });
    return { proposalId: proposal.id };
  },
  { write: true, capability: 'resolve' },
);
