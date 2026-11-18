import { createHash } from 'node:crypto';
import { z } from 'zod';
import { decisionExplanationPolicySchema, OpenAIProvider } from '@balanceframe/inference';
import type { DecisionCardExplanationRuntime } from '@balanceframe/application';
import type { LiquidityActor } from '@balanceframe/workflow-store';
import type { H3Event } from 'h3';
import { requireSelectedSpace } from './space-context';
import { requireAuthorization } from './workflow-store';
import type { EventWithContext } from './workflow-store';
import { hasTrustedRequestOrigin, type ReauthenticationEvent } from './reauthentication';

const disabled = {
  mode: 'disabled',
  revision: 'disabled-v1',
  timeoutMs: 5000,
  allowedProviders: [],
};
const providerConfig = z
  .object({
    id: z.string().min(1).max(128),
    endpoint: z.string().url().max(2048),
    model: z.string().min(1).max(128),
    locality: z.enum(['local', 'external']),
  })
  .strict();
// This bounded per-process egress limiter is independent of financial/delegation counters.
const windows = new Map<string, { minute: number; count: number }>();
function admit(scope: string): boolean {
  const minute = Math.floor(Date.now() / 60000);
  for (const [key, window] of windows) if (window.minute !== minute) windows.delete(key);
  const window = windows.get(scope);
  if (window && window.count >= 10) return false;
  if (!window && windows.size >= 1000) return false;
  windows.set(scope, { minute, count: (window?.count ?? 0) + 1 });
  return true;
}
function currentPolicy(): unknown {
  const text = process.env.BALANCEFRAME_CONVERSATION_POLICY;
  try {
    return text ? (JSON.parse(text) as unknown) : disabled;
  } catch {
    return null;
  }
}
function configurationBinding(): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        process.env.BALANCEFRAME_CONVERSATION_POLICY,
        process.env.BALANCEFRAME_CONVERSATION_PROVIDER,
        process.env.BALANCEFRAME_CONVERSATION_API_KEY,
      ]),
    )
    .digest('hex');
}

/** Compose only explicit server-owned conversation configuration; no provider is enabled by default. */
export function createConversationExplanationRuntime(
  event: H3Event,
  actor: LiquidityActor,
): DecisionCardExplanationRuntime {
  if (!event.node.req.headers.origin || !hasTrustedRequestOrigin(event as ReauthenticationEvent))
    throw new Error('Conversation request authorization denied');
  const binding = configurationBinding();
  let provider: OpenAIProvider | undefined;
  try {
    const policy = decisionExplanationPolicySchema.parse(currentPolicy());
    if (
      policy.mode !== 'disabled' &&
      process.env.BALANCEFRAME_CONVERSATION_PROVIDER &&
      process.env.BALANCEFRAME_CONVERSATION_API_KEY
    ) {
      const config = providerConfig.parse(
        JSON.parse(process.env.BALANCEFRAME_CONVERSATION_PROVIDER),
      );
      provider = new OpenAIProvider({
        ...config,
        providerId: config.id,
        apiKey: process.env.BALANCEFRAME_CONVERSATION_API_KEY,
      });
    }
  } catch {
    /* Invalid optional configuration retains deterministic purchase evaluation. */
  }
  const originalAuth = actor.auth;
  return {
    provider,
    policy: currentPolicy,
    admit: () =>
      admit(
        createHash('sha256')
          .update(JSON.stringify([actor.spaceId, actor.budgetId, actor.actorId]))
          .digest('hex'),
      ),
    authorize: async () => {
      if (configurationBinding() !== binding) throw new Error('Conversation configuration changed');
      const selected = requireSelectedSpace(event as unknown as EventWithContext);
      if (
        !selected.ok ||
        selected.auth.actorId !== actor.actorId ||
        selected.space.id !== actor.spaceId ||
        selected.space.budgetId !== actor.budgetId ||
        selected.membership.id !== actor.membershipId ||
        JSON.stringify(selected.auth) !== JSON.stringify(originalAuth)
      )
        throw new Error('Conversation authorization changed');
      const authorization = await requireAuthorization(
        event as unknown as EventWithContext,
        'affordability:evaluate',
        `budget:${actor.budgetId}`,
      );
      if (!authorization.ok) throw new Error('Conversation authorization denied');
    },
  };
}
