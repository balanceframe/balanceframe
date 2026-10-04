import { spaceGovernanceRoute } from '../../../../utils/space-governance';

/** Lists retained membership periods for a manager in the selected space. */
export default spaceGovernanceRoute({ capability: 'identity:manage' }, ({ selected, store }) => ({
  memberships: store.governance.listMembershipHistory({ spaceId: selected.space.id }),
}));
