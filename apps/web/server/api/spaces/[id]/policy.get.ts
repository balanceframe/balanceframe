import { spaceGovernanceRoute } from '../../../utils/space-governance';

/** Returns the current governance policy version and its retained history. */
export default spaceGovernanceRoute({ capability: 'policy:manage' }, ({ selected, store }) => ({
  policy: store.governance.getPolicy({ spaceId: selected.space.id }),
  history: store.governance.listPolicyHistory({ spaceId: selected.space.id }),
}));
