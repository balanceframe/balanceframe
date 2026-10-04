import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import { auth } from '../../../../lib/auth';
import { readGovernanceBody, spaceGovernanceRoute } from '../../../utils/space-governance';

const RegisterCredentialBody = z.object({
  credentialId: z.string().min(1).max(256),
  principalType: z.enum(['human', 'agent']),
  principalId: z.string().min(1).max(256),
  delegationId: z.string().min(1).max(256).optional(),
  expectedDelegationVersion: z.string().regex(/^[1-9]\d*$/).optional(),
}).strict();
const OwnedApiKey = z.object({
  id: z.string(),
  referenceId: z.string(),
  enabled: z.boolean(),
  expiresAt: z.coerce.date().nullable(),
}).passthrough();
const ApiKeyList = z.object({ apiKeys: z.array(OwnedApiKey) });

/** Binds an API key only after checking its current Better Auth owner on the server. */
export default spaceGovernanceRoute({ capability: 'credential:manage', freshProof: true }, async ({ event, selected, store, proof, now }) => {
  const body = await readGovernanceBody(event, RegisterCredentialBody);
  if (!proof) throw new Error('Human proof unavailable');
  const listed = ApiKeyList.parse(await auth.api.listApiKeys({
    query: {},
    headers: fromNodeHeaders(event.node.req.headers),
  }));
  const credential = listed.apiKeys.find((key) =>
    key.id === body.credentialId && key.referenceId === proof.actorId && key.enabled &&
    (key.expiresAt === null || key.expiresAt.getTime() > new Date(now).getTime()));
  if (!credential) throw new Error('Credential unavailable');

  const binding = store.governance.registerCredentialBinding({
    spaceId: selected.space.id,
    credentialId: credential.id,
    credentialOwnerId: proof.actorId,
    principalType: body.principalType,
    principalId: body.principalId,
    ...(body.delegationId === undefined ? {} : { delegationId: body.delegationId }),
    ...(body.expectedDelegationVersion === undefined ? {} : { expectedDelegationVersion: body.expectedDelegationVersion }),
    now,
    auth: proof,
  });
  return { credential: binding };
});
