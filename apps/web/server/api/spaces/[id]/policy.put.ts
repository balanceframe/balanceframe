import { z } from 'zod';
import { readGovernanceBody, spaceGovernanceRoute } from '../../../utils/space-governance';

const Policy = z.object({
  minimumApprovers: z.number().int().positive().optional(),
  approvalThresholds: z.array(z.object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    amountMinorUnits: z.string().regex(/^\d+$/),
    requiredApprovers: z.number().int().positive(),
  }).strict()).optional(),
  operationApprovers: z.record(z.string().min(1).max(128), z.number().int().positive()).optional(),
}).strict();
const SetPolicyBody = z.object({
  expectedVersion: z.string().regex(/^[1-9]\d*$/).nullable(),
  policy: Policy,
}).strict();

/** Appends a new governance policy only when the expected version remains current. */
export default spaceGovernanceRoute({ capability: 'policy:manage', freshProof: true }, async ({ event, selected, store, proof, now }) => {
  const body = await readGovernanceBody(event, SetPolicyBody);
  const policy = store.governance.setPolicy({
    spaceId: selected.space.id,
    expectedVersion: body.expectedVersion,
    policy: body.policy,
    now,
    auth: proof!,
  });
  return { policy };
});
