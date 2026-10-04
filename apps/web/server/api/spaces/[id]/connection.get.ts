import { spaceGovernanceRoute } from '../../../utils/space-governance';

/** Reveals only whether the selected space has a bound budget to connection managers. */
export default spaceGovernanceRoute({ capability: 'connection:manage' }, ({ selected }) => ({
  budgetBound: selected.space.budgetId !== null,
}));
