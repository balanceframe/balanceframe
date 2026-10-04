import { z } from 'zod';
import { humanGovernanceRoute, readGovernanceBody } from '../../utils/space-governance';
import { getWorkflowStore } from '../../utils/workflow-store';
import type { EventWithContext } from '../../utils/workflow-store';
import { SpaceKind } from '../../utils/space-governance';

const CreateSpaceBody = z.object({ name: z.string().trim().min(1).max(120), kind: SpaceKind }).strict();

/** Creates an unbound space from the verified human principal and fresh password proof. */
export default humanGovernanceRoute(true, async ({ event, actorId, proof, now }) => {
  const body = await readGovernanceBody(event, CreateSpaceBody);
  if (!proof) throw new Error('Human proof unavailable');
  const workflow = getWorkflowStore(event as unknown as EventWithContext);
  if ('error' in workflow) throw new Error('Governance storage failure');
  const space = workflow.store.governance.createSpace({ actorId, name: body.name, kind: body.kind, now, auth: proof });
  return { space: { id: space.id, name: space.name, kind: space.kind, budgetId: null, createdBy: actorId, createdAt: space.createdAt } };
});
