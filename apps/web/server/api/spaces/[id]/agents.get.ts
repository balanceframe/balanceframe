import { spaceGovernanceRoute } from '../../../utils/space-governance';

/** Lists only agents registered in the selected governed space. */
export default spaceGovernanceRoute({ capability: 'agent:manage' }, ({ selected, store }) => ({
  agents: store.governance.listAgents({ spaceId: selected.space.id }),
}));
