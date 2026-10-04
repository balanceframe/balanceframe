import { z } from 'zod';
import { readGovernanceBody, Restrictions, ResourceId, ResourceKind, Capability, IsoTime, spaceGovernanceRoute } from '../../../utils/space-governance';

const Right = z.object({
  capability: Capability,
  resourceKind: ResourceKind,
  resourceId: ResourceId,
  restrictions: Restrictions.optional(),
}).strict();
const DelegateBody = z.object({
  agentId: z.string().min(1).max(256),
  issuerMembershipId: z.string().min(1).max(256),
  expectedVersion: z.string().regex(/^[1-9]\d*$/).nullable(),
  rights: z.array(Right).min(1),
  validFrom: IsoTime,
  validUntil: IsoTime.optional(),
}).strict();

/** Issues one versioned delegation bounded by the issuer’s selected-space grants. */
export default spaceGovernanceRoute({ capability: 'delegation:manage', freshProof: true }, async ({ event, selected, store, proof, now }) => {
  const body = await readGovernanceBody(event, DelegateBody);
  const delegation = store.governance.delegate({
    spaceId: selected.space.id,
    agentId: body.agentId,
    issuerMembershipId: body.issuerMembershipId,
    expectedVersion: body.expectedVersion,
    rights: body.rights,
    validFrom: body.validFrom,
    ...(body.validUntil === undefined ? {} : { validUntil: body.validUntil }),
    now,
    auth: proof!,
  });
  return { delegation };
});
