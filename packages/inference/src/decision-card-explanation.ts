import { z } from 'zod';
import type { OpenAIProvider } from './providers/openai.js';

export const DECISION_EXPLANATION_PROMPT = 'decision-card-explanation-v1';
const token = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._:/-]+$/);
/** Only opaque references and canonical codes reach the explanation provider. */
export const decisionExplanationFactsSchema = z
  .array(
    z
      .object({
        id: z.string().regex(/^f\d{1,3}$/),
        kind: z.enum([
          'outcome',
          'budget_funding',
          'payment_liquidity',
          'blocker',
          'reason',
          'category_before',
          'category_after',
        ]),
        code: z
          .string()
          .regex(/^[a-z][a-z0-9_]{0,95}$/)
          .optional(),
      })
      .strict(),
  )
  .min(1)
  .max(64)
  .refine((facts) => new Set(facts.map((fact) => fact.id)).size === facts.length);
export type DecisionExplanationFacts = z.infer<typeof decisionExplanationFactsSchema>;
/** Conversation permission is independent of classification and research policy. */
export const decisionExplanationPolicySchema = z
  .object({
    mode: z.enum(['disabled', 'local_only', 'external_allowed']),
    revision: token,
    timeoutMs: z.number().int().min(1).max(30000),
    allowedProviders: z
      .array(
        z
          .object({
            id: token,
            model: token,
            endpoint: z.string().url().max(2048),
            promptVersion: z.literal(DECISION_EXPLANATION_PROMPT),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
/** A provider selects existing facts; it cannot supply prose, money, outcomes or actions. */
export const decisionExplanationSelectionSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('explained'),
      factIds: z
        .array(z.string().regex(/^f\d{1,3}$/))
        .min(1)
        .max(8),
    })
    .strict(),
  z.object({ status: z.literal('refused'), factIds: z.array(z.string()).max(0) }).strict(),
]);
export type DecisionExplanationOutcome =
  | {
      status: 'explained';
      factIds: string[];
      provenance: {
        provider: string;
        model: string;
        promptVersion: string;
        policyRevision: string;
      };
    }
  | {
      status: 'manual';
      code:
        | 'disabled'
        | 'unavailable'
        | 'invalid_response'
        | 'refused'
        | 'changed'
        | 'timeout'
        | 'rate_limited';
    };
export type DecisionExplanationProvider = Pick<
  OpenAIProvider,
  'providerInfo' | 'explainDecisionCard'
>;

/** Bound provider work and discard results after any authority/source/policy change. */
export async function runDecisionCardExplanation(
  provider: DecisionExplanationProvider | undefined,
  facts: unknown,
  getPolicy: () => unknown,
  revalidate: () => void | Promise<void>,
  admit?: () => boolean,
): Promise<DecisionExplanationOutcome> {
  let policy;
  try {
    policy = decisionExplanationPolicySchema.safeParse(getPolicy());
  } catch {
    return { status: 'manual', code: 'unavailable' };
  }
  if (!policy.success) return { status: 'manual', code: 'unavailable' };
  if (policy.data.mode === 'disabled') return { status: 'manual', code: 'disabled' };
  if (!provider) return { status: 'manual', code: 'unavailable' };
  const info = provider.providerInfo;
  if (
    (policy.data.mode === 'local_only' && info.locality !== 'local') ||
    !policy.data.allowedProviders.some(
      (allowed) =>
        allowed.id === info.id &&
        allowed.model === info.model &&
        allowed.endpoint === info.endpoint &&
        allowed.promptVersion === DECISION_EXPLANATION_PROMPT,
    )
  )
    return { status: 'manual', code: 'disabled' };
  const input = decisionExplanationFactsSchema.safeParse(facts);
  if (!input.success) return { status: 'manual', code: 'unavailable' };
  const originalPolicy = JSON.stringify(policy.data);
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let changed = false;
  const guard = async () => {
    try {
      await revalidate();
      if (
        abort.signal.aborted ||
        JSON.stringify(decisionExplanationPolicySchema.parse(getPolicy())) !== originalPolicy
      )
        throw new Error('Changed explanation context');
    } catch {
      changed = true;
      throw new Error('Changed explanation context');
    }
  };
  try {
    return await Promise.race([
      (async (): Promise<DecisionExplanationOutcome> => {
        await guard();
        if (admit && !admit()) return { status: 'manual', code: 'rate_limited' };
        const value = await provider.explainDecisionCard(input.data, abort.signal);
        await guard();
        const parsed = decisionExplanationSelectionSchema.safeParse(value);
        if (
          !parsed.success ||
          (parsed.data.status === 'explained' &&
            (new Set(parsed.data.factIds).size !== parsed.data.factIds.length ||
              parsed.data.factIds.some((id) => !input.data.some((fact) => fact.id === id))))
        )
          return { status: 'manual', code: 'invalid_response' };
        if (parsed.data.status === 'refused') return { status: 'manual', code: 'refused' };
        return {
          ...parsed.data,
          provenance: {
            provider: info.id,
            model: info.model!,
            promptVersion: DECISION_EXPLANATION_PROMPT,
            policyRevision: policy.data.revision,
          },
        };
      })(),
      new Promise<DecisionExplanationOutcome>((resolve) => {
        timer = setTimeout(() => {
          abort.abort();
          resolve({ status: 'manual', code: 'timeout' });
        }, policy.data.timeoutMs);
      }),
    ]);
  } catch {
    return {
      status: 'manual',
      code: abort.signal.aborted ? 'timeout' : changed ? 'changed' : 'invalid_response',
    };
  } finally {
    if (timer) clearTimeout(timer);
    abort.abort();
  }
}
