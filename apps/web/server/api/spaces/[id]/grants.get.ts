import { spaceGovernanceRoute } from '../../../utils/space-governance';

/** Lists exact scoped grant records available to a grant manager. */
export default spaceGovernanceRoute({ capability: 'grant:manage' }, ({ selected, store }) => ({
  grants: store.governance.listResourceGrants({ spaceId: selected.space.id }),
}));
