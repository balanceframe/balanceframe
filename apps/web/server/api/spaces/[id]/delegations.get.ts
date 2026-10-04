import { spaceGovernanceRoute } from '../../../utils/space-governance';

/** Lists retained delegation versions in the selected space. */
export default spaceGovernanceRoute({ capability: 'delegation:manage' }, ({ selected, store }) => ({
  delegations: store.governance.listDelegations({ spaceId: selected.space.id }),
}));
