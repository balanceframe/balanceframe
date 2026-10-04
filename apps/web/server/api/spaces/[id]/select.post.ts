import { z } from 'zod';
import { readGovernanceBody, selectSpaceCookie, spaceGovernanceRoute } from '../../../utils/space-governance';

const EmptyBody = z.object({}).strict();

/** Selects a current space membership and persists the explicit browser selection cookie. */
export default spaceGovernanceRoute({}, async ({ event, selected }) => {
  await readGovernanceBody(event, EmptyBody);
  if (selected.auth.method === 'api-key' && selected.auth.principalType !== 'human')
    throw new Error('Space selection unavailable');
  selectSpaceCookie(event, selected.space.id);
  return { space: { id: selected.space.id, name: selected.space.name, kind: selected.space.kind } };
});
