import { projectCategorizationControl, spaceGovernanceRoute } from '../../../utils/space-governance';

/** Returns control policies only; private dispatch amounts and usage are withheld. */
export default spaceGovernanceRoute({ capability: 'delegation:manage' }, ({ selected, store, now }) => ({
  policies: selected.space.budgetId
    ? store.governance.listCategorizationControls({ spaceId: selected.space.id, actorId: selected.auth.actorId, now }).map(projectCategorizationControl)
    : [],
}));
