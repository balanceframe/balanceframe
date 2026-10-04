import { spaceGovernanceRoute } from '../../../utils/space-governance';

/** Lists credential binding metadata, never credential secrets. */
export default spaceGovernanceRoute({ capability: 'credential:manage' }, ({ selected, store }) => ({
  credentials: store.governance.listCredentialBindings({ spaceId: selected.space.id }),
}));
