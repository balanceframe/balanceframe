import { z } from 'zod';
import { readGovernanceBody, spaceGovernanceRoute, IsoTime } from '../../../../utils/space-governance';

const AddMembershipBody = z.object({
  actorId: z.string().min(1).max(256),
  validFrom: IsoTime,
  validUntil: IsoTime.optional(),
}).strict();

/** Appends a non-overlapping member period without inheriting grants. */
export default spaceGovernanceRoute({ capability: 'identity:manage', freshProof: true }, async ({ event, selected, store, proof, now }) => {
  const body = await readGovernanceBody(event, AddMembershipBody);
  const membership = store.governance.addMembership({
    spaceId: selected.space.id,
    actorId: body.actorId,
    validFrom: body.validFrom,
    ...(body.validUntil === undefined ? {} : { validUntil: body.validUntil }),
    now,
    auth: proof!,
  });
  return { membership };
});
