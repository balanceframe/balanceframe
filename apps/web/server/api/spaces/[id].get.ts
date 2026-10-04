import { spaceGovernanceRoute } from '../../utils/space-governance';

/** Returns only non-financial metadata for the selected current membership. */
export default spaceGovernanceRoute({}, ({ selected }) => ({
  space: {
    id: selected.space.id,
    name: selected.space.name,
    kind: selected.space.kind,
    createdAt: selected.space.createdAt,
    membership: {
      id: selected.membership.id,
      actorId: selected.membership.actorId,
      validFrom: selected.membership.validFrom,
      validUntil: selected.membership.validUntil,
      revokedAt: selected.membership.revokedAt,
      origin: selected.membership.origin,
    },
  },
}));
