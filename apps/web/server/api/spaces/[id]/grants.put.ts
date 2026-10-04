import { z } from 'zod';
import { readGovernanceBody, Restrictions, ResourceId, ResourceKind, Capability, spaceGovernanceRoute } from '../../../utils/space-governance';

const SetGrantBody = z.object({
  membershipId: z.string().min(1).max(256),
  capability: Capability,
  resourceKind: ResourceKind,
  resourceId: ResourceId,
  granted: z.boolean(),
  restrictions: Restrictions.optional(),
}).strict();

/** Grants or revokes one exact membership/resource/capability tuple. */
export default spaceGovernanceRoute({ capability: 'grant:manage', freshProof: true }, async ({ event, selected, store, proof, now }) => {
  const body = await readGovernanceBody(event, SetGrantBody);
  const member = store.governance.listMembershipHistory({ spaceId: selected.space.id })
    .find((membership) => membership.id === body.membershipId);
  if (!member) throw new Error('Grant membership unavailable');
  const grant = store.governance.setResourceGrant({
    spaceId: selected.space.id,
    actorId: member.actorId,
    membershipId: member.id,
    capability: body.capability,
    resourceKind: body.resourceKind,
    resourceId: body.resourceId,
    granted: body.granted,
    ...(body.restrictions === undefined ? {} : { restrictions: body.restrictions }),
    now,
    auth: proof!,
  });
  return { grant };
});
